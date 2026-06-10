//! Claude Code session store browser — scans `~/.claude/projects/**/*.jsonl`
//! (the CLI's own transcript store) so Synapse can list every session on this
//! machine, search across them, and resume one. Read-only.

use serde::Serialize;
use std::io::BufRead;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    pub path: String,
    /// First user prompt or the CLI's summary line.
    pub title: String,
    /// The folder the session ran in (from the transcript's `cwd`).
    pub cwd: String,
    pub modified_ms: i64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessions {
    pub dir: String,
    pub cwd: String,
    pub sessions: Vec<SessionMeta>,
}

/// Read the head of a transcript for a title (summary or first user prompt)
/// and the project cwd, without parsing the whole file.
fn head_info(path: &Path) -> (String, String) {
    let mut title = String::new();
    let mut cwd = String::new();
    let Ok(f) = std::fs::File::open(path) else {
        return (title, cwd);
    };
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok).take(40) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                cwd = c.to_string();
            }
        }
        if title.is_empty() {
            if let Some(s) = v.get("summary").and_then(|s| s.as_str()) {
                title = s.to_string();
            } else if v.get("type").and_then(|t| t.as_str()) == Some("user") {
                let content = v.get("message").and_then(|m| m.get("content"));
                let text = match content {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Array(blocks)) => blocks
                        .iter()
                        .find_map(|b| {
                            (b.get("type").and_then(|t| t.as_str()) == Some("text"))
                                .then(|| b.get("text").and_then(|t| t.as_str()).unwrap_or(""))
                        })
                        .unwrap_or("")
                        .to_string(),
                    _ => String::new(),
                };
                let text = text.trim();
                if !text.is_empty() && !text.starts_with('<') {
                    title = text.chars().take(120).collect();
                }
            }
        }
        if !title.is_empty() && !cwd.is_empty() {
            break;
        }
    }
    (title, cwd)
}

fn meta_for(p: &Path) -> Option<SessionMeta> {
    let fs_meta = std::fs::metadata(p).ok()?;
    let modified_ms = fs_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let (title, cwd) = head_info(p);
    Some(SessionMeta {
        session_id: p.file_stem()?.to_string_lossy().to_string(),
        path: p.to_string_lossy().to_string(),
        title: if title.is_empty() { "(untitled session)".into() } else { title },
        cwd,
        modified_ms,
        size_bytes: fs_meta.len(),
    })
}

/// All sessions on this machine, grouped by project, newest activity first.
#[tauri::command]
pub fn list_claude_sessions() -> Vec<ProjectSessions> {
    let Some(root) = crate::claude_projects_dir() else { return Vec::new() };
    let Ok(projects) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out: Vec<ProjectSessions> = Vec::new();
    for proj in projects.filter_map(|e| e.ok()) {
        if !proj.path().is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(proj.path()) else { continue };
        let mut sessions: Vec<SessionMeta> = files
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
            .filter_map(|p| meta_for(&p))
            .collect();
        if sessions.is_empty() {
            continue;
        }
        sessions.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        let cwd = sessions
            .iter()
            .find(|s| !s.cwd.is_empty())
            .map(|s| s.cwd.clone())
            .unwrap_or_default();
        out.push(ProjectSessions {
            dir: proj.file_name().to_string_lossy().to_string(),
            cwd,
            sessions,
        });
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.sessions.first().map(|s| s.modified_ms).unwrap_or(0)));
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(flatten)]
    pub meta: SessionMeta,
    /// First matching line's text (trimmed for display).
    pub snippet: String,
    pub match_count: usize,
}

/// Case-insensitive text search across every transcript. Capped so a huge
/// store can't wedge the UI: max 50 sessions returned, files > 25 MB skipped.
#[tauri::command]
pub fn search_sessions(query: String) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Vec::new();
    }
    let Some(root) = crate::claude_projects_dir() else { return Vec::new() };
    let Ok(projects) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut hits: Vec<SearchHit> = Vec::new();
    'outer: for proj in projects.filter_map(|e| e.ok()) {
        let Ok(files) = std::fs::read_dir(proj.path()) else { continue };
        for f in files.filter_map(|e| e.ok()) {
            let p = f.path();
            if p.extension().map(|x| x != "jsonl").unwrap_or(true) {
                continue;
            }
            if f.metadata().map(|m| m.len() > 25_000_000).unwrap_or(true) {
                continue;
            }
            let Ok(file) = std::fs::File::open(&p) else { continue };
            let mut snippet = String::new();
            let mut count = 0usize;
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                // Cheap pre-filter on the raw line before extracting text.
                if !line.to_lowercase().contains(&q) {
                    continue;
                }
                count += 1;
                if snippet.is_empty() {
                    // Pull a readable snippet out of the matching entry's text.
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        let text = match v.get("message").and_then(|m| m.get("content")) {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(serde_json::Value::Array(blocks)) => blocks
                                .iter()
                                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join(" "),
                            _ => String::new(),
                        };
                        let lower = text.to_lowercase();
                        if let Some(i) = lower.find(&q) {
                            let start = i.saturating_sub(60);
                            // char-boundary-safe slice
                            let s = text
                                .char_indices()
                                .skip_while(|(bi, _)| *bi < start)
                                .map(|(_, c)| c)
                                .take(160)
                                .collect::<String>();
                            snippet = s.trim().to_string();
                        }
                    }
                }
            }
            if count > 0 {
                if let Some(meta) = meta_for(&p) {
                    hits.push(SearchHit { meta, snippet, match_count: count });
                    if hits.len() >= 50 {
                        break 'outer;
                    }
                }
            }
        }
    }
    hits.sort_by(|a, b| b.meta.modified_ms.cmp(&a.meta.modified_ms));
    hits
}
