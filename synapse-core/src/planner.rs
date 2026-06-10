//! Task planning. The `Planner` trait is the seam where a Director LLM would
//! decompose a brief; the built-in `HeuristicPlanner` does a deterministic split
//! so the engine is fully testable without spending tokens (and serves as the
//! fallback when no LLM planning is configured).

use crate::roles::RoleLibrary;
use crate::runner::claude_oneshot;
use crate::team::Team;
use crate::types::{Task, TaskStatus};
use crate::util::{new_id, now_ms};
use serde::Deserialize;
use std::path::PathBuf;
use tracing::{error, info, warn};

pub trait Planner: Send + Sync {
    fn plan(&self, brief: &str, team: &Team, lib: &RoleLibrary) -> Vec<Task>;
}

/// Writer (non-read-only, non-director) role ids present in a team, deduped.
fn writer_roles(team: &Team, lib: &RoleLibrary) -> Vec<String> {
    let mut seen = Vec::new();
    for m in &team.members {
        if m.role == "director" {
            continue;
        }
        let is_writer = lib.get(&m.role).map(|r| !r.read_only).unwrap_or(true);
        if is_writer && !seen.contains(&m.role) {
            seen.push(m.role.clone());
        }
    }
    seen
}

/// Deterministic planner: each non-empty line of the brief (bullets allowed)
/// becomes one task, round-robined across the team's writer roles for hints.
pub struct HeuristicPlanner;

fn strip_bullet(line: &str) -> &str {
    let t = line.trim();
    for p in ["- ", "* ", "• "] {
        if let Some(rest) = t.strip_prefix(p) {
            return rest.trim();
        }
    }
    // strip "1. " / "2) " style numbering
    if let Some((head, rest)) = t.split_once(['.', ')']) {
        if head.chars().all(|c| c.is_ascii_digit()) && !head.is_empty() {
            return rest.trim();
        }
    }
    t
}

impl Planner for HeuristicPlanner {
    fn plan(&self, brief: &str, team: &Team, lib: &RoleLibrary) -> Vec<Task> {
        // Writer roles present in this team (exclude read-only + director).
        let writers = writer_roles(team, lib);

        let lines: Vec<&str> = brief
            .lines()
            .map(strip_bullet)
            .filter(|l| !l.is_empty())
            .collect();

        let chunks: Vec<String> = if lines.len() <= 1 {
            vec![brief.trim().to_string()]
        } else {
            lines.into_iter().map(String::from).collect()
        };

        let now = now_ms();
        chunks
            .into_iter()
            .enumerate()
            .map(|(i, chunk)| {
                let role_hint = if writers.is_empty() {
                    None
                } else {
                    Some(writers[i % writers.len()].clone())
                };
                let subject = chunk.chars().take(80).collect::<String>();
                Task {
                    id: new_id(),
                    subject,
                    description: chunk,
                    status: TaskStatus::Pending,
                    role_hint,
                    files: Vec::new(),
                    deps: Vec::new(),
                    assignee: None,
                    created_at: now,
                }
            })
            .collect()
    }
}

/// The real LLM Director. Calls `claude` to decompose a brief into parallel
/// tasks with role assignment + non-overlapping file ownership. Falls back to
/// the heuristic planner if the model is unavailable or returns garbage.
pub struct ClaudePlanner {
    pub model: Option<String>,
    pub cwd: PathBuf,
}

impl ClaudePlanner {
    pub fn new(model: Option<String>, cwd: PathBuf) -> Self {
        ClaudePlanner { model, cwd }
    }
}

#[derive(Debug, Deserialize)]
struct PlanTaskRaw {
    subject: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    deps: Vec<usize>,
}

/// Pull a JSON array out of a model response that may be wrapped in prose or
/// ```json fences.
fn extract_json_array(s: &str) -> Option<&str> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    if end > start {
        Some(&s[start..=end])
    } else {
        None
    }
}

/// Parse a Director response into tasks. Validates role ids against the team's
/// writer roles, maps dependency indices to ids, and never lets a task depend on
/// itself. Returns None if nothing usable could be parsed.
pub fn parse_plan(result: &str, team: &Team, lib: &RoleLibrary) -> Option<Vec<Task>> {
    let json = extract_json_array(result)?;
    let raws: Vec<PlanTaskRaw> = serde_json::from_str(json).ok()?;
    if raws.is_empty() {
        return None;
    }
    let writers = writer_roles(team, lib);
    let ids: Vec<String> = raws.iter().map(|_| new_id()).collect();
    let now = now_ms();

    let tasks = raws
        .iter()
        .enumerate()
        .map(|(i, r)| {
            // Keep the role only if it's a real writer role in this team;
            // otherwise hint the first writer (orchestrator will still place it).
            let role_hint = r
                .role
                .as_ref()
                .filter(|rid| writers.iter().any(|w| w == *rid))
                .cloned()
                .or_else(|| writers.first().cloned());
            let deps = r
                .deps
                .iter()
                .filter_map(|&d| ids.get(d).cloned())
                .filter(|id| id != &ids[i])
                .collect();
            Task {
                id: ids[i].clone(),
                subject: r.subject.chars().take(120).collect(),
                description: r.description.clone(),
                status: TaskStatus::Pending,
                role_hint,
                files: r.files.clone(),
                deps,
                assignee: None,
                created_at: now,
            }
        })
        .collect();
    Some(tasks)
}

