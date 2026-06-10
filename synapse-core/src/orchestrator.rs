//! The Director's coordination engine. Spawns the team, assigns claimable tasks
//! to free writer agents (claiming file-ownership locks), pumps agent events,
//! routes finished work to the auditor gate, and drives everything to completion.
//!
//! Provider-agnostic: it talks to agents only through the [`AgentRunner`] trait,
//! so the same logic runs against the mock runner (tests) or the real Claude CLI.

use crate::budget::Budget;
use crate::locks::LockTable;
use crate::mailbox::Mailbox;
use crate::planner::Planner;
use crate::redactor::{redact_string, RedactorConfig};
use crate::roles::{Isolation, PermissionMode, Role, RoleLibrary};
use crate::runner::{AgentEvent, AgentHandle, AgentRunner, SpawnSpec};
use crate::team::Team;
use crate::types::{
    Agent, AgentStatus, LockMode, Message, MessageKind, ReviewRequest, ReviewVerdict, Task,
    TaskStatus,
};
use crate::util::{new_id, now_ms, slug};
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone)]
pub struct OrchestratorConfig {
    pub workspace_root: PathBuf,
    /// Team default model (roles may override).
    pub model_default: Option<String>,
    /// Gate completion behind an auditor/reviewer agent.
    pub require_review: bool,
    /// When true (and the team has a reviewer), a task is NOT complete until
    /// review approves: the reviewer's issues are routed back to the original
    /// author to fix, then re-reviewed (up to `MAX_REVIEW_ROUNDS`). When false,
    /// review is advisory and runs off the critical path.
    pub review_blocking: bool,
    /// Honor role isolation by creating git worktrees per writer agent.
    pub use_worktrees: bool,
    /// Permission mode applied to writer (non-read-only) agents at spawn. None =
    /// keep each role's own mode. Used to grant real agents `AcceptEdits`.
    pub agent_permission: Option<PermissionMode>,
    /// Tool allowlist applied to writer agents at spawn, replacing the role's
    /// own tools. None = keep the role's tools. Used for the safe build allowlist.
    pub writer_tools_override: Option<Vec<String>>,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        OrchestratorConfig {
            workspace_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            model_default: None,
            require_review: true,
            review_blocking: false,
            use_worktrees: false,
            agent_permission: None,
            writer_tools_override: None,
        }
    }
}

/// A point-in-time summary for the UI / CLI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub agents: Vec<Agent>,
    pub tasks: Vec<Task>,
    pub reviews: Vec<ReviewRequest>,
    pub message_count: usize,
    pub ticks: u32,
    pub converged: bool,
}

/// Max times a rejected task is sent back to its author before we merge anyway.
const MAX_REVIEW_ROUNDS: u32 = 2;

/// A finished task waiting for a reviewer to free up.
struct PendingReview {
    task_id: String,
    author: String,
    branch: String,
    subject: String,
}

/// Pull the first {...} JSON object out of a model reply (may be wrapped in prose).
fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    if end > start {
        Some(&s[start..=end])
    } else {
        None
    }
}

/// Interpret a reviewer's reply as a verdict + issue list. Defaults to Approved
/// when no structured verdict is present (e.g. the mock runner), so the harness
/// keeps moving without a real reviewer.
fn parse_review_verdict(text: &str) -> (ReviewVerdict, Vec<String>) {
    if let Some(js) = extract_json_object(text) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(js) {
            let verdict = v.get("verdict").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
            let issues: Vec<String> = v
                .get("issues")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            if verdict.contains("approve") {
                return (ReviewVerdict::Approved, Vec::new());
            }
            if verdict.contains("change")
                || verdict.contains("reject")
                || verdict.contains("request")
                || verdict.contains("fail")
            {
                return (ReviewVerdict::Rejected, issues);
            }
        }
    }
    (ReviewVerdict::Approved, Vec::new())
}

pub struct Orchestrator {
    cfg: OrchestratorConfig,
    lib: RoleLibrary,
    team: Team,
    runner: Box<dyn AgentRunner>,
    redactor: RedactorConfig,

    spawned: bool,
    agents: Vec<Agent>,
    handles: HashMap<String, Box<dyn AgentHandle>>,
    tasks: Vec<Task>,
    messages: Vec<Message>,
    errors: Vec<String>,

    mailbox: Mailbox,
    locks: LockTable,
    budget: Budget,

    reviews: Vec<ReviewRequest>,
    review_to_task: HashMap<String, String>,
    agent_active_review: HashMap<String, String>,
    /// Finished tasks awaiting a free reviewer.
    review_queue: Vec<PendingReview>,
    /// review id → the task's human subject (for prompts/narration).
    review_subject: HashMap<String, String>,
    /// task id → how many times it's been rejected and sent back.
    task_review_rounds: HashMap<String, u32>,
    /// task id → the agent a rework should go back to (the original author).
    task_pref_assignee: HashMap<String, String>,
    /// task id → reviewer's issues to hand the author on the next assignment.
    task_rework: HashMap<String, String>,
}

