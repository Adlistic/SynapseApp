//! Plain-old-data types shared across the engine. All serde-serializable with
//! camelCase on the wire so the React frontend reads them directly.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The kind of a parsed transcript message. Mirrors the categories ClaudeConnect
/// renders, trimmed to what the ADE needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    /// A user prompt.
    User,
    /// Assistant text reply.
    Message,
    /// Assistant text reply that ends in a question mark.
    Question,
    /// Assistant internal reasoning block.
    Thinking,
    /// A `tool_use` block.
    ToolCall,
    /// A `tool_result` block.
    ToolResult,
    /// A failed tool call.
    Error,
    /// The markdown body of an `ExitPlanMode` call.
    Plan,
    /// Anything we couldn't classify.
    Other,
}

impl MessageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MessageKind::User => "user",
            MessageKind::Message => "message",
            MessageKind::Question => "question",
            MessageKind::Thinking => "thinking",
            MessageKind::ToolCall => "toolcall",
            MessageKind::ToolResult => "toolresult",
            MessageKind::Error => "error",
            MessageKind::Plan => "plan",
            MessageKind::Other => "other",
        }
    }
}

/// Tool category, used to color-code and to let filters collapse noise. Mirrors
/// ClaudeConnect's 14-category scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolCategory {
    Shell,
    FileRead,
    FileWrite,
    Search,
    Web,
    Tasks,
    Subagents,
    AskUser,
    Scheduling,
    Notifications,
    Plan,
    Worktrees,
    Mcp,
    Other,
}

impl ToolCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolCategory::Shell => "shell",
            ToolCategory::FileRead => "file-read",
            ToolCategory::FileWrite => "file-write",
            ToolCategory::Search => "search",
            ToolCategory::Web => "web",
            ToolCategory::Tasks => "tasks",
            ToolCategory::Subagents => "subagents",
            ToolCategory::AskUser => "ask-user",
            ToolCategory::Scheduling => "scheduling",
            ToolCategory::Notifications => "notifications",
            ToolCategory::Plan => "plan",
            ToolCategory::Worktrees => "worktrees",
            ToolCategory::Mcp => "mcp",
            ToolCategory::Other => "other",
        }
    }
}

/// A single parsed message in an agent's stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    /// "user" | "assistant" | "system"
    pub role: String,
    pub kind: MessageKind,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_category: Option<ToolCategory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    /// The agent (session) this message belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub ts: i64,
    /// Structured edit payload for file-write tools so the frontend can render a
    /// diff. Shape varies per tool; the redactor walks it recursively.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit_data: Option<Value>,
}

/// Lifecycle status of an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    /// Spawned, not yet given work.
    Idle,
    /// Working on an assigned task.
    Working,
    /// Blocked awaiting input (question / plan approval).
    Blocked,
    /// Finished its current task, awaiting more.
    Done,
    /// Hit an error and stopped.
    Errored,
    /// Cleanly shut down.
    Stopped,
}

/// A spawned agent = a session plus its role and isolation context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    /// Stable session id passed to `claude --session-id`.
    pub session_id: String,
    /// Role id from the role library.
    pub role_id: String,
    /// Human label, e.g. "backend-dev-1".
    pub name: String,
    pub status: AgentStatus,
    /// Git branch this agent owns (None for shared-isolation agents).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Working directory (the worktree path, or the shared workspace root).
    pub cwd: String,
    /// Files this agent currently owns a lock on.
    #[serde(default)]
    pub owned_files: Vec<String>,
    /// Id of the task currently assigned, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_task: Option<String>,
    pub created_at: i64,
}

/// Task status. Mirrors Claude Code's task list plus a `review` state for the
/// auditor gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    InProgress,
    InReview,
    Completed,
    Blocked,
}

/// A unit of work the Director hands to an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub subject: String,
    #[serde(default)]
    pub description: String,
    pub status: TaskStatus,
    /// Role id best suited to this task (e.g. "backend-dev").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_hint: Option<String>,
    /// Files this task is expected to touch — used to assign exclusive ownership.
    #[serde(default)]
    pub files: Vec<String>,
    /// Task ids that must complete before this one can start.
    #[serde(default)]
    pub deps: Vec<String>,
    /// Agent currently assigned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    pub created_at: i64,
}

impl Task {
    /// A task is claimable when pending and all its deps are completed.
    pub fn is_claimable(&self, completed: &[String]) -> bool {
        self.status == TaskStatus::Pending
            && self.deps.iter().all(|d| completed.contains(d))
    }
}

/// A message in the inter-agent mailbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxMessage {
    pub id: String,
    /// Sender agent id (or "director").
    pub from: String,
    /// Recipient agent id, or "*" for broadcast.
    pub to: String,
    pub body: String,
    pub ts: i64,
    #[serde(default)]
    pub read: bool,
}

/// File lock mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LockMode {
    Read,
    Write,
}

/// An ownership lock on a file path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLock {
    pub path: String,
    pub owner: String,
    pub mode: LockMode,
    pub acquired_at: i64,
}

/// Review verdict from an auditor/reviewer agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewVerdict {
    Pending,
    Approved,
    Rejected,
}

/// A request to review a branch/diff before it merges.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub id: String,
    pub branch: String,
    pub requested_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<String>,
    pub verdict: ReviewVerdict,
    #[serde(default)]
    pub notes: String,
    pub created_at: i64,
}
