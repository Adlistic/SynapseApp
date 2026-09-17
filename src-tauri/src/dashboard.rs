//! Mission Control — per-session dashboard stats.
//!
//! The transcript tailer already serde-parses every appended line once (for
//! token usage); this module piggybacks on that same pass to accumulate the
//! richer signals the dashboard shows — real timestamps, per-model usage,
//! subagent (Task) spawns, the latest TodoWrite checklist, files touched,
//! context size, and an activity ring for sparklines. No extra file I/O ever.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use synapse_core::types::{Message, MessageKind, ToolCategory};

/// Token usage attributed to one model id (for cost estimation).
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

/// One subagent run, spawned via the Task/Agent tool. `done` flips when the
/// matching tool_result lands (the parent turn resumed).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub name: String,
    pub agent_type: String,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub done: bool,
}

/// One item of the session's most recent TodoWrite checklist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: String,
    pub active_form: String,
}

/// Everything the dashboard shows for one session. Accumulated incrementally —
/// each field is either monotonic (counters, sets) or "latest wins" (todos,
/// context, last activity), so replaying a whole transcript on resume yields
/// the same result as tailing it live.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashStats {
    pub first_ts_ms: i64,
    pub last_ts_ms: i64,
    /// Human prompts (main chain only).
    pub turns: u64,
    pub tool_calls: u64,
    /// Tool calls made inside subagent sidechains.
    pub sidechain_calls: u64,
    pub tool_errors: u64,
    /// Tool calls by display category (main chain), for the mix bar.
    pub by_category: HashMap<String, u64>,
    /// Usage per model id — the frontend prices these.
    pub models: HashMap<String, ModelUsage>,
    /// Model of the latest main-chain assistant message.
    pub last_model: String,
    /// input + cache tokens of the latest main-chain assistant message ≈ how
    /// full the context window currently is.
    pub context_tokens: u64,
    /// Kind + one-line preview of the newest transcript activity.
    pub last_kind: String,
    pub last_activity: String,
    /// Distinct file paths touched by write tools.
    pub files: Vec<String>,
    pub todos: Vec<TodoItem>,
    pub agents: Vec<AgentRun>,
    /// Entry timestamps (ms), newest last, capped — the activity sparkline.
    pub recent_events: Vec<i64>,
}

const RECENT_CAP: usize = 600;
const FILES_CAP: usize = 400;
const AGENTS_CAP: usize = 200;