impl Orchestrator {
    pub fn new(
        cfg: OrchestratorConfig,
        lib: RoleLibrary,
        team: Team,
        runner: Box<dyn AgentRunner>,
    ) -> Result<Self> {
        let unknown = team.validate(&lib);
        if !unknown.is_empty() {
            return Err(anyhow!("team references unknown roles: {:?}", unknown));
        }
        Ok(Orchestrator {
            cfg,
            lib,
            team,
            runner,
            redactor: RedactorConfig::builtin_default(),
            spawned: false,
            agents: Vec::new(),
            handles: HashMap::new(),
            tasks: Vec::new(),
            messages: Vec::new(),
            errors: Vec::new(),
            mailbox: Mailbox::new(),
            locks: LockTable::new(),
            budget: Budget::default(),
            reviews: Vec::new(),
            review_to_task: HashMap::new(),
            agent_active_review: HashMap::new(),
            review_queue: Vec::new(),
            review_subject: HashMap::new(),
            task_review_rounds: HashMap::new(),
            task_pref_assignee: HashMap::new(),
            task_rework: HashMap::new(),
        })
    }

    // ── lookups ──
    fn agent(&self, name: &str) -> &Agent {
        self.agents.iter().find(|a| a.name == name).expect("agent exists")
    }
    fn agent_mut(&mut self, name: &str) -> &mut Agent {
        self.agents.iter_mut().find(|a| a.name == name).expect("agent exists")
    }
    fn role_of(&self, name: &str) -> Option<&Role> {
        let rid = &self.agent(name).role_id;
        self.lib.get(rid)
    }
    fn is_reviewer(&self, name: &str) -> bool {
        self.role_of(name).map(|r| r.read_only).unwrap_or(false)
    }
    fn has_reviewer(&self) -> bool {
        self.agents
            .iter()
            .any(|a| self.lib.get(&a.role_id).map(|r| r.read_only).unwrap_or(false))
    }
    fn is_writer(&self, name: &str) -> bool {
        let rid = self.agent(name).role_id.as_str();
        rid != "director" && self.role_of(name).map(|r| !r.read_only).unwrap_or(true)
    }

    // ── spawning ──
    pub fn spawn_team(&mut self) -> Result<()> {
        if self.spawned {
            return Ok(());
        }
        let slots = self.team.expand();
        for slot in slots {
            let mut role = self
                .lib
                .get(&slot.role_id)
                .ok_or_else(|| anyhow!("unknown role {}", slot.role_id))?
                .clone();
            // Apply real-run overrides to writer agents (reviewers keep their
            // read-only, plan-mode posture).
            if !role.read_only {
                if let Some(perm) = self.cfg.agent_permission {
                    role.permission_mode = perm;
                }
                if let Some(tools) = &self.cfg.writer_tools_override {
                    role.tools = tools.clone();
                }
            }
            let session_id = new_id();

            // Determine cwd + branch based on isolation.
            let (cwd, branch) = if self.cfg.use_worktrees && role.isolation == Isolation::Worktree {
                let wm = crate::worktree::WorktreeManager::new(self.cfg.workspace_root.clone());
                let branch = format!("agent/{}", slug(&slot.name));
                let wt_path = self
                    .cfg
                    .workspace_root
                    .join(".synapse")
                    .join("worktrees")
                    .join(slug(&slot.name));
                std::fs::create_dir_all(wt_path.parent().unwrap()).ok();
                match wm.add(&branch, &wt_path, None) {
                    Ok(p) => {
                        info!(target: "synapse::worktree", agent = %slot.name, branch = %branch, path = %p.display(), "created worktree");
                        (p, Some(branch))
                    }
                    Err(e) => {
                        error!(target: "synapse::worktree", agent = %slot.name, branch = %branch, error = %e, "worktree creation failed; falling back to shared root");
                        self.errors.push(format!("worktree for {} failed: {e}", slot.name));
                        (self.cfg.workspace_root.clone(), None)
                    }
                }
            } else {
                (self.cfg.workspace_root.clone(), None)
            };

            let spec = SpawnSpec {
                session_id: session_id.clone(),
                name: slot.name.clone(),
                role: role.clone(),
                cwd: cwd.clone(),
                model_default: self.cfg.model_default.clone(),
            };
            let handle = self.runner.spawn(spec)?;
            info!(
                target: "synapse::orchestrator",
                agent = %slot.name,
                role = %slot.role_id,
                session = %session_id,
                cwd = %cwd.display(),
                "spawned agent"
            );
            self.handles.insert(slot.name.clone(), handle);
            self.agents.push(Agent {
                id: slot.name.clone(),
                session_id,
                role_id: slot.role_id.clone(),
                name: slot.name.clone(),
                status: AgentStatus::Idle,
                branch,
                cwd: cwd.to_string_lossy().to_string(),
                owned_files: Vec::new(),
                current_task: None,
                created_at: now_ms(),
            });
        }
        self.spawned = true;
        self.drain_events();
        info!(target: "synapse::orchestrator", team = %self.team.name, agents = self.agents.len(), "team spawned");
        let names: Vec<String> = self.agents.iter().map(|a| a.name.clone()).collect();
        self.director_say(&format!(
            "Team is on the bench ({}): {}. I'll assign work and keep you posted.",
            names.len(),
            names.join(", ")
        ));
        Ok(())
    }

