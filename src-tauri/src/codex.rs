//! OpenAI Codex CLI support: finding its session files, listing and searching
//! them for the session browser, and telling whether Codex / Claude Code are
//! installed. Parsing a rollout line lives in `synapse_core::codex`.
//!
//! Codex keeps one file per session at
//! `~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl`
//! (`CODEX_HOME` moves `~/.codex`). It writes the file in plain JSONL while
//! the session is in use and compresses it to `.jsonl.zst` later. The file
//! appears only once the first prompt is sent, and Codex has no flag to choose
//! a session id up front, so a new session is found by watching for a fresh
//! rollout in the session's folder (see [`discover`]).

use crate::sessions::{ProjectSessions, SearchHit, SessionMeta};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use synapse_core::codex::{clean_path, parse_codex_line};

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// `~/.codex`, or `CODEX_HOME` when set.
pub fn codex_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("CODEX_HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(h));
    }
    Some(home()?.join(".codex"))
}

fn sessions_dir() -> Option<PathBuf> {
    Some(codex_home()?.join("sessions"))
}

/// Compare folders the way Windows does: case-insensitive, either slash, no
/// trailing separator, no `\\?\` prefix.
pub fn norm_dir(p: &str) -> String {
    clean_path(p.trim()).replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn is_rollout(p: &Path) -> bool {
    let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    n.starts_with("rollout-") && (n.ends_with(".jsonl") || n.ends_with(".jsonl.zst"))
}

pub fn is_zst(p: &Path) -> bool {
    p.extension().map(|x| x == "zst").unwrap_or(false)
}

/// The session id from a rollout file name (the uuid at the end).
fn id_from_name(p: &Path) -> Option<String> {
    let n = p.file_name()?.to_str()?;
    let stem = n.strip_suffix(".jsonl.zst").or_else(|| n.strip_suffix(".jsonl"))?;
    // rollout-YYYY-MM-DDTHH-MM-SS-<8>-<4>-<4>-<4>-<12>
    let parts: Vec<&str> = stem.rsplitn(6, '-').collect();
    if parts.len() < 6 {
        return None;
    }
    let id = format!("{}-{}-{}-{}-{}", parts[4], parts[3], parts[2], parts[1], parts[0]);
    (id.len() == 36).then_some(id)
}

/// Day folders, newest first (`sessions/YYYY/MM/DD`).
fn day_dirs() -> Vec<PathBuf> {
    let Some(root) = sessions_dir() else { return Vec::new() };
    let sorted = |d: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(d)
            .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
            .unwrap_or_default();
        v.sort();
        v.reverse();
        v
    };
    let mut out = Vec::new();
    for y in sorted(&root) {
        for m in sorted(&y) {
            out.extend(sorted(&m));
        }
    }
    out
}

fn rollouts_in(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|r| r.flatten().map(|e| e.path()).filter(|p| is_rollout(p)).collect())
        .unwrap_or_default()
}

/// A session's rollout file by id. The plain file wins over the compressed
/// one (the plain one is the one being written).
pub fn find_rollout(session_id: &str) -> Option<PathBuf> {
    let mut zst = None;
    for d in day_dirs() {
        for p in rollouts_in(&d) {
            if id_from_name(&p).as_deref() == Some(session_id) {
                if !is_zst(&p) {
                    return Some(p);
                }
                zst = Some(p);
            }
        }
        if zst.is_some() {
            break;
        }
    }
    zst
}

/// The first `n` lines of a rollout, decompressing if needed (only as far as
/// those lines, so a large session costs little to list).
fn head_lines(p: &Path, n: usize) -> Vec<String> {
    let Ok(f) = std::fs::File::open(p) else { return Vec::new() };
    let reader: Box<dyn Read> = if is_zst(p) {
        match ruzstd::decoding::StreamingDecoder::new(BufReader::new(f)) {
            Ok(d) => Box::new(d),
            Err(_) => return Vec::new(),
        }
    } else {
        Box::new(f)
    };
    // Capped in bytes too, so a file with no line breaks can't be read whole.
    BufReader::new(reader.take(16 * 1024 * 1024)).lines().map_while(Result::ok).take(n).collect()
}