/// Fold one transcript entry (raw JSON + its parsed messages) into the stats.
pub fn update_stats(stats: &mut DashStats, entry: &Value, msgs: &[Message]) {
    let sidechain = entry
        .get("isSidechain")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let ts = entry
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(iso_to_ms)
        .unwrap_or(stats.last_ts_ms);

    if ts > 0 {
        if stats.first_ts_ms == 0 {
            stats.first_ts_ms = ts;
        }
        if ts > stats.last_ts_ms {
            stats.last_ts_ms = ts;
        }
        // Only entries that produced visible messages count as "activity";
        // bookkeeping lines (snapshots, meta) would fake a busy sparkline.
        if !msgs.is_empty() {
            stats.recent_events.push(ts);
            if stats.recent_events.len() > RECENT_CAP {
                let n = stats.recent_events.len() - RECENT_CAP;
                stats.recent_events.drain(..n);
            }
        }
    }

    let message = entry.get("message");
    let entry_type = entry.get("type").and_then(|v| v.as_str()).unwrap_or("");

    // Per-model usage + context gauge.
    if let Some(m) = message {
        if let Some(model) = m.get("model").and_then(|v| v.as_str()) {
            if !sidechain {
                stats.last_model = model.to_string();
            }
            if let Some(u) = m.get("usage") {
                let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let e = stats.models.entry(model.to_string()).or_default();
                e.input += g("input_tokens");
                e.output += g("output_tokens");
                e.cache_read += g("cache_read_input_tokens");
                e.cache_creation += g("cache_creation_input_tokens");
                if !sidechain && entry_type == "assistant" {
                    let ctx = g("input_tokens") + g("cache_read_input_tokens") + g("cache_creation_input_tokens");
                    if ctx > 0 {
                        stats.context_tokens = ctx;
                    }
                }
            }
        }
    }

    // Raw content blocks: TodoWrite checklists, Task spawns, Task completions.
    // (parse_line keeps previews but drops most tool inputs, so read them here.)
    if let Some(blocks) = message.and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        for b in blocks {
            match b.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "tool_use" => {
                    let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let input = b.get("input");
                    if name == "TodoWrite" {
                        if let Some(items) = input.and_then(|i| i.get("todos")).and_then(|t| t.as_array()) {
                            let s = |it: &Value, k: &str| {
                                it.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
                            };
                            stats.todos = items
                                .iter()
                                .map(|it| TodoItem {
                                    content: s(it, "content"),
                                    status: s(it, "status"),
                                    active_form: s(it, "activeForm"),
                                })
                                .collect();
                        }
                    } else if (name == "Task" || name == "Agent") && !sidechain {
                        let pick = |k: &str| {
                            input.and_then(|i| i.get(k)).and_then(|v| v.as_str()).map(String::from)
                        };
                        let label = pick("description")
                            .or_else(|| pick("subject"))
                            .or_else(|| pick("prompt").map(|p| p.chars().take(80).collect()))
                            .unwrap_or_else(|| "subagent".into());
                        if stats.agents.len() >= AGENTS_CAP {
                            if let Some(i) = stats.agents.iter().position(|a| a.done) {
                                stats.agents.remove(i);
                            } else {
                                stats.agents.remove(0);
                            }
                        }
                        stats.agents.push(AgentRun {
                            id: b.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            name: label,
                            agent_type: pick("subagent_type").unwrap_or_default(),
                            started_ms: ts,
                            ended_ms: None,
                            done: false,
                        });
                    }
                }
                "tool_result" => {
                    if let Some(id) = b.get("tool_use_id").and_then(|v| v.as_str()) {
                        if let Some(a) = stats.agents.iter_mut().find(|a| a.id == id && !a.done) {
                            a.done = true;
                            a.ended_ms = Some(ts);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // Counters + "now" line from the already-parsed messages.
    let mut counted_turn = false;
    for m in msgs {
        match m.kind {
            MessageKind::User => {
                if !sidechain && !counted_turn {
                    stats.turns += 1;
                    counted_turn = true;
                }
            }
            MessageKind::ToolCall => {
                if sidechain {
                    stats.sidechain_calls += 1;
                } else {
                    stats.tool_calls += 1;
                    let cat = m.tool_category.unwrap_or(ToolCategory::Other);
                    *stats.by_category.entry(cat.as_str().to_string()).or_insert(0) += 1;
                }
                if m.tool_category == Some(ToolCategory::FileWrite)
                    && !m.text.is_empty()
                    && stats.files.len() < FILES_CAP
                    && !stats.files.contains(&m.text)
                {
                    stats.files.push(m.text.clone());
                }
            }
            MessageKind::Error => stats.tool_errors += 1,
            _ => {}
        }
    }
    if let Some(m) = msgs.last() {
        stats.last_kind = m.kind.as_str().to_string();
        let head: String = m.text.replace('\n', " ").chars().take(140).collect();
        stats.last_activity = match m.kind {
            MessageKind::ToolCall | MessageKind::ToolResult | MessageKind::Error => {
                let tool = m.tool_name.clone().unwrap_or_default();
                let joined = if tool.is_empty() { head } else { format!("{tool} · {head}") };
                if sidechain { format!("⑂ {joined}") } else { joined }
            }
            MessageKind::Thinking => "thinking…".to_string(),
            _ => head,
        };
    }
}

/// Parse an RFC3339 UTC timestamp ("2026-09-16T13:50:44.991Z") to epoch ms.
/// The CLI writes UTC with a Z suffix only, so no zone math is needed; anything
/// unexpected returns None and the caller falls back to the previous timestamp.
fn iso_to_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // Days since 1970-01-01 (Howard Hinnant's civil-days algorithm).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut ms = (days * 86_400 + h * 3_600 + mi * 60 + sec) * 1_000;
    // Optional fractional seconds: take up to the first 3 digits after '.'.
    if b.get(19) == Some(&b'.') {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).collect();
        let digits = frac.len().min(3);
        if digits > 0 {
            let v = frac[..digits].parse::<i64>().unwrap_or(0);
            ms += v * 10_i64.pow(3 - digits as u32);
        }
    }
    Some(ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use synapse_core::transcript::parse_line;

    #[test]
    fn iso_parses_known_epochs() {
        assert_eq!(iso_to_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_to_ms("2020-01-01T00:00:00Z"), Some(1_577_836_800_000));
        assert_eq!(iso_to_ms("2020-01-01T00:00:00.250Z"), Some(1_577_836_800_250));
        // Leap-year day.
        assert_eq!(iso_to_ms("2024-02-29T12:00:00Z"), Some(1_709_208_000_000));
        assert_eq!(iso_to_ms("not a date"), None);
    }

    fn feed(stats: &mut DashStats, line: &str) {
        let msgs = parse_line(line, 1, None);
        let v: Value = serde_json::from_str(line).unwrap();
        update_stats(stats, &v, &msgs);
    }

    #[test]
    fn accumulates_turns_tools_and_todos() {
        let mut s = DashStats::default();
        feed(&mut s, r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"do the thing"}}"#);
        feed(&mut s, r#"{"type":"assistant","timestamp":"2026-01-01T00:00:05Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":1000},"content":[
            {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}},
            {"type":"tool_use","id":"t2","name":"TodoWrite","input":{"todos":[{"content":"a","status":"completed","activeForm":"Doing a"},{"content":"b","status":"in_progress","activeForm":"Doing b"}]}}
        ]}}"#);
        assert_eq!(s.turns, 1);
        assert_eq!(s.tool_calls, 2);
        assert_eq!(s.todos.len(), 2);
        assert_eq!(s.todos[1].status, "in_progress");
        assert_eq!(s.last_model, "claude-sonnet-5");
        assert_eq!(s.context_tokens, 1010);
        assert!(s.models.contains_key("claude-sonnet-5"));
        assert_eq!(s.first_ts_ms, 1_767_225_600_000);
        assert_eq!(s.last_ts_ms, 1_767_225_605_000);
    }

    #[test]
    fn tracks_agent_lifecycle() {
        let mut s = DashStats::default();
        feed(&mut s, r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"task1","name":"Task","input":{"description":"explore auth","subagent_type":"Explore"}}
        ]}}"#);
        assert_eq!(s.agents.len(), 1);
        assert!(!s.agents[0].done);
        assert_eq!(s.agents[0].name, "explore auth");
        // Sidechain work is counted separately.
        feed(&mut s, r#"{"type":"assistant","isSidechain":true,"timestamp":"2026-01-01T00:00:10Z","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"sc1","name":"Grep","input":{"pattern":"login"}}
        ]}}"#);
        assert_eq!(s.tool_calls, 1); // Task itself
        assert_eq!(s.sidechain_calls, 1);
        // The Task result closes the agent.
        feed(&mut s, r#"{"type":"user","timestamp":"2026-01-01T00:01:00Z","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"task1","content":"found it"}
        ]}}"#);
        assert!(s.agents[0].done);
        assert_eq!(s.agents[0].ended_ms, Some(1_767_225_660_000));
        // A tool_result entry is not a human turn.
        assert_eq!(s.turns, 0);
    }

    #[test]
    fn files_dedupe_and_last_activity() {
        let mut s = DashStats::default();
        let edit = r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"src/a.rs","old_string":"x","new_string":"y"}}
        ]}}"#;
        feed(&mut s, edit);
        feed(&mut s, edit);
        assert_eq!(s.files, vec!["src/a.rs".to_string()]);
        assert_eq!(s.last_kind, "toolcall");
        assert!(s.last_activity.contains("Edit"));
    }
}
