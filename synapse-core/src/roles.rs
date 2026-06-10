//! Role registry. A *role* is pure data — system prompt + model + tool allowlist
//! + isolation + permission mode. Any number of agents of any role can be spawned;
//! the spawn code path is identical, only the config differs. This is what makes
//! "3 developers, 5 developers, a security reviewer, a code reviewer" free.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// How an agent's working tree is isolated from its peers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Isolation {
    /// One git worktree + branch per agent (physical isolation). The default
    /// for writers.
    Worktree,
    /// Shares the workspace root. Fine for read-only roles.
    Shared,
    /// A full copy of the working tree.
    Copy,
}

impl Default for Isolation {
    fn default() -> Self {
        Isolation::Worktree
    }
}

/// Permission posture passed through to the agent runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    /// Read-only plan mode until approved.
    Plan,
    AcceptEdits,
    DontAsk,
    /// Full autonomy — `--dangerously-skip-permissions`. Required for truly
    /// unattended building, since headless agents can't surface approval prompts.
    Bypass,
}

impl Default for PermissionMode {
    fn default() -> Self {
        PermissionMode::Default
    }
}

/// A role definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub label: String,
    /// Model id (e.g. "claude-opus-4-8"). Empty = inherit the team default.
    #[serde(default)]
    pub model: String,
    /// Appended to the agent's system prompt.
    pub system_prompt: String,
    /// Tool allowlist. Empty = inherit all of the parent's tools.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Reviewers are read-only and can never mutate the tree.
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub isolation: Isolation,
    #[serde(default)]
    pub permission_mode: PermissionMode,
}

impl Role {
    pub fn new(id: &str, label: &str, system_prompt: &str) -> Self {
        Role {
            id: id.to_string(),
            label: label.to_string(),
            model: String::new(),
            system_prompt: system_prompt.to_string(),
            tools: Vec::new(),
            read_only: false,
            isolation: Isolation::Worktree,
            permission_mode: PermissionMode::Default,
        }
    }

    pub fn with_tools(mut self, tools: &[&str]) -> Self {
        self.tools = tools.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self.isolation = Isolation::Shared;
        self.permission_mode = PermissionMode::Plan;
        self
    }

    pub fn with_model(mut self, model: &str) -> Self {
        self.model = model.to_string();
        self
    }
}

/// A named team composition (preset).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub label: String,
    /// (role_id, count) pairs.
    pub members: Vec<(String, u32)>,
}

/// The role registry: a set of roles plus a set of team presets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleLibrary {
    pub roles: BTreeMap<String, Role>,
    pub presets: Vec<Preset>,
}

impl RoleLibrary {
    pub fn get(&self, id: &str) -> Option<&Role> {
        self.roles.get(id)
    }

    pub fn insert(&mut self, role: Role) {
        self.roles.insert(role.id.clone(), role);
    }

    pub fn preset(&self, id: &str) -> Option<&Preset> {
        self.presets.iter().find(|p| p.id == id)
    }

