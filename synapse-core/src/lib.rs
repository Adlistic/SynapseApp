//! Synapse ADE core engine.
//!
//! A purpose-built Agentic Development Environment core: a Director orchestrates
//! a configurable team of role-specialized agents, each isolated in its own git
//! worktree, coordinating through a shared task board, mailbox, and file-ownership
//! locks, with every agent's output parsed, categorized, and redacted.
//!
//! This crate is intentionally free of any UI / Tauri dependency so it can be
//! unit-tested fast and reused by both the desktop app and the CLI harness.

pub mod budget;
pub mod diag;
pub mod locks;
pub mod mailbox;
pub mod orchestrator;
pub mod planner;
pub mod redactor;
pub mod roles;
pub mod runner;
pub mod team;
pub mod transcript;
pub mod types;
pub mod util;
pub mod worktree;

pub use orchestrator::Orchestrator;
pub use redactor::{RedactorConfig, redact_deep, redact_string};
pub use roles::{Role, RoleLibrary};
pub use runner::{AgentEvent, AgentHandle, AgentRunner, MockRunner, SpawnSpec};
pub use team::{Team, TeamMemberSpec};
pub use transcript::{categorize_tool, parse_line};
pub use types::*;