/// Build the Director's planning prompt.
fn director_prompt(brief: &str, team: &Team, lib: &RoleLibrary) -> String {
    let mut roles_block = String::new();
    let writers = writer_roles(team, lib);
    for role_id in &writers {
        let count = team
            .members
            .iter()
            .filter(|m| &m.role == role_id)
            .map(|m| m.count)
            .sum::<u32>();
        let label = lib.get(role_id).map(|r| r.label.as_str()).unwrap_or(role_id);
        roles_block.push_str(&format!("- {role_id} ({count} instance(s)): {label}\n"));
    }
    format!(
        "You are the Director of an autonomous software engineering team. Break the user's brief \
into concrete, parallel-safe build tasks and assign each to a worker role.\n\n\
Worker roles available (use these exact role ids), with instance counts:\n{roles_block}\n\
Output rules:\n\
- Respond with ONLY a JSON array. No prose, no markdown code fences.\n\
- Each task object: {{\"subject\": string, \"description\": string, \"role\": string, \"files\": [string], \"deps\": [int]}}\n\
  - role: one of the worker role ids above.\n\
  - files: the relative file paths this task will CREATE or OWN. File sets MUST NOT overlap across tasks.\n\
  - deps: 0-based indices of tasks that must complete before this one starts.\n\
- Task index 0 MUST be a scaffolding task (project structure, package.json if needed, shared \
layout/CSS). Most other tasks should include 0 in their deps.\n\
- Decompose enough to use the whole team in parallel, but keep each task a self-contained, \
shippable unit (a page, a component, an API module, a stylesheet, a test suite).\n\
- Each description must be detailed enough to implement with no further questions: specify the \
files to write, what they contain, and to produce working, runnable code. Use sensible \
placeholders where the brief lacks detail.\n\n\
Brief:\n<<<\n{brief}\n>>>"
    )
}

impl Planner for ClaudePlanner {
    fn plan(&self, brief: &str, team: &Team, lib: &RoleLibrary) -> Vec<Task> {
        let prompt = director_prompt(brief, team, lib);
        match claude_oneshot(&prompt, self.model.as_deref(), &self.cwd) {
            Ok(result) => {
                if let Some(tasks) = parse_plan(&result, team, lib) {
                    info!(target: "synapse::director", tasks = tasks.len(), "Director decomposed the brief");
                    return tasks;
                }
                warn!(target: "synapse::director", "Director output was unparseable; falling back to heuristic planner");
            }
            Err(e) => {
                error!(target: "synapse::director", "Director planning call failed: {e}; falling back to heuristic planner");
            }
        }
        HeuristicPlanner.plan(brief, team, lib)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_line_brief_is_one_task() {
        let team = Team::new("t").with("backend-dev", 1);
        let lib = RoleLibrary::builtin_default();
        let tasks = HeuristicPlanner.plan("Build the login flow", &team, &lib);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].role_hint.as_deref(), Some("backend-dev"));
    }

    #[test]
    fn multiline_brief_splits_and_roundrobins() {
        let team = Team::new("t").with("backend-dev", 1).with("frontend-dev", 1);
        let lib = RoleLibrary::builtin_default();
        let brief = "- build the API\n- build the UI\n- wire them together";
        let tasks = HeuristicPlanner.plan(brief, &team, &lib);
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].subject, "build the API");
        assert_eq!(tasks[0].role_hint.as_deref(), Some("backend-dev"));
        assert_eq!(tasks[1].role_hint.as_deref(), Some("frontend-dev"));
        assert_eq!(tasks[2].role_hint.as_deref(), Some("backend-dev"));
    }

    #[test]
    fn reviewers_are_not_task_hints() {
        let team = Team::new("t").with("code-reviewer", 1);
        let lib = RoleLibrary::builtin_default();
        let tasks = HeuristicPlanner.plan("a\nb", &team, &lib);
        assert!(tasks.iter().all(|t| t.role_hint.is_none()));
    }

    #[test]
    fn parse_plan_maps_roles_files_and_deps() {
        let team = Team::new("t").with("backend-dev", 1).with("frontend-dev", 2);
        let lib = RoleLibrary::builtin_default();
        let result = r#"Here is the plan:
```json
[
  {"subject":"scaffold","description":"set up project","role":"backend-dev","files":["package.json","styles.css"],"deps":[]},
  {"subject":"home page","description":"build index.html","role":"frontend-dev","files":["index.html"],"deps":[0]},
  {"subject":"booking page","description":"build booking.html","role":"frontend-dev","files":["booking.html"],"deps":[0]}
]
```
That should do it."#;
        let tasks = parse_plan(result, &team, &lib).expect("should parse");
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].role_hint.as_deref(), Some("backend-dev"));
        assert_eq!(tasks[1].role_hint.as_deref(), Some("frontend-dev"));
        assert_eq!(tasks[0].files, vec!["package.json", "styles.css"]);
        // dep index 0 maps to task[0]'s generated id
        assert_eq!(tasks[1].deps, vec![tasks[0].id.clone()]);
        assert_eq!(tasks[2].deps, vec![tasks[0].id.clone()]);
    }

    #[test]
    fn parse_plan_rejects_unknown_role_with_fallback() {
        let team = Team::new("t").with("backend-dev", 1);
        let lib = RoleLibrary::builtin_default();
        // role "marketing" isn't in the team → falls back to first writer
        let result = r#"[{"subject":"x","description":"y","role":"marketing","files":["a.txt"],"deps":[]}]"#;
        let tasks = parse_plan(result, &team, &lib).unwrap();
        assert_eq!(tasks[0].role_hint.as_deref(), Some("backend-dev"));
    }

    #[test]
    fn parse_plan_none_on_garbage() {
        let team = Team::new("t").with("backend-dev", 1);
        let lib = RoleLibrary::builtin_default();
        assert!(parse_plan("no json here", &team, &lib).is_none());
        assert!(parse_plan("[]", &team, &lib).is_none());
    }
}