    // ── planning / tasks ──
    pub fn plan(&mut self, brief: &str, planner: &dyn Planner) {
        self.tasks = planner.plan(brief, &self.team, &self.lib);
        info!(
            target: "synapse::orchestrator",
            brief_len = brief.len(),
            tasks = self.tasks.len(),
            "planned brief into tasks"
        );
        for t in &self.tasks {
            debug!(target: "synapse::planner", task = %t.id, subject = %t.subject, role_hint = ?t.role_hint, deps = ?t.deps, files = ?t.files, "task");
        }
        // Director reports the plan back to the user.
        let mut summary = format!("Here's my plan — {} task(s) for the team:", self.tasks.len());
        for t in &self.tasks {
            summary.push_str(&format!("\n  • {}", t.subject));
        }
        self.director_say(&summary);
    }
    pub fn set_tasks(&mut self, tasks: Vec<Task>) {
        self.tasks = tasks;
    }

    // ── event pump ──
    fn drain_events(&mut self) {
        let names: Vec<String> = self.handles.keys().cloned().collect();
        for name in names {
            loop {
                let ev = self.handles.get(&name).and_then(|h| h.try_event());
                let Some(ev) = ev else { break };
                match ev {
                    AgentEvent::Message(mut m) => {
                        if m.agent_id.is_none() {
                            m.agent_id = Some(name.clone());
                        }
                        let preview: String = m.text.chars().take(200).collect();
                        debug!(
                            target: "synapse::agent",
                            agent = %name,
                            kind = m.kind.as_str(),
                            tool = m.tool_name.as_deref().unwrap_or(""),
                            is_error = m.is_error,
                            "message: {}", preview
                        );
                        self.messages.push(m);
                    }
                    AgentEvent::Status(s) => self.on_status(&name, s),
                    AgentEvent::Spawned { session_id } => {
                        debug!(target: "synapse::agent", agent = %name, session = %session_id, "spawned event");
                    }
                    AgentEvent::Exited(code) => {
                        info!(target: "synapse::agent", agent = %name, code, "agent process exited");
                    }
                    AgentEvent::Error(e) => {
                        error!(target: "synapse::agent", agent = %name, "runner error: {}", e);
                        self.errors.push(e);
                    }
                }
            }
        }
    }

    fn on_status(&mut self, name: &str, s: AgentStatus) {
        debug!(target: "synapse::agent", agent = %name, status = ?s, "status");
        self.agent_mut(name).status = s;
        if s == AgentStatus::Done {
            if self.is_reviewer(name) && self.agent_active_review.contains_key(name) {
                self.resolve_review(name);
            } else if self.agent(name).current_task.is_some() {
                self.finish_writer_task(name);
            }
        }
    }

