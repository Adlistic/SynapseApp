//! OpenAI Codex CLI support: turns one line of a Codex "rollout" file
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`) into the same
//! typed [`Message`]s the Claude Code parser produces, so the reader lays a
//! Codex session out exactly like a Claude one.
//!
//! A rollout line is `{timestamp, ordinal, type, payload}`. What we read:
//!   * `event_msg` / `item_completed`: one finished conversation item (your
//!     prompt, a reply, a command it ran, a file change, an MCP call, a web
//!     search). This is the readable conversation.
//!   * `event_msg` / `task_started` | `task_complete` | `turn_aborted`: a turn
//!     opening and closing, which says exactly when Codex is working.
//!   * `event_msg` / `token_count`: running token totals, context size and the
//!     account's usage-limit windows.
//!   * `session_meta`, `turn_context`, `thread_settings_applied`: id, folder, model.
//!
//! `response_item` lines (the raw model input/output, including injected
//! instructions the user never typed) are deliberately ignored.

use crate::transcript::parse_rfc3339_ms;
use crate::types::{Message, MessageKind, ToolCategory};
use serde_json::{json, Value};

/// Token totals for the whole session so far (absolute, not a delta).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CodexUsage {
    /// Input tokens that were not served from cache.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

/// The session header (first line of every rollout).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexMeta {
    pub id: String,
    pub cwd: String,
    /// Epoch ms the session started, when the header has a timestamp.
    pub started_ms: Option<i64>,
    /// "cli", "exec", "vscode", … (who started it). Newer terminal sessions
    /// also say "vscode" (the terminal app talks to the same background
    /// service the editor extension uses), so `originator` is the better guide.
    pub source: String,
    /// The program that wrote the session: "codex-tui" for the terminal app.
    pub originator: String,
}

/// Everything one rollout line can tell us.
#[derive(Debug, Clone, Default)]
pub struct CodexLine {
    pub messages: Vec<Message>,
    pub usage: Option<CodexUsage>,
    /// Tokens the latest request used ≈ how full the context is.
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub model: Option<String>,
    /// Some(true) when a turn starts, Some(false) when it ends.
    pub turn_open: Option<bool>,
    /// The account's usage-limit windows (`primary` ≈ 5 h, `secondary` ≈ weekly).
    pub rate_limits: Option<Value>,
    pub meta: Option<CodexMeta>,
    /// The line's own timestamp (epoch ms), and as written.
    pub at: Option<i64>,
    pub timestamp: Option<String>,
    /// Codex numbers its lines; used to skip lines already read.
    pub ordinal: Option<i64>,
}

/// Strip the `\\?\` long-path prefix Codex sometimes records.
pub fn clean_path(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

/// Parse one rollout line. `ts` is the fallback ordering value for messages.
pub fn parse_codex_line(line: &str, ts: i64) -> CodexLine {
    let mut out = CodexLine::default();
    let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else { return out };
    out.timestamp = entry.get("timestamp").and_then(|v| v.as_str()).map(String::from);
    out.at = out.timestamp.as_deref().and_then(parse_rfc3339_ms);
    out.ordinal = entry.get("ordinal").and_then(|v| v.as_i64());
    let payload = entry.get("payload").cloned().unwrap_or(Value::Null);
    let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
    match entry.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "session_meta" => {
            out.meta = Some(CodexMeta {
                id: s(&payload, "id").or_else(|| s(&payload, "session_id")).unwrap_or_default(),
                cwd: clean_path(&s(&payload, "cwd").unwrap_or_default()),
                started_ms: payload.get("timestamp").and_then(|v| v.as_str()).and_then(parse_rfc3339_ms),
                source: s(&payload, "source").unwrap_or_default(),
                originator: s(&payload, "originator").unwrap_or_default(),
            });
        }
        "turn_context" => out.model = s(&payload, "model"),
        "event_msg" => match payload.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "item_completed" => {
                if let Some(item) = payload.get("item") {
                    out.messages = item_messages(item, ts, out.at);
                }
            }
            "task_started" | "turn_started" => {
                out.turn_open = Some(true);
                out.context_window = payload.get("model_context_window").and_then(|v| v.as_u64());
            }
            "task_complete" | "turn_complete" | "turn_aborted" => out.turn_open = Some(false),
            "token_count" => {
                if let Some(info) = payload.get("info").filter(|v| v.is_object()) {
                    let n = |v: Option<&Value>, k: &str| v.and_then(|u| u.get(k)).and_then(|x| x.as_u64()).unwrap_or(0);
                    let tot = info.get("total_token_usage");
                    if tot.is_some() {
                        let cached = n(tot, "cached_input_tokens");
                        out.usage = Some(CodexUsage {
                            input: n(tot, "input_tokens").saturating_sub(cached),
                            output: n(tot, "output_tokens"),
                            cache_read: cached,
                            cache_creation: n(tot, "cache_write_input_tokens"),
                        });
                    }
                    let last = info.get("last_token_usage");
                    if last.is_some() {
                        let used = n(last, "input_tokens") + n(last, "output_tokens");
                        if used > 0 {
                            out.context_tokens = Some(used);
                        }
                    }
                    out.context_window = info.get("model_context_window").and_then(|v| v.as_u64());
                }
                out.rate_limits = payload.get("rate_limits").filter(|v| v.is_object()).cloned();
            }
            "thread_settings_applied" => {
                out.model = payload.get("thread_settings").and_then(|t| s(t, "model"));
            }
            "error" => {
                if let Some(text) = s(&payload, "message").filter(|t| !t.trim().is_empty()) {
                    let mut m = msg("assistant", MessageKind::Error, text, ts, out.at);
                    m.is_error = true;
                    m.id = format!("err-{}", entry.get("ordinal").and_then(|v| v.as_i64()).unwrap_or(ts));
                    out.messages.push(m);
                }
            }
            _ => {}
        },
        _ => {}
    }
    out
}

fn msg(role: &str, kind: MessageKind, text: String, ts: i64, at: Option<i64>) -> Message {
    Message {
        id: String::new(),
        role: role.to_string(),
        kind,
        text,
        tool_name: None,
        tool_category: None,
        tool_use_id: None,
        is_error: false,
        agent_id: None,
        session_id: None,
        ts,
        edit_data: None,
        input: None,
        at,
        mid_turn: false,
        desc: None,
    }
}

fn one_line(s: &str) -> String {
    let flat = s.replace(['\r', '\n'], " ");
    let flat = flat.trim();
    if flat.chars().count() > 160 {
        format!("{}…", flat.chars().take(160).collect::<String>())
    } else {
        flat.to_string()
    }
}

/// Item fields are snake_case in rollouts; accept camelCase too.
fn field<'a>(item: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    item.get(snake).or_else(|| item.get(camel))
}

/// Text of a content array (`[{type:"text"|"Text", text}]`) or a bare string.
fn content_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|b| b.as_str().map(String::from).or_else(|| b.get("text").and_then(|t| t.as_str()).map(String::from)))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn tool_pair(
    out: &mut Vec<Message>,
    id: &str,
    name: &str,
    cat: ToolCategory,
    preview: String,
    edit: Option<Value>,
    result: String,
    is_error: bool,
    ts: i64,
    at: Option<i64>,
) {
    let mut call = msg("assistant", MessageKind::ToolCall, preview, ts, at);
    call.id = format!("{id}-call");
    call.tool_name = Some(name.to_string());
    call.tool_category = Some(cat);
    call.tool_use_id = Some(id.to_string());
    call.edit_data = edit;
    out.push(call);
    let mut res = msg("user", if is_error { MessageKind::Error } else { MessageKind::ToolResult }, result, ts, at);
    res.id = format!("{id}-result");
    res.tool_use_id = Some(id.to_string());
    res.is_error = is_error;
    out.push(res);
}

/// The command as the user would type it: Codex wraps everything in
/// `powershell.exe -Command <cmd>` (or `bash -lc <cmd>`); show just `<cmd>`.
fn command_text(item: &Value) -> String {
    let parsed: Vec<String> = field(item, "parsed_cmd", "commandActions")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|p| p.get("cmd").and_then(|c| c.as_str()).map(String::from)).collect())
        .unwrap_or_default();
    if !parsed.is_empty() {
        return parsed.join(" && ");
    }
    match item.get("command") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => {
            let parts: Vec<&str> = a.iter().filter_map(|x| x.as_str()).collect();
            let wrapper = ["-Command", "-command", "-c", "-lc", "/c", "/C"];
            if parts.len() >= 3 && wrapper.contains(&parts[parts.len() - 2]) {
                parts[parts.len() - 1].to_string()
            } else {
                parts.join(" ")
            }
        }
        _ => String::new(),
    }
}

/// A unified diff (`@@ … @@` hunks) → one {old_string, new_string} per hunk,
/// the shape the diff view already renders for Claude's Edit/MultiEdit.
pub fn diff_hunks(diff: &str) -> Vec<(String, String)> {
    let mut hunks = Vec::new();
    let mut cur: Option<(Vec<&str>, Vec<&str>)> = None;
    for line in diff.lines() {
        if line.starts_with("@@") {
            if let Some((o, n)) = cur.take() {
                hunks.push((o, n));
            }
            cur = Some((Vec::new(), Vec::new()));
            continue;
        }
        if (line.starts_with("--- ") || line.starts_with("+++ ")) && cur.is_none() {
            continue; // file header before the first hunk
        }
        let Some((o, n)) = cur.as_mut() else { continue };
        if let Some(rest) = line.strip_prefix('-') {
            o.push(rest);
        } else if let Some(rest) = line.strip_prefix('+') {
            n.push(rest);
        } else if line.starts_with('\\') {
            // "\ No newline at end of file"
        } else {
            let rest = line.strip_prefix(' ').unwrap_or(line);
            o.push(rest);
            n.push(rest);
        }
    }
    if let Some((o, n)) = cur {
        hunks.push((o, n));
    }
    hunks
        .into_iter()
        .filter(|(o, n)| !(o.is_empty() && n.is_empty()))
        .map(|(o, n)| {
            let j = |v: Vec<&str>| if v.is_empty() { String::new() } else { v.join("\n") + "\n" };
            (j(o), j(n))
        })
        .collect()
}

/// One completed item → messages (a tool step is a call + its result).
fn item_messages(item: &Value, ts: i64, at: Option<i64>) -> Vec<Message> {
    let mut out = Vec::new();
    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("item").to_string();
    let ty = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("completed");
    let failed = matches!(status, "failed" | "declined" | "error");
    match ty {
        "UserMessage" | "userMessage" => {
            let text = content_text(item.get("content"));
            let has_image = item.get("content").and_then(|c| c.as_array()).is_some_and(|a| {
                a.iter().any(|b| b.get("type").and_then(|t| t.as_str()).is_some_and(|t| t.to_lowercase().contains("image")))
            });
            let text = if text.trim().is_empty() && has_image { "[image]".to_string() } else { text };
            if !text.trim().is_empty() {
                let mut m = msg("user", MessageKind::User, text, ts, at);
                m.id = format!("{id}-0");
                out.push(m);
            }
        }
        "AgentMessage" | "agentMessage" => {
            let text = {
                let t = content_text(item.get("content"));
                if t.is_empty() { item.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string() } else { t }
            };
            if !text.trim().is_empty() {
                let kind = if text.trim_end().ends_with('?') { MessageKind::Question } else { MessageKind::Message };
                let mut m = msg("assistant", kind, text, ts, at);
                m.id = format!("{id}-0");
                out.push(m);
            }
        }
        "Reasoning" | "reasoning" => {
            let mut parts = Vec::new();
            for k in ["summary_text", "summary", "raw_content", "content"] {
                let t = content_text(item.get(k));
                if !t.trim().is_empty() {
                    parts.push(t);
                    break;
                }
            }
            if let Some(text) = parts.pop() {
                let mut m = msg("assistant", MessageKind::Thinking, text, ts, at);
                m.id = format!("{id}-0");
                out.push(m);
            }
        }
        "CommandExecution" | "commandExecution" => {
            let cmd = command_text(item);
            let output = field(item, "aggregated_output", "aggregatedOutput")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| {
                    let so = item.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
                    let se = item.get("stderr").and_then(|v| v.as_str()).unwrap_or("");
                    format!("{so}{se}")
                });
            let code = field(item, "exit_code", "exitCode").and_then(|v| v.as_i64());
            let is_error = failed || code.is_some_and(|c| c != 0);
            let result = if output.trim().is_empty() {
                match (is_error, code) {
                    (true, Some(c)) => format!("Exit code {c}"),
                    (true, None) => format!("Command {status}"),
                    _ => String::new(),
                }
            } else {
                output
            };
            tool_pair(&mut out, &id, "Shell", ToolCategory::Shell, one_line(&cmd), None, result, is_error, ts, at);
        }
        "FileChange" | "fileChange" => {
            let err = item.get("stderr").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let changes: Vec<(String, Value)> = match item.get("changes") {
                Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                // camelCase form: [{path, kind, diff}]
                Some(Value::Array(a)) => a
                    .iter()
                    .map(|c| (c.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string(), c.clone()))
                    .collect(),
                _ => Vec::new(),
            };
            for (i, (path, ch)) in changes.iter().enumerate() {
                let kind = ch
                    .get("type")
                    .or_else(|| ch.get("kind").and_then(|k| k.get("type").or(Some(k))))
                    .and_then(|v| v.as_str())
                    .unwrap_or("update");
                let step = format!("{id}:{i}");
                let (name, edit, preview) = match kind {
                    "add" => (
                        "Write",
                        Some(json!({ "file_path": path, "content": ch.get("content").and_then(|v| v.as_str()).unwrap_or("") })),
                        path.clone(),
                    ),
                    "delete" => ("Delete", None, path.clone()),
                    _ => {
                        let diff = ch.get("unified_diff").or_else(|| ch.get("diff")).and_then(|v| v.as_str()).unwrap_or("");
                        let hunks = diff_hunks(diff);
                        let moved = ch.get("move_path").and_then(|v| v.as_str()).filter(|m| !m.is_empty());
                        let preview = match moved {
                            Some(to) => format!("{path} → {to}"),
                            None => path.clone(),
                        };
                        if hunks.len() > 1 {
                            let edits: Vec<Value> = hunks.iter().map(|(o, n)| json!({ "old_string": o, "new_string": n })).collect();
                            ("MultiEdit", Some(json!({ "file_path": path, "edits": edits })), preview)
                        } else if let Some((o, n)) = hunks.into_iter().next() {
                            ("Edit", Some(json!({ "file_path": path, "old_string": o, "new_string": n })), preview)
                        } else {
                            ("Edit", None, preview)
                        }
                    }
                };
                let result = if failed {
                    if err.trim().is_empty() { format!("Change {status}") } else { err.clone() }
                } else {
                    "Applied".to_string()
                };
                tool_pair(&mut out, &step, name, ToolCategory::FileWrite, preview, edit, result, failed, ts, at);
            }
        }
        "McpToolCall" | "mcpToolCall" => {
            let server = item.get("server").and_then(|v| v.as_str()).unwrap_or("mcp");
            let tool = item.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            let args = item.get("arguments").cloned().unwrap_or(Value::Null);
            let preview = match &args {
                Value::Object(m) => m.values().find_map(|v| v.as_str()).map(one_line).unwrap_or_default(),
                Value::String(s) => one_line(s),
                _ => String::new(),
            };
            let res = item.get("result");
            let mut is_error = failed || res.and_then(|r| r.get("isError")).and_then(|v| v.as_bool()).unwrap_or(false);
            let mut text = content_text(res.and_then(|r| r.get("content")));
            if let Some(e) = item.get("error").filter(|e| !e.is_null()) {
                is_error = true;
                if text.is_empty() {
                    text = e.as_str().map(String::from).or_else(|| e.get("message").and_then(|m| m.as_str()).map(String::from)).unwrap_or_else(|| e.to_string());
                }
            }
            let name = format!("mcp__{server}__{tool}");
            tool_pair(&mut out, &id, &name, ToolCategory::Mcp, preview, None, text, is_error, ts, at);
        }
        "WebSearch" | "webSearch" | "Extension" | "extension" => {
            let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("web.search");
            if (ty == "Extension" || ty == "extension") && kind != "web.search" {
                return out;
            }
            let query = item
                .get("query")
                .and_then(|v| v.as_str())
                .filter(|q| !q.is_empty())
                .map(String::from)
                .or_else(|| {
                    item.get("action").and_then(|a| {
                        a.get("query").and_then(|q| q.as_str()).map(String::from).or_else(|| {
                            a.get("queries").and_then(|q| q.as_array()).map(|qs| {
                                qs.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" · ")
                            })
                        })
                    })
                })
                .unwrap_or_default();
            let results = item
                .get("results")
                .and_then(|r| r.as_array())
                .map(|rs| {
                    rs.iter()
                        .map(|r| {
                            let t = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
                            let u = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            format!("{t} — {u}")
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            tool_pair(&mut out, &id, "WebSearch", ToolCategory::Web, one_line(&query), None, results, failed, ts, at);
        }
        "ImageView" | "imageView" => {
            let path = item.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
            tool_pair(&mut out, &id, "Read", ToolCategory::FileRead, path, None, "[image]".into(), false, ts, at);
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ic(item: &str) -> String {
        format!(r#"{{"timestamp":"2026-11-19T05:54:31.489Z","ordinal":5,"type":"event_msg","payload":{{"type":"item_completed","thread_id":"t","turn_id":"u","item":{item}}}}}"#)
    }

    #[test]
    fn user_and_agent_messages() {
        let u = parse_codex_line(&ic(r#"{"type":"UserMessage","id":"m1","content":[{"type":"text","text":"Fix the build","text_elements":[]}]}"#), 1);
        assert_eq!(u.messages.len(), 1);
        assert_eq!(u.messages[0].kind, MessageKind::User);
        assert_eq!(u.messages[0].text, "Fix the build");
        assert_eq!(u.messages[0].id, "m1-0");
        assert!(u.at.is_some());
        let a = parse_codex_line(&ic(r#"{"type":"AgentMessage","id":"m2","content":[{"type":"Text","text":"Shall I commit?"}],"phase":"final_answer"}"#), 2);
        assert_eq!(a.messages[0].kind, MessageKind::Question);
        assert_eq!(a.messages[0].role, "assistant");
    }

    #[test]
    fn command_becomes_shell_step() {
        let l = parse_codex_line(&ic(r#"{"type":"CommandExecution","id":"exec-1","command":["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe","-Command","echo hello"],"parsed_cmd":[{"type":"unknown","cmd":"echo hello"}],"status":"completed","aggregated_output":"hello\r\n","exit_code":0}"#), 3);
        assert_eq!(l.messages.len(), 2);
        assert_eq!(l.messages[0].kind, MessageKind::ToolCall);
        assert_eq!(l.messages[0].text, "echo hello");
        assert_eq!(l.messages[0].tool_category, Some(ToolCategory::Shell));
        assert_eq!(l.messages[1].kind, MessageKind::ToolResult);
        assert_eq!(l.messages[1].tool_use_id.as_deref(), Some("exec-1"));
        let f = parse_codex_line(&ic(r#"{"type":"CommandExecution","id":"exec-2","command":["bash","-lc","false"],"status":"failed","aggregated_output":"","exit_code":1}"#), 4);
        assert_eq!(f.messages[0].text, "false");
        assert_eq!(f.messages[1].kind, MessageKind::Error);
        assert_eq!(f.messages[1].text, "Exit code 1");
    }

    #[test]
    fn file_changes_render_as_edits() {
        let l = parse_codex_line(&ic(r#"{"type":"FileChange","id":"fc","status":"completed","changes":{"a.txt":{"type":"add","content":"one\n"},"b.txt":{"type":"update","unified_diff":"@@ -1,2 +1,2 @@\n keep\n-old\n+new\n@@ -9 +9 @@\n-x\n+y\n","move_path":null}}}"#), 5);
        let calls: Vec<_> = l.messages.iter().filter(|m| m.kind == MessageKind::ToolCall).collect();
        assert_eq!(calls.len(), 2);
        let add = calls.iter().find(|m| m.text == "a.txt").unwrap();
        assert_eq!(add.tool_name.as_deref(), Some("Write"));
        assert_eq!(add.edit_data.as_ref().unwrap()["content"], "one\n");
        let upd = calls.iter().find(|m| m.text == "b.txt").unwrap();
        assert_eq!(upd.tool_name.as_deref(), Some("MultiEdit"));
        let edits = upd.edit_data.as_ref().unwrap()["edits"].as_array().unwrap().clone();
        assert_eq!(edits[0]["old_string"], "keep\nold\n");
        assert_eq!(edits[0]["new_string"], "keep\nnew\n");
        assert_eq!(edits[1]["new_string"], "y\n");
        assert!(l.messages.iter().all(|m| m.tool_category == Some(ToolCategory::FileWrite) || m.kind == MessageKind::ToolResult));
    }

    #[test]
    fn single_hunk_is_a_plain_edit() {
        assert_eq!(diff_hunks("@@ -1 +1 @@\n-a\n+b\n"), vec![("a\n".to_string(), "b\n".to_string())]);
    }

    #[test]
    fn empty_reasoning_is_skipped() {
        let l = parse_codex_line(&ic(r#"{"type":"Reasoning","id":"r","summary_text":[],"raw_content":[]}"#), 6);
        assert!(l.messages.is_empty());
        let l = parse_codex_line(&ic(r#"{"type":"Reasoning","id":"r","summary_text":["Checking the config"],"raw_content":[]}"#), 6);
        assert_eq!(l.messages[0].kind, MessageKind::Thinking);
    }

    #[test]
    fn mcp_and_web_search() {
        let m = parse_codex_line(&ic(r#"{"type":"McpToolCall","id":"c1","server":"browser","tool":"navigate","arguments":{"url":"https://x.test"},"status":"completed","result":{"content":[{"type":"text","text":"ok"}],"isError":false}}"#), 7);
        assert_eq!(m.messages[0].tool_name.as_deref(), Some("mcp__browser__navigate"));
        assert_eq!(m.messages[0].text, "https://x.test");
        assert_eq!(m.messages[1].text, "ok");
        let w = parse_codex_line(&ic(r#"{"type":"Extension","kind":"web.search","id":"w1","query":"","action":{"type":"search","query":null,"queries":["tauri zoom"]},"results":[{"title":"Docs","url":"https://t.test"}]}"#), 8);
        assert_eq!(w.messages[0].text, "tauri zoom");
        assert_eq!(w.messages[1].text, "Docs — https://t.test");
    }

    #[test]
    fn turn_and_usage_events() {
        let s = parse_codex_line(r#"{"timestamp":"2026-11-19T05:54:24.595Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t","model_context_window":475000}}"#, 1);
        assert_eq!(s.turn_open, Some(true));
        assert_eq!(s.context_window, Some(475000));
        let e = parse_codex_line(r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t"}}"#, 1);
        assert_eq!(e.turn_open, Some(false));
        let t = parse_codex_line(r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":60,"cache_write_input_tokens":0,"output_tokens":7},"last_token_usage":{"input_tokens":50,"output_tokens":5},"model_context_window":475000},"rate_limits":{"primary":{"used_percent":12.0,"window_minutes":300,"resets_at":1}}}}"#, 1);
        assert_eq!(t.usage, Some(CodexUsage { input: 40, output: 7, cache_read: 60, cache_creation: 0 }));
        assert_eq!(t.context_tokens, Some(55));
        assert!(t.rate_limits.is_some());
        let n = parse_codex_line(r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}"#, 1);
        assert!(n.usage.is_none() && n.rate_limits.is_none());
    }

    #[test]
    fn session_meta_and_ignored_lines() {
        let m = parse_codex_line(r#"{"timestamp":"2026-11-19T05:54:24.189Z","type":"session_meta","payload":{"id":"01a1","cwd":"\\\\?\\D:\\Proj","source":"cli"}}"#, 1);
        let meta = m.meta.unwrap();
        assert_eq!(meta.id, "01a1");
        assert_eq!(meta.cwd, r"D:\Proj");
        assert_eq!(meta.source, "cli");
        // Raw model input (with injected instructions) never shows as a message.
        let r = parse_codex_line(r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>"}]}}"#, 1);
        assert!(r.messages.is_empty());
        assert!(parse_codex_line("not json", 1).messages.is_empty());
    }
    /// Turn a rollout into the reader's messages (for the preview harness):
    /// CODEX_ROLLOUT=in.jsonl CODEX_OUT=out.json cargo test rollout_to_fixture -- --ignored
    #[test]
    #[ignore]
    fn rollout_to_fixture() {
        let (Ok(inp), Ok(out)) = (std::env::var("CODEX_ROLLOUT"), std::env::var("CODEX_OUT")) else { return };
        let text = std::fs::read_to_string(inp).unwrap();
        let msgs: Vec<Message> = text.lines().enumerate().flat_map(|(i, l)| parse_codex_line(l, i as i64).messages).collect();
        std::fs::write(out, serde_json::to_string_pretty(&msgs).unwrap()).unwrap();
    }
}
