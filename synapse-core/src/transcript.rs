//! Transcript parsing & tool categorization — the heart of the observability
//! "filter". Turns a raw Claude Code JSONL line (or a `stream-json` event) into
//! a vector of typed, categorized [`Message`]s.
//!
//! Handles both shapes the CLI emits:
//!   * transcript files under `~/.claude/projects/**/*.jsonl`
//!   * `claude -p --output-format stream-json` stdout events
//! Both wrap a `message` object whose `content` is either a string (a user
//! prompt) or an array of typed blocks (`text` / `thinking` / `tool_use` /
//! `tool_result`).

use crate::types::{Message, MessageKind, ToolCategory};
use crate::util::new_id;
use serde_json::Value;

/// Map a tool name to its display category. Mirrors ClaudeConnect's 14-category
/// scheme; `mcp__*` tools fold to [`ToolCategory::Mcp`].
pub fn categorize_tool(name: &str) -> ToolCategory {
    if let Some(rest) = name.strip_prefix("mcp__") {
        // mcp__server__tool — still MCP regardless of the inner tool.
        let _ = rest;
        return ToolCategory::Mcp;
    }
    match name {
        "Bash" | "BashOutput" | "KillShell" | "KillBash" => ToolCategory::Shell,
        "Read" | "NotebookRead" => ToolCategory::FileRead,
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => ToolCategory::FileWrite,
        "Glob" | "Grep" | "LS" => ToolCategory::Search,
        "WebFetch" | "WebSearch" => ToolCategory::Web,
        "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet" | "TaskOutput"
        | "TaskStop" => ToolCategory::Tasks,
        "Task" | "Agent" | "SendMessage" => ToolCategory::Subagents,
        "AskUserQuestion" => ToolCategory::AskUser,
        "ScheduleWakeup" | "CronCreate" | "CronDelete" | "CronList" => ToolCategory::Scheduling,
        "PushNotification" | "RemoteTrigger" => ToolCategory::Notifications,
        "ExitPlanMode" | "EnterPlanMode" => ToolCategory::Plan,
        "EnterWorktree" | "ExitWorktree" | "WorktreeCreate" | "WorktreeRemove" => {
            ToolCategory::Worktrees
        }
        _ => ToolCategory::Other,
    }
}

/// Is this a file-write tool whose input should be retained as `edit_data` for
/// diff rendering?
fn is_edit_tool(name: &str) -> bool {
    matches!(name, "Edit" | "MultiEdit" | "Write" | "NotebookEdit")
}

/// Extract the session id from a top-level entry (transcript uses `sessionId`,
/// stream-json `system` events use `session_id`).
fn extract_session_id(entry: &Value) -> Option<String> {
    entry
        .get("sessionId")
        .and_then(|v| v.as_str())
        .or_else(|| entry.get("session_id").and_then(|v| v.as_str()))
        .map(String::from)
}

/// A short, single-line preview of a tool's input for the bubble header.
fn tool_preview(name: &str, input: &Value) -> String {
    let pick = |keys: &[&str]| -> Option<String> {
        for k in keys {
            if let Some(s) = input.get(*k).and_then(|v| v.as_str()) {
                return Some(s.to_string());
            }
        }
        None
    };
    let raw = match name {
        "Bash" => pick(&["command"]),
        "Read" | "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => pick(&["file_path", "path", "notebook_path"]),
        "Glob" | "Grep" => pick(&["pattern"]),
        "WebFetch" => pick(&["url"]),
        "WebSearch" => pick(&["query"]),
        "Task" => pick(&["description", "subject"]),
        _ => None,
    }
    .or_else(|| pick(&["description", "subject", "command", "pattern", "query", "url", "file_path", "path"]))
    .unwrap_or_default();
    let one_line = raw.replace('\n', " ");
    if one_line.len() > 160 {
        format!("{}…", &one_line[..160])
    } else {
        one_line
    }
}

/// Parse a single JSONL line into zero or more messages. `ts` is the fallback
/// timestamp (ms) used when the entry carries no parseable timestamp; `agent_id`
/// tags every produced message with the owning agent.
pub fn parse_line(line: &str, ts: i64, agent_id: Option<&str>) -> Vec<Message> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let entry: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    parse_entry(&entry, ts, agent_id)
}