    fn finish_writer_task(&mut self, name: &str) {
        let task_id = match self.agent(name).current_task.clone() {
            Some(t) => t,
            None => return,
        };
        let branch = self.agent(name).branch.clone();
        info!(target: "synapse::orchestrator", agent = %name, task = %task_id, "writer finished task");

        // Release this agent's file locks.
        self.locks.release_all(name);
        self.agent_mut(name).owned_files.clear();

        let subject = self
            .tasks
            .iter()
            .find(|t| t.id == task_id)
            .map(|t| t.subject.clone())
            .unwrap_or_default();

        let blocking = self.cfg.review_blocking && self.has_reviewer();
        if self.cfg.require_review && self.has_reviewer() {
            // Queue a review. Blocking → the task waits in review before it counts
            // as done; advisory → complete now and review off the critical path.
            let status = if blocking { TaskStatus::InReview } else { TaskStatus::Completed };
            if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                t.status = status;
            }
            if blocking {
                self.director_say(&format!("🔎 Submitted \u{201c}{subject}\u{201d} for review."));
            } else {
                info!(target: "synapse::orchestrator", task = %task_id, "task completed (advisory review)");
                self.director_say(&format!("✓ Done: {subject}"));
            }
            self.review_queue.push(PendingReview {
                task_id: task_id.clone(),
                author: name.to_string(),
                branch: branch.unwrap_or_else(|| name.to_string()),
                subject,
            });
        } else {
            // No review configured (or no reviewer on the team): complete now.
            if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                t.status = TaskStatus::Completed;
            }
            info!(target: "synapse::orchestrator", task = %task_id, "task completed");
            self.director_say(&format!("✓ Done: {subject}"));
        }

        // Writer is now free to pick up the next task.
        let a = self.agent_mut(name);
        a.current_task = None;
        a.status = AgentStatus::Done;
    }

    /// Dispatch queued reviews to any free reviewers (one task each).
    fn dispatch_reviews(&mut self) {
        loop {
            if self.review_queue.is_empty() {
                break;
            }
            let reviewer = match self.free_reviewers().first().cloned() {
                Some(r) => r,
                None => break,
            };
            let pr = self.review_queue.remove(0);
            let review = ReviewRequest {
                id: new_id(),
                branch: pr.branch.clone(),
                requested_by: pr.author.clone(),
                reviewer: Some(reviewer.clone()),
                verdict: ReviewVerdict::Pending,
                notes: String::new(),
                created_at: now_ms(),
            };
            let review_id = review.id.clone();
            self.reviews.push(review);
            self.review_to_task.insert(review_id.clone(), pr.task_id.clone());
            self.review_subject.insert(review_id.clone(), pr.subject.clone());
            self.agent_active_review.insert(reviewer.clone(), review_id.clone());
            {
                let a = self.agent_mut(&reviewer);
                a.status = AgentStatus::Working;
                a.current_task = Some(review_id);
            }
            let prompt = format!(
                "You are reviewing freshly written code for this task: {}. Inspect the relevant \
files in the workspace. Respond with ONLY a JSON object (no prose, no markdown fences): \
{{\"verdict\": \"approved\" or \"changes_requested\", \"issues\": [\"specific, actionable issue\"]}}. \
Use \"approved\" only if the code is correct, secure, and consistent; otherwise list concrete \
issues the author must fix.",
                pr.subject
            );
            info!(target: "synapse::review", task = %pr.task_id, reviewer = %reviewer, "dispatched review");
            self.director_say(&format!("🔎 {reviewer} is reviewing \u{201c}{}\u{201d}\u{2026}", pr.subject));
            if let Some(h) = self.handles.get(&reviewer) {
                let _ = h.send(&prompt);
            }
        }
    }

    fn resolve_review(&mut self, reviewer: &str) {
        let review_id = match self.agent_active_review.remove(reviewer) {
            Some(r) => r,
            None => return,
        };
        let task_id = self.review_to_task.remove(&review_id);
        let subject = self.review_subject.remove(&review_id).unwrap_or_default();
        let author = self
            .reviews
            .iter()
            .find(|r| r.id == review_id)
            .map(|r| r.requested_by.clone())
            .unwrap_or_default();

        // Parse the reviewer's actual verdict + issues from its final message.
        let text = self.reviewer_last_text(reviewer);
        let (verdict, issues) = parse_review_verdict(&text);
        if let Some(r) = self.reviews.iter_mut().find(|r| r.id == review_id) {
            r.verdict = verdict;
            r.notes = issues.join("\n");
        }

        // Reviewer is free for the next review.
        {
            let a = self.agent_mut(reviewer);
            a.current_task = None;
            a.status = AgentStatus::Done;
        }

        let task_id = match task_id {
            Some(t) => t,
            None => return,
        };
        let blocking = self.cfg.review_blocking && self.has_reviewer();

        match verdict {
            ReviewVerdict::Approved => {
                if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                    t.status = TaskStatus::Completed;
                }
                self.task_pref_assignee.remove(&task_id);
                self.task_rework.remove(&task_id);
                info!(target: "synapse::review", reviewer = %reviewer, task = %task_id, verdict = "approved", "review approved");
                self.director_say(&format!("✅ {reviewer} approved \u{201c}{subject}\u{201d}."));
            }
            ReviewVerdict::Rejected => {
                let round = {
                    let c = self.task_review_rounds.entry(task_id.clone()).or_insert(0);
                    *c += 1;
                    *c
                };
                let list = if issues.is_empty() {
                    "(no specifics given)".to_string()
                } else {
                    issues.iter().map(|i| format!("  • {i}")).collect::<Vec<_>>().join("\n")
                };
                if blocking && round <= MAX_REVIEW_ROUNDS {
                    // Send it back to the original author to fix, then re-review.
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                        t.status = TaskStatus::Pending;
                        t.assignee = None;
                    }
                    self.task_pref_assignee.insert(task_id.clone(), author.clone());
                    self.task_rework.insert(task_id.clone(), issues.join("\n"));
                    info!(target: "synapse::review", reviewer = %reviewer, task = %task_id, author = %author, round, issues = issues.len(), "changes requested; routing back to author");
                    self.director_say(&format!(
                        "🔧 {reviewer} requested changes on \u{201c}{subject}\u{201d} (round {round}) — back to {author} to fix:\n{list}"
                    ));
                } else {
                    // Advisory, or out of rounds: surface the issues but merge.
                    if let Some(t) = self.tasks.iter_mut().find(|t| t.id == task_id) {
                        t.status = TaskStatus::Completed;
                    }
                    self.task_pref_assignee.remove(&task_id);
                    self.task_rework.remove(&task_id);
                    if blocking {
                        warn!(target: "synapse::review", task = %task_id, round, "review concerns remain after max rounds; merging");
                        self.director_say(&format!(
                            "⚠ \u{201c}{subject}\u{201d} still has concerns after {round} round(s); merging anyway:\n{list}"
                        ));
                    } else {
                        info!(target: "synapse::review", task = %task_id, "advisory review noted issues");
                        self.director_say(&format!(
                            "📝 {reviewer} noted on \u{201c}{subject}\u{201d} (advisory):\n{list}"
                        ));
                    }
                }
            }
            ReviewVerdict::Pending => {}
        }
    }

    /// The reviewer's most recent textual reply (where its verdict JSON lives).
    fn reviewer_last_text(&self, reviewer: &str) -> String {
        self.messages
            .iter()
            .rev()
            .find(|m| {
                m.agent_id.as_deref() == Some(reviewer)
                    && matches!(m.kind, MessageKind::Message | MessageKind::Question | MessageKind::Plan)
            })
            .map(|m| m.text.clone())
            .unwrap_or_default()
    }

    fn free_reviewers(&self) -> Vec<String> {
        self.agents
            .iter()
            .filter(|a| {
                self.lib.get(&a.role_id).map(|r| r.read_only).unwrap_or(false)
                    && !self.agent_active_review.contains_key(&a.name)
                    && matches!(a.status, AgentStatus::Idle | AgentStatus::Done)
            })
            .map(|a| a.name.clone())
            .collect()
    }

    // ── assignment ──
    fn assign_tasks(&mut self) -> Result<()> {
        let completed: Vec<String> = self
            .tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Completed)
            .map(|t| t.id.clone())
            .collect();

        // Rework tasks are reserved for their original author; drop reservations
        // whose agent has died so the task isn't stranded.
        let dead: std::collections::HashSet<String> = self
            .agents
            .iter()
            .filter(|a| matches!(a.status, AgentStatus::Errored | AgentStatus::Stopped))
            .map(|a| a.name.clone())
            .collect();
        let pref: HashMap<String, String> = self
            .task_pref_assignee
            .iter()
            .filter(|(_, who)| !dead.contains(*who))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        let free_writers: Vec<String> = self
            .agents
            .iter()
            .filter(|a| {
                self.is_writer(&a.name)
                    && a.current_task.is_none()
                    && matches!(a.status, AgentStatus::Idle | AgentStatus::Done)
            })
            .map(|a| a.name.clone())
            .collect();

        for name in free_writers {
            let role_id = self.agent(&name).role_id.clone();
            // 1) a rework task reserved for this agent; 2) a fresh task hinted at
            // this role (not reserved for someone else); 3) any free fresh task.
            let idx = self
                .tasks
                .iter()
                .position(|t| {
                    t.is_claimable(&completed)
                        && t.assignee.is_none()
                        && pref.get(&t.id).map(|w| w == &name).unwrap_or(false)
                })
                .or_else(|| {
                    self.tasks.iter().position(|t| {
                        t.is_claimable(&completed)
                            && t.assignee.is_none()
                            && !pref.contains_key(&t.id)
                            && t.role_hint.as_deref() == Some(role_id.as_str())
                    })
                })
                .or_else(|| {
                    self.tasks.iter().position(|t| {
                        t.is_claimable(&completed) && t.assignee.is_none() && !pref.contains_key(&t.id)
                    })
                });
            let Some(idx) = idx else { continue };
            let task = self.tasks[idx].clone();

            // Claim file-ownership locks for the task's files.
            if !task.files.is_empty() {
                if let Err(e) = self
                    .locks
                    .claim_all(&task.files, &name, LockMode::Write, now_ms())
                {
                    // contended — leave it for later, try a different agent/tick
                    warn!(target: "synapse::locks", agent = %name, task = %task.id, files = ?task.files, "skip assign: file lock contention: {}", e);
                    continue;
                }
                self.agent_mut(&name).owned_files = task.files.clone();
                debug!(target: "synapse::locks", agent = %name, task = %task.id, files = ?task.files, "claimed file locks");
            }

            // Assign.
            self.tasks[idx].status = TaskStatus::InProgress;
            self.tasks[idx].assignee = Some(name.clone());
            {
                let a = self.agent_mut(&name);
                a.current_task = Some(task.id.clone());
                a.status = AgentStatus::Working;
            }
            // If this task is coming back from review, hand the author the issues.
            let rework = self.task_rework.remove(&task.id);
            info!(target: "synapse::orchestrator", agent = %name, role = %role_id, task = %task.id, subject = %task.subject, rework = rework.is_some(), "assigned task");
            self.mailbox.send("director", &name, &format!("assigned: {}", task.subject));
            if rework.is_some() {
                self.director_say(&format!("↩ {} is fixing review issues on: {}", name, task.subject));
            } else {
                self.director_say(&format!("▶ {} is building: {}", name, task.subject));
            }
            let mut prompt = if task.description.is_empty() {
                task.subject.clone()
            } else {
                format!("{}\n\n{}", task.subject, task.description)
            };
            if let Some(issues) = rework {
                prompt.push_str(&format!(
                    "\n\nA reviewer requested changes to your earlier work on this task. \
Fix exactly these issues and nothing else:\n{issues}"
                ));
            }
            if let Some(h) = self.handles.get(&name) {
                h.send(&prompt)?;
            }
        }
        Ok(())
    }

    fn is_done(&self) -> bool {
        let all_done = !self.tasks.is_empty()
            && self.tasks.iter().all(|t| t.status == TaskStatus::Completed);
        let none_working = self.agents.iter().all(|a| a.status != AgentStatus::Working);
        all_done && none_working && self.review_queue.is_empty()
    }

    /// Public convergence check for external event loops (the desktop UI).
    pub fn done(&self) -> bool {
        self.is_done()
    }

    pub fn spawned(&self) -> bool {
        self.spawned
    }

    /// Spawn (if needed), then assign + pump until all tasks complete, an overall
    /// `max_secs` wall-clock deadline is hit, or no progress happens for
    /// `idle_secs` (whichever comes first). Real multi-agent builds take many
    /// minutes, so this is time-based, not a fixed tick budget.
    pub fn run_to_completion(&mut self, max_secs: u64, idle_secs: u64) -> Result<RunSummary> {
        info!(target: "synapse::orchestrator", team = %self.team.name, tasks = self.tasks.len(), require_review = self.cfg.require_review, use_worktrees = self.cfg.use_worktrees, max_secs, idle_secs, "run starting");
        self.spawn_team()?;
        let start = Instant::now();
        let mut last_progress = Instant::now();
        let mut last_fp = (0usize, 0usize);
        let mut ticks = 0u32;
        loop {
            self.drain_events();
            self.assign_tasks()?;
            self.dispatch_reviews();
            self.drain_events();
            ticks += 1;

            if self.is_done() {
                info!(target: "synapse::orchestrator", ticks, messages = self.messages.len(), reviews = self.reviews.len(), elapsed_s = start.elapsed().as_secs(), "run converged");
                return Ok(self.summary(ticks, true));
            }

            // Progress fingerprint: completed-task count + message count. Any
            // change resets the idle clock.
            let completed = self.tasks.iter().filter(|t| t.status == TaskStatus::Completed).count();
            let fp = (completed, self.messages.len());
            if fp != last_fp {
                last_fp = fp;
                last_progress = Instant::now();
            }

            if start.elapsed().as_secs() >= max_secs {
                warn!(target: "synapse::orchestrator", ticks, elapsed_s = start.elapsed().as_secs(), "run did NOT converge (overall deadline reached)");
                return Ok(self.summary(ticks, false));
            }
            if last_progress.elapsed().as_secs() >= idle_secs {
                warn!(target: "synapse::orchestrator", ticks, idle_s = last_progress.elapsed().as_secs(), "run did NOT converge (no progress / idle timeout)");
                return Ok(self.summary(ticks, false));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Advance one tick (used by the UI's event loop).
    pub fn tick(&mut self) -> Result<()> {
        self.drain_events();
        self.assign_tasks()?;
        self.dispatch_reviews();
        self.drain_events();
        Ok(())
    }

    pub fn summary(&self, ticks: u32, converged: bool) -> RunSummary {
        RunSummary {
            agents: self.agents.clone(),
            tasks: self.tasks.clone(),
            reviews: self.reviews.clone(),
            message_count: self.messages.len(),
            ticks,
            converged,
        }
    }

    // ── accessors ──
    pub fn agents(&self) -> &[Agent] {
        &self.agents
    }
    pub fn tasks(&self) -> &[Task] {
        &self.tasks
    }
    pub fn reviews(&self) -> &[ReviewRequest] {
        &self.reviews
    }
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }
    pub fn errors(&self) -> &[String] {
        &self.errors
    }
    pub fn mailbox(&self) -> &Mailbox {
        &self.mailbox
    }
    pub fn locks(&self) -> &LockTable {
        &self.locks
    }
    pub fn budget(&self) -> &Budget {
        &self.budget
    }
    pub fn set_redactor(&mut self, cfg: RedactorConfig) {
        self.redactor = cfg;
    }

    /// The Director speaking to the user. A single point of contact: the user
    /// reads these and never has to address the workers directly.
    fn director_say(&self, body: &str) {
        self.mailbox.send("director", "user", body);
    }

    /// The Director→user conversation, redacted, in order. Drives the chat panel.
    pub fn redacted_director_feed(&self) -> Vec<crate::types::MailboxMessage> {
        self.mailbox
            .all()
            .into_iter()
            .filter(|m| m.from == "director" && m.to == "user")
            .map(|mut m| {
                m.body = redact_string(&m.body, &self.redactor).value;
                m
            })
            .collect()
    }

    /// Messages with every text field redacted — the safe feed for display.
    pub fn redacted_messages(&self) -> Vec<Message> {
        self.messages
            .iter()
            .map(|m| {
                let mut m = m.clone();
                m.text = redact_string(&m.text, &self.redactor).value;
                m
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planner::HeuristicPlanner;
    use crate::roles::RoleLibrary;
    use crate::runner::MockRunner;
    use crate::types::TaskStatus;
    use parking_lot::Mutex;

    fn base_cfg() -> OrchestratorConfig {
        OrchestratorConfig {
            workspace_root: std::env::temp_dir(),
            require_review: false,
            use_worktrees: false,
            ..Default::default()
        }
    }

    #[test]
    fn spawns_the_whole_team() {
        let lib = RoleLibrary::builtin_default();
        let team = Team::new("t").with("backend-dev", 2).with("frontend-dev", 3);
        let mut o = Orchestrator::new(base_cfg(), lib, team, Box::new(MockRunner::new())).unwrap();
        o.spawn_team().unwrap();
        assert_eq!(o.agents().len(), 5);
        assert!(o.agents().iter().all(|a| a.status == AgentStatus::Idle));
    }

    #[test]
    fn runs_a_brief_to_completion() {
        let lib = RoleLibrary::builtin_default();
        let team = Team::new("t").with("backend-dev", 1).with("frontend-dev", 1);
        let mut o = Orchestrator::new(base_cfg(), lib, team, Box::new(MockRunner::new())).unwrap();
        o.plan("- build the API\n- build the UI", &HeuristicPlanner);
        let summary = o.run_to_completion(30, 10).unwrap();
        assert!(summary.converged, "should converge: {:?}", summary.tasks);
        assert!(o.tasks().iter().all(|t| t.status == TaskStatus::Completed));
        // each agent produced at least one assistant message
        assert!(o.messages().iter().filter(|m| m.role == "assistant").count() >= 2);
    }

    #[test]
    fn review_gate_routes_through_reviewer() {
        let lib = RoleLibrary::builtin_default();
        let team = Team::new("t").with("backend-dev", 1).with("code-reviewer", 1);
        let mut cfg = base_cfg();
        cfg.require_review = true;
        let mut o = Orchestrator::new(cfg, lib, team, Box::new(MockRunner::new())).unwrap();
        o.plan("build the API", &HeuristicPlanner);
        let summary = o.run_to_completion(30, 10).unwrap();
        assert!(summary.converged);
        assert!(o.tasks().iter().all(|t| t.status == TaskStatus::Completed));
        // a review was created and approved
        assert_eq!(o.reviews().len(), 1);
        assert_eq!(o.reviews()[0].verdict, ReviewVerdict::Approved);
    }

    #[test]
    fn file_ownership_prevents_double_assignment() {
        let lib = RoleLibrary::builtin_default();
        let team = Team::new("t").with("backend-dev", 2);
        let mut o = Orchestrator::new(base_cfg(), lib, team, Box::new(MockRunner::new())).unwrap();
        // two tasks contend on the same file; locks must serialize them
        let now = now_ms();
        o.set_tasks(vec![
            Task {
                id: "t1".into(),
                subject: "edit shared".into(),
                description: String::new(),
                status: TaskStatus::Pending,
                role_hint: None,
                files: vec!["shared.rs".into()],
                deps: vec![],
                assignee: None,
                created_at: now,
            },
            Task {
                id: "t2".into(),
                subject: "edit shared again".into(),
                description: String::new(),
                status: TaskStatus::Pending,
                role_hint: None,
                files: vec!["shared.rs".into()],
                deps: vec![],
                assignee: None,
                created_at: now,
            },
        ]);
        let summary = o.run_to_completion(30, 10).unwrap();
        assert!(summary.converged, "tasks: {:?}", summary.tasks);
        assert!(o.tasks().iter().all(|t| t.status == TaskStatus::Completed));
    }

    #[test]
    fn dependencies_are_respected() {
        let lib = RoleLibrary::builtin_default();
        let team = Team::new("t").with("backend-dev", 1);
        let mut o = Orchestrator::new(base_cfg(), lib, team, Box::new(MockRunner::new())).unwrap();
        let now = now_ms();
        o.set_tasks(vec![
            Task {
                id: "a".into(),
                subject: "first".into(),
                description: String::new(),
                status: TaskStatus::Pending,
                role_hint: None,
                files: vec![],
                deps: vec![],
                assignee: None,
                created_at: now,
            },
            Task {
                id: "b".into(),
                subject: "second".into(),
                description: String::new(),
                status: TaskStatus::Pending,
                role_hint: None,
                files: vec![],
                deps: vec!["a".into()],
                assignee: None,
                created_at: now,
            },
        ]);
        let summary = o.run_to_completion(30, 10).unwrap();
        assert!(summary.converged);
        assert!(o.tasks().iter().all(|t| t.status == TaskStatus::Completed));
    }

    #[test]
    fn redaction_applies_to_feed() {
        let lib = RoleLibrary::builtin_default();
        let team = Team::new("t").with("backend-dev", 1);
        let mut o = Orchestrator::new(base_cfg(), lib, team, Box::new(MockRunner::new())).unwrap();
        o.plan("email the user at secret@example.com", &HeuristicPlanner);
        o.run_to_completion(30, 10).unwrap();
        let redacted = o.redacted_messages();
        assert!(redacted.iter().any(|m| m.text.contains("<email>")));
        assert!(redacted.iter().all(|m| !m.text.contains("secret@example.com")));
    }

    #[test]
    fn parse_verdict_reads_json() {
        let (v, _) = parse_review_verdict(r#"{"verdict":"approved","issues":[]}"#);
        assert_eq!(v, ReviewVerdict::Approved);
        let (v, issues) = parse_review_verdict(
            r#"prose... {"verdict":"changes_requested","issues":["null check","typo"]} trailing"#,
        );
        assert_eq!(v, ReviewVerdict::Rejected);
        assert_eq!(issues, vec!["null check", "typo"]);
        // No structured verdict (mock runner) defaults to approved.
        assert_eq!(parse_review_verdict("done: build the thing").0, ReviewVerdict::Approved);
    }

    // A runner whose reviewer rejects its FIRST review (with issues) and approves
    // the re-review — to exercise the blocking reviewer→author→fix→re-review loop.
    struct ScriptedRunner;
    struct ScriptedHandle {
        session_id: String,
        name: String,
        is_reviewer: bool,
        review_count: std::sync::atomic::AtomicU32,
        tx: std::sync::mpsc::Sender<crate::runner::AgentEvent>,
        rx: Mutex<std::sync::mpsc::Receiver<crate::runner::AgentEvent>>,
    }
    impl crate::runner::AgentHandle for ScriptedHandle {
        fn session_id(&self) -> &str { &self.session_id }
        fn name(&self) -> &str { &self.name }
        fn send(&self, prompt: &str) -> anyhow::Result<()> {
            use crate::runner::AgentEvent;
            let _ = self.tx.send(AgentEvent::Status(AgentStatus::Working));
            let text = if self.is_reviewer && prompt.contains("\"verdict\"") {
                let n = self.review_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                if n == 1 {
                    r#"{"verdict":"changes_requested","issues":["missing null check"]}"#.to_string()
                } else {
                    r#"{"verdict":"approved","issues":[]}"#.to_string()
                }
            } else {
                format!("done: {prompt}")
            };
            let _ = self.tx.send(AgentEvent::Message(Message {
                id: new_id(),
                role: "assistant".into(),
                kind: MessageKind::Message,
                text,
                tool_name: None,
                tool_category: None,
                tool_use_id: None,
                is_error: false,
                agent_id: Some(self.name.clone()),
                session_id: Some(self.session_id.clone()),
                ts: now_ms(),
                edit_data: None,
            }));
            let _ = self.tx.send(AgentEvent::Status(AgentStatus::Done));
            Ok(())
        }
        fn try_event(&self) -> Option<crate::runner::AgentEvent> { self.rx.lock().try_recv().ok() }
        fn stop(&self) {}
    }
    impl crate::runner::AgentRunner for ScriptedRunner {
        fn spawn(&self, spec: crate::runner::SpawnSpec) -> anyhow::Result<Box<dyn crate::runner::AgentHandle>> {
            use crate::runner::AgentEvent;
            let (tx, rx) = std::sync::mpsc::channel();
            let _ = tx.send(AgentEvent::Spawned { session_id: spec.session_id.clone() });
            let _ = tx.send(AgentEvent::Status(AgentStatus::Idle));
            Ok(Box::new(ScriptedHandle {
                session_id: spec.session_id,
                name: spec.name,
                is_reviewer: spec.role.read_only,
                review_count: std::sync::atomic::AtomicU32::new(0),
                tx,
                rx: Mutex::new(rx),
            }))
        }
    }

    #[test]
    fn blocking_review_routes_rejection_back_to_author_then_approves() {
        let lib = RoleLibrary::builtin_default();
        let team = Team::new("t").with("backend-dev", 1).with("code-reviewer", 1);
        let mut cfg = base_cfg();
        cfg.require_review = true;
        cfg.review_blocking = true;
        let mut o = Orchestrator::new(cfg, lib, team, Box::new(ScriptedRunner)).unwrap();
        o.plan("build the API", &HeuristicPlanner);
        let summary = o.run_to_completion(30, 10).unwrap();

        assert!(summary.converged, "should converge after the fix: {:?}", summary.tasks);
        assert!(o.tasks().iter().all(|t| t.status == TaskStatus::Completed));
        // Two reviews happened: a rejection, then an approval.
        assert_eq!(o.reviews().len(), 2, "expected reject + re-review");
        assert_eq!(o.reviews()[0].verdict, ReviewVerdict::Rejected);
        assert_eq!(o.reviews()[1].verdict, ReviewVerdict::Approved);
    }
}