/// A whole compressed rollout as text (every zstd frame). Capped so a damaged
/// or enormous file can't take the app down.
pub fn read_zst(p: &Path) -> Option<String> {
    let meta = std::fs::metadata(p).ok()?;
    if meta.len() > 64 * 1024 * 1024 {
        return None;
    }
    let raw = std::fs::read(p).ok()?;
    let mut src: &[u8] = &raw;
    let mut out = Vec::new();
    // Capped while decompressing (a tiny file can expand enormously).
    const CAP: usize = 128 * 1024 * 1024;
    while !src.is_empty() {
        let dec = ruzstd::decoding::StreamingDecoder::new(&mut src).ok()?;
        let room = (CAP - out.len()) as u64 + 1;
        dec.take(room).read_to_end(&mut out).ok()?;
        if out.len() > CAP {
            return None;
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Find the rollout a just-launched `codex` created: in `cwd`, started no
/// earlier than `since_ms` (a little slack for clock rounding), and not one
/// another tab already follows. Only today's and yesterday's folders are
/// looked at (local-date folders, so both cover midnight).
pub fn discover(cwd_norm: &str, since_ms: i64, claimed: &HashSet<PathBuf>) -> Option<(String, PathBuf)> {
    let mut best: Option<(i64, String, PathBuf)> = None;
    for d in day_dirs().into_iter().take(2) {
        for p in rollouts_in(&d) {
            if is_zst(&p) || claimed.contains(&p) {
                continue;
            }
            let modified = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            if modified < since_ms - 5_000 {
                continue;
            }
            let Some(first) = head_lines(&p, 1).into_iter().next() else { continue };
            let Some(meta) = parse_codex_line(&first, 0).meta else { continue };
            let started = meta.started_ms.unwrap_or(modified);
            // Only sessions from the terminal app (what this tab launched):
            // not `codex exec`, the editor extension or the desktop app.
            let terminal = meta.originator == "codex-tui" || (meta.originator.is_empty() && meta.source == "cli");
            if started < since_ms - 5_000 || norm_dir(&meta.cwd) != cwd_norm || !terminal {
                continue;
            }
            let id = if meta.id.is_empty() { id_from_name(&p).unwrap_or_default() } else { meta.id };
            if id.is_empty() {
                continue;
            }
            // The earliest match is ours; a later one belongs to a newer launch.
            if best.as_ref().map(|b| started < b.0).unwrap_or(true) {
                best = Some((started, id, p));
            }
        }
    }
    best.map(|(_, id, p)| (id, p))
}

/// Codex's own session names (`session_index.jsonl`: {id, thread_name}).
fn thread_names() -> HashMap<String, String> {
    let mut m = HashMap::new();
    let Some(p) = codex_home().map(|h| h.join("session_index.jsonl")) else { return m };
    let Ok(f) = std::fs::File::open(p) else { return m };
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if let (Some(id), Some(name)) = (v.get("id").and_then(|x| x.as_str()), v.get("thread_name").and_then(|x| x.as_str())) {
                if !name.trim().is_empty() {
                    m.insert(id.to_string(), name.to_string());
                }
            }
        }
    }
    m
}

fn meta_for(p: &Path, names: &HashMap<String, String>) -> Option<SessionMeta> {
    let fs_meta = std::fs::metadata(p).ok()?;
    let modified_ms = fs_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut id = id_from_name(p)?;
    let mut cwd = String::new();
    let mut first_prompt = String::new();
    for (i, line) in head_lines(p, 120).iter().enumerate() {
        let l = parse_codex_line(line, i as i64);
        if let Some(m) = l.meta {
            if !m.id.is_empty() {
                id = m.id;
            }
            cwd = m.cwd;
        }
        if first_prompt.is_empty() {
            if let Some(u) = l.messages.iter().find(|m| m.role == "user" && !m.text.trim().is_empty()) {
                first_prompt = u.text.trim().chars().take(120).collect();
                break;
            }
        }
    }
    let title = names.get(&id).cloned().unwrap_or(first_prompt);
    Some(SessionMeta {
        session_id: id,
        path: p.to_string_lossy().to_string(),
        title: if title.is_empty() { "(untitled session)".into() } else { title },
        cwd,
        modified_ms,
        size_bytes: fs_meta.len(),
        agent: "codex",
    })
}

/// Every Codex session file, newest first; a session that exists both plain
/// and compressed is listed once (the plain copy).
fn all_rollouts() -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for d in day_dirs() {
        let mut files = rollouts_in(&d);
        files.sort_by_key(|p| is_zst(p)); // plain first
        for p in files {
            if let Some(id) = id_from_name(&p) {
                if seen.insert(id) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Codex sessions grouped by folder, newest activity first.
pub fn list_sessions() -> Vec<ProjectSessions> {
    let names = thread_names();
    let mut by: HashMap<String, ProjectSessions> = HashMap::new();
    for p in all_rollouts() {
        let Some(m) = meta_for(&p, &names) else { continue };
        let key = norm_dir(&m.cwd);
        by.entry(key.clone())
            .or_insert_with(|| ProjectSessions { dir: format!("codex:{key}"), cwd: m.cwd.clone(), sessions: Vec::new() })
            .sessions
            .push(m);
    }
    let mut out: Vec<ProjectSessions> = by.into_values().collect();
    for g in &mut out {
        g.sessions.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    }
    out
}

/// Case-insensitive search across Codex sessions (what was said and done,
/// not the raw model input). `limit` caps the hits.
pub fn search(q: &str, limit: usize) -> Vec<SearchHit> {
    let names = thread_names();
    let mut hits = Vec::new();
    for p in all_rollouts() {
        if hits.len() >= limit {
            break;
        }
        let text = if is_zst(&p) {
            match read_zst(&p) {
                Some(t) => t,
                None => continue,
            }
        } else {
            if std::fs::metadata(&p).map(|m| m.len() > 25_000_000).unwrap_or(true) {
                continue;
            }
            match std::fs::read_to_string(&p) {
                Ok(t) => t,
                Err(_) => continue,
            }
        };
        let mut count = 0usize;
        let mut snippet = String::new();
        for (i, line) in text.lines().enumerate() {
            if !line.contains("item_completed") || !line.to_lowercase().contains(q) {
                continue;
            }
            for m in parse_codex_line(line, i as i64).messages {
                let lower = m.text.to_lowercase();
                if let Some(at) = lower.find(q) {
                    count += 1;
                    if snippet.is_empty() {
                        let start = at.saturating_sub(60);
                        snippet = m
                            .text
                            .char_indices()
                            .skip_while(|(bi, _)| *bi < start)
                            .map(|(_, c)| c)
                            .take(160)
                            .collect::<String>()
                            .trim()
                            .to_string();
                    }
                }
            }
        }
        if count > 0 {
            if let Some(meta) = meta_for(&p, &names) {
                hits.push(SearchHit { meta, snippet, match_count: count });
            }
        }
    }
    hits
}

// ── Is Claude Code / Codex installed? ─────────────────────────────────────

fn exe_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        ["exe", "cmd", "bat", "ps1"].iter().map(|e| format!("{name}.{e}")).collect()
    } else {
        vec![name.to_string()]
    }
}

fn first_existing(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    let names = exe_names(name);
    for d in dirs {
        for n in &names {
            let p = d.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Where each CLI's installers put it, beyond PATH. The app may be started
/// with a shorter PATH than the user's terminal (from the Start menu, or a
/// Node version manager that only sets PATH inside a shell), so PATH alone
/// would call an installed tool missing.
fn known_dirs(name: &str) -> Vec<PathBuf> {
    let mut v = Vec::new();
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let h = home();
    if let Some(h) = &h {
        v.push(h.join(".local").join("bin"));
        v.push(h.join(".bun").join("bin"));
        v.push(h.join("scoop").join("shims"));
        v.push(h.join(".npm-global").join("bin"));
        if name == "claude" {
            v.push(h.join(".claude").join("local"));
        }
    }
    if let Some(a) = env("APPDATA") {
        v.push(a.join("npm"));
        // fnm (Node version manager): every installed Node's global bin.
        let fnm = env("FNM_DIR").unwrap_or_else(|| a.join("fnm"));
        if let Ok(rd) = std::fs::read_dir(fnm.join("node-versions")) {
            for e in rd.flatten() {
                v.push(e.path().join("installation"));
            }
        }
    }
    if let Some(nvm) = env("NVM_HOME").or_else(|| env("APPDATA").map(|a| a.join("nvm"))) {
        if let Ok(rd) = std::fs::read_dir(&nvm) {
            for e in rd.flatten() {
                v.push(e.path());
            }
        }
    }
    if let Some(l) = env("LOCALAPPDATA") {
        v.push(l.join("Microsoft").join("WinGet").join("Links"));
        v.push(l.join("Volta").join("bin"));
        if name == "codex" {
            v.push(l.join("Programs").join("OpenAI").join("Codex").join("bin"));
        }
    }
    if let Some(p) = env("ProgramFiles") {
        v.push(p.join("nodejs"));
    }
    if !cfg!(windows) {
        v.push(PathBuf::from("/usr/local/bin"));
        v.push(PathBuf::from("/opt/homebrew/bin"));
    }
    v
}

fn probe(name: &str, config_dir: Option<PathBuf>) -> Value {
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let found = first_existing(&path_dirs, name).or_else(|| first_existing(&known_dirs(name), name));
    let used = config_dir.map(|d| d.is_dir()).unwrap_or(false);
    json!({
        "installed": found.is_some(),
        "path": found.map(|p| p.to_string_lossy().to_string()),
        // Its settings folder exists: it has been used on this PC, so the
        // command may well work in a terminal even if we can't see it.
        "used": used,
    })
}

/// Which coding agents this PC has. Cheap (a few file checks), so the
/// new-session screen asks every time it opens.
#[tauri::command]
pub async fn agent_status() -> Value {
    json!({
        "claude": probe("claude", home().map(|h| h.join(".claude"))),
        "codex": probe("codex", codex_home()),
    })
}

#[tauri::command]
pub async fn list_codex_sessions() -> Vec<ProjectSessions> {
    list_sessions()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_from_file_names() {
        let p = Path::new("rollout-2026-11-19T07-54-24-01a1f25e-d2e7-74e3-a450-7be1e49f2014.jsonl");
        assert_eq!(id_from_name(p).as_deref(), Some("01a1f25e-d2e7-74e3-a450-7be1e49f2014"));
        let z = Path::new("rollout-2026-10-28T10-58-11-01a181bb-31ea-7030-ba60-72a50af2169d.jsonl.zst");
        assert_eq!(id_from_name(z).as_deref(), Some("01a181bb-31ea-7030-ba60-72a50af2169d"));
        assert!(id_from_name(Path::new("rollout-bad.jsonl")).is_none());
    }

    #[test]
    fn folders_compare_like_windows() {
        assert_eq!(norm_dir(r"\\?\D:\Development\Tennis Website\"), norm_dir("d:/development/tennis website"));
    }
    /// Reads this PC's real Codex sessions and prints only counts (no
    /// content). Run by hand: cargo test real_sessions -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_sessions() {
        let groups = list_sessions();
        let n: usize = groups.iter().map(|g| g.sessions.len()).sum();
        println!("groups {} sessions {}", groups.len(), n);
        for g in &groups {
            for m in &g.sessions {
                let p = Path::new(&m.path);
                let text = if is_zst(p) { read_zst(p).unwrap_or_default() } else { std::fs::read_to_string(p).unwrap_or_default() };
                let mut kinds: std::collections::BTreeMap<String, usize> = Default::default();
                let mut turns = (0, 0);
                for (i, l) in text.lines().enumerate() {
                    let c = parse_codex_line(l, i as i64);
                    for msg in &c.messages {
                        *kinds.entry(format!("{:?}/{}", msg.kind, msg.tool_name.clone().unwrap_or_default())).or_default() += 1;
                    }
                    match c.turn_open { Some(true) => turns.0 += 1, Some(false) => turns.1 += 1, _ => {} }
                }
                println!("{} zst={} title_len={} cwd_set={} turns={:?} {:?}", &m.session_id[..8], is_zst(p), m.title.len(), !m.cwd.is_empty(), turns, kinds);
                assert_eq!(find_rollout(&m.session_id).as_deref(), Some(p));
            }
        }
        let st = tauri::async_runtime::block_on(agent_status());
        println!("claude installed={} codex installed={}", st["claude"]["installed"], st["codex"]["installed"]);
        let hits = search("powershell", 10);
        println!("search hits {}", hits.len());
    }
}