/// Parse an already-decoded JSON entry.
pub fn parse_entry(entry: &Value, ts: i64, agent_id: Option<&str>) -> Vec<Message> {
    let session_id = extract_session_id(entry);
    let agent = agent_id.map(String::from);
    let mut out = Vec::new();

    // The actual message lives under `message`; stream-json `result`/`system`
    // events are skipped (they carry no renderable content blocks here).
    let entry_type = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let message = match entry.get("message") {
        Some(m) => m,
        None => return out,
    };
    let role = message
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or(entry_type)
        .to_string();

    let content = match message.get("content") {
        Some(c) => c,
        None => return out,
    };

    let mk = |kind: MessageKind, text: String| Message {
        id: new_id(),
        role: role.clone(),
        kind,
        text,
        tool_name: None,
        tool_category: None,
        tool_use_id: None,
        is_error: false,
        agent_id: agent.clone(),
        session_id: session_id.clone(),
        ts,
        edit_data: None,
    };

    match content {
        // A bare string is a user prompt.
        Value::String(s) => {
            if !s.trim().is_empty() {
                out.push(mk(MessageKind::User, s.clone()));
            }
        }
        Value::Array(blocks) => {
            for block in blocks {
                let btype = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match btype {
                    "text" => {
                        let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if text.trim().is_empty() {
                            continue;
                        }
                        let kind = if text.trim_end().ends_with('?') {
                            MessageKind::Question
                        } else {
                            MessageKind::Message
                        };
                        out.push(mk(kind, text));
                    }
                    "thinking" => {
                        let text = block
                            .get("thinking")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        if !text.trim().is_empty() {
                            out.push(mk(MessageKind::Thinking, text));
                        }
                    }
                    "tool_use" => {
                        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let tool_use_id =
                            block.get("id").and_then(|v| v.as_str()).map(String::from);
                        // ExitPlanMode renders as a Plan bubble with the plan body.
                        if name == "ExitPlanMode" {
                            let plan = input
                                .get("plan")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let mut m = mk(MessageKind::Plan, plan);
                            m.tool_name = Some(name);
                            m.tool_category = Some(ToolCategory::Plan);
                            m.tool_use_id = tool_use_id;
                            out.push(m);
                            continue;
                        }
                        let mut m = mk(MessageKind::ToolCall, tool_preview(&name, &input));
                        m.tool_category = Some(categorize_tool(&name));
                        if is_edit_tool(&name) {
                            m.edit_data = Some(input.clone());
                        }
                        m.tool_name = Some(name);
                        m.tool_use_id = tool_use_id;
                        out.push(m);
                    }
                    "tool_result" => {
                        let is_error = block
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let text = stringify_result(block.get("content"));
                        let mut m = mk(
                            if is_error { MessageKind::Error } else { MessageKind::ToolResult },
                            text,
                        );
                        m.is_error = is_error;
                        m.tool_use_id = block
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        out.push(m);
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    // Stable ids: derive each message's id from the transcript entry's `uuid`
    // (+ block index) so re-parsing the same file yields identical ids. The UI
    // relies on stable ids to keep the selected turn and expanded diffs from
    // resetting as new lines stream in. Falls back to the random ids assigned
    // above for stream-json events (which carry no uuid).
    if let Some(base) = entry.get("uuid").and_then(|v| v.as_str()) {
        for (i, m) in out.iter_mut().enumerate() {
            m.id = format!("{base}-{i}");
        }
    }

    out
}

/// tool_result `content` is either a string or an array of `{type:text,text}`
/// blocks; flatten to a single string.
fn stringify_result(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorizes_tools() {
        assert_eq!(categorize_tool("Bash"), ToolCategory::Shell);
        assert_eq!(categorize_tool("Edit"), ToolCategory::FileWrite);
        assert_eq!(categorize_tool("Grep"), ToolCategory::Search);
        assert_eq!(categorize_tool("WebSearch"), ToolCategory::Web);
        assert_eq!(categorize_tool("TaskCreate"), ToolCategory::Tasks);
        assert_eq!(categorize_tool("mcp__synapse__spawn_agent"), ToolCategory::Mcp);
        assert_eq!(categorize_tool("EnterWorktree"), ToolCategory::Worktrees);
        assert_eq!(categorize_tool("SomethingNew"), ToolCategory::Other);
    }

    #[test]
    fn parses_user_prompt() {
        let line = r#"{"type":"user","sessionId":"s1","message":{"role":"user","content":"Build the auth module"}}"#;
        let msgs = parse_line(line, 100, Some("a1"));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].kind, MessageKind::User);
        assert_eq!(msgs[0].text, "Build the auth module");
        assert_eq!(msgs[0].agent_id.as_deref(), Some("a1"));
        assert_eq!(msgs[0].session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn parses_assistant_blocks() {
        let line = r#"{"type":"assistant","sessionId":"s1","message":{"role":"assistant","content":[
            {"type":"thinking","thinking":"let me plan"},
            {"type":"text","text":"Here is the plan."},
            {"type":"text","text":"Should I proceed?"},
            {"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls -la"}},
            {"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"src/a.rs","old_string":"x","new_string":"y"}}
        ]}}"#;
        let msgs = parse_line(line, 100, None);
        let kinds: Vec<_> = msgs.iter().map(|m| m.kind).collect();
        assert_eq!(
            kinds,
            vec![
                MessageKind::Thinking,
                MessageKind::Message,
                MessageKind::Question,
                MessageKind::ToolCall,
                MessageKind::ToolCall
            ]
        );
        // Bash preview is the command.
        assert_eq!(msgs[3].text, "ls -la");
        assert_eq!(msgs[3].tool_category, Some(ToolCategory::Shell));
        // Edit retains edit_data + previews the file path.
        assert_eq!(msgs[4].text, "src/a.rs");
        assert!(msgs[4].edit_data.is_some());
        assert_eq!(msgs[4].tool_category, Some(ToolCategory::FileWrite));
    }

    #[test]
    fn parses_tool_result_and_error() {
        let ok = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"done"}]}}"#;
        let m = parse_line(ok, 1, None);
        assert_eq!(m[0].kind, MessageKind::ToolResult);
        assert_eq!(m[0].text, "done");
        assert!(!m[0].is_error);

        let err = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"boom"}],"is_error":true}]}}"#;
        let m = parse_line(err, 1, None);
        assert_eq!(m[0].kind, MessageKind::Error);
        assert!(m[0].is_error);
        assert_eq!(m[0].text, "boom");
    }

    #[test]
    fn exit_plan_mode_becomes_plan() {
        let line = r##"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"ExitPlanMode","input":{"plan":"# Plan\n- step"}}]}}"##;
        let m = parse_line(line, 1, None);
        assert_eq!(m[0].kind, MessageKind::Plan);
        assert!(m[0].text.contains("# Plan"));
        assert_eq!(m[0].tool_category, Some(ToolCategory::Plan));
    }

    #[test]
    fn junk_lines_are_ignored() {
        assert!(parse_line("not json", 1, None).is_empty());
        assert!(parse_line("", 1, None).is_empty());
        assert!(parse_line(r#"{"type":"result","subtype":"success"}"#, 1, None).is_empty());
    }
}