    /// The built-in default library: developers, reviewers, researcher, tester,
    /// plus the Director, plus sensible presets.
    pub fn builtin_default() -> Self {
        let coder_tools = ["Read", "Edit", "MultiEdit", "Write", "Bash", "Glob", "Grep"];
        let review_tools = ["Read", "Grep", "Glob"];

        let mut roles = BTreeMap::new();
        let mut add = |r: Role| {
            roles.insert(r.id.clone(), r);
        };

        add(
            Role::new(
                "director",
                "Director",
                "You are the Director. Read the brief, break it into parallel-safe tasks with \
                 clear file ownership, spawn the right agents, route work, and step in only when \
                 an agent is stuck. You hold the lock and synthesize the result.",
            )
            .with_tools(&["Read", "Grep", "Glob"])
            .with_model("claude-opus-4-8"),
        );

        add(
            Role::new(
                "backend-dev",
                "Backend Developer",
                "You are a senior backend developer. Implement server-side logic, APIs, data \
                 models, and tests. Touch only the files you own. Match existing patterns. \
                 Validate your work before marking the task done.",
            )
            .with_tools(&coder_tools),
        );

        add(
            Role::new(
                "frontend-dev",
                "Frontend Developer",
                "You are a senior frontend developer. Build UI components and client logic. \
                 Touch only the files you own. Match existing conventions and keep the build green.",
            )
            .with_tools(&coder_tools),
        );

        add(
            Role::new(
                "fullstack-dev",
                "Full-stack Developer",
                "You are a full-stack developer comfortable across the whole stack. Implement the \
                 assigned slice end-to-end. Touch only the files you own.",
            )
            .with_tools(&coder_tools),
        );

        add(
            Role::new(
                "code-reviewer",
                "Code Reviewer",
                "You are a principal engineer acting as a read-only quality gate. Review each \
                 diff for correctness, simplicity, and consistency. Approve or reject with \
                 specific, actionable feedback. You never modify code.",
            )
            .with_tools(&review_tools)
            .read_only(),
        );

        add(
            Role::new(
                "security-reviewer",
                "Security Reviewer",
                "You are a read-only security auditor. Review every diff for OWASP Top 10 and \
                 CWE Top 25 issues, secrets, injection, auth flaws, and unsafe patterns. Flag \
                 findings with severity. You never modify code.",
            )
            .with_tools(&review_tools)
            .read_only(),
        );

        add(
            Role::new(
                "researcher",
                "Researcher",
                "You are a researcher/scout. Map the codebase and gather context before the \
                 coders start. Surface patterns, risks, and gotchas, and write findings to the \
                 shared memory vault every agent can read.",
            )
            .with_tools(&["Read", "Grep", "Glob", "WebSearch", "WebFetch"])
            .read_only(),
        );

        add(
            Role::new(
                "tester",
                "Tester",
                "You are a test engineer. Write and run tests for the assigned area, report \
                 failures clearly, and keep the suite green. Touch only test files you own.",
            )
            .with_tools(&["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
        );

        let presets = vec![
            Preset {
                id: "solo".into(),
                label: "Solo".into(),
                members: vec![("fullstack-dev".into(), 1)],
            },
            Preset {
                id: "pair-review".into(),
                label: "Pair + Review".into(),
                members: vec![("fullstack-dev".into(), 2), ("code-reviewer".into(), 1)],
            },
            Preset {
                id: "research".into(),
                label: "Research".into(),
                members: vec![("researcher".into(), 2)],
            },
            Preset {
                id: "full-squad".into(),
                label: "Full Squad".into(),
                members: vec![
                    ("backend-dev".into(), 2),
                    ("frontend-dev".into(), 3),
                    ("security-reviewer".into(), 1),
                    ("code-reviewer".into(), 1),
                    ("tester".into(), 1),
                ],
            },
        ];

        RoleLibrary { roles, presets }
    }
}

impl Default for RoleLibrary {
    fn default() -> Self {
        Self::builtin_default()
    }
}

/// The "safe allowlist" tool set for real, unattended building: full file tools
/// plus a scoped set of shell commands (no bare `Bash`, so arbitrary commands
/// are NOT auto-approved). Paired with `PermissionMode::AcceptEdits`.
pub fn default_build_tools() -> Vec<String> {
    [
        "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep",
        "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(yarn:*)",
        "Bash(mkdir:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(echo:*)",
        "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "Bash(git:*)",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_library_has_core_roles() {
        let lib = RoleLibrary::builtin_default();
        for id in [
            "director",
            "backend-dev",
            "frontend-dev",
            "fullstack-dev",
            "code-reviewer",
            "security-reviewer",
            "researcher",
            "tester",
        ] {
            assert!(lib.get(id).is_some(), "missing role {id}");
        }
    }

    #[test]
    fn reviewers_are_read_only_and_planning() {
        let lib = RoleLibrary::builtin_default();
        let r = lib.get("security-reviewer").unwrap();
        assert!(r.read_only);
        assert_eq!(r.isolation, Isolation::Shared);
        assert_eq!(r.permission_mode, PermissionMode::Plan);
        // read-only roles never get write tools
        assert!(!r.tools.iter().any(|t| t == "Edit" || t == "Write" || t == "Bash"));
    }

    #[test]
    fn developers_can_write_in_worktrees() {
        let lib = RoleLibrary::builtin_default();
        let r = lib.get("backend-dev").unwrap();
        assert!(!r.read_only);
        assert_eq!(r.isolation, Isolation::Worktree);
        assert!(r.tools.iter().any(|t| t == "Edit"));
    }

    #[test]
    fn presets_reference_real_roles() {
        let lib = RoleLibrary::builtin_default();
        for p in &lib.presets {
            for (role_id, count) in &p.members {
                assert!(lib.get(role_id).is_some(), "preset {} -> unknown role {}", p.id, role_id);
                assert!(*count >= 1);
            }
        }
        assert!(lib.preset("full-squad").is_some());
    }

    #[test]
    fn role_library_roundtrips_json() {
        let lib = RoleLibrary::builtin_default();
        let json = serde_json::to_string(&lib).unwrap();
        let back: RoleLibrary = serde_json::from_str(&json).unwrap();
        assert_eq!(back.roles.len(), lib.roles.len());
    }
}
