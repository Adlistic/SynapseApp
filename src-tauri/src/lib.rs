//! Synapse 2 — a Claude Code viewer.
//!
//! An embedded terminal runs the real `claude` CLI under a session id we mint;
//! the right-hand panel tails that session's transcript JSONL on disk and parses
//! it (via `synapse-core`) into navigable turns. The terminal stays a fully
//! normal interactive shell — the feed is built from the transcript, not by
//! scraping the terminal.

mod dashboard;
mod hv_auth;
mod sessions;
mod statusline;
mod terminals;
mod updater;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tracing::info;

use synapse_core::transcript::parse_line;
use synapse_core::types::Message;
use synapse_core::util::new_id;
use synapse_core::worktree::WorktreeManager;

/// Accumulated token usage for one session (summed from the transcript's
/// per-message `usage` blocks).
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
}

/// Incremental tail state for one session's transcript. The tailer thread
/// reads ONLY appended bytes, parses only complete lines, and appends into
/// `messages` — so the UI never pays for a full re-read/re-parse again.
#[derive(Default)]
struct SessionTail {
    path: Option<PathBuf>,
    /// Bytes consumed so far (always ends on a line boundary).
    offset: u64,
    /// Carry-over of trailing bytes after the last newline (raw bytes, so a
    /// multibyte char split across a read boundary is never decoded early).
    partial: Vec<u8>,
    messages: Vec<Message>,
    usage: Usage,
    /// Rich per-session metrics for the Mission Control dashboard.
    stats: dashboard::DashStats,
    line_no: i64,
    /// Flipped false by `close_session`; the tailer thread exits on it.
    alive: bool,
}

type Tails = Arc<Mutex<HashMap<String, SessionTail>>>;

struct AppState {
    tails: Tails,
    /// Canonical paths of worktrees backing a currently-open session; the orphan
    /// cleaner must never force-remove these.
    active_worktrees: Arc<Mutex<HashSet<PathBuf>>>,
    /// App-owned updater state (see updater.rs).
    update: Mutex<updater::UpdateSlot>,
}

/// Best-effort canonical form for comparing worktree paths across commands.
fn norm_path(p: &std::path::Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

/// Consume any newly appended complete lines from the transcript. Returns true
/// if anything new was parsed.
fn drain_tail(tail: &mut SessionTail) -> bool {
    let Some(path) = tail.path.clone() else { return false };
    let len = match std::fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(_) => return false,
    };
    if len <= tail.offset {
        return false;
    }
    let Ok(mut f) = std::fs::File::open(&path) else { return false };
    if f.seek(SeekFrom::Start(tail.offset)).is_err() {
        return false;
    }
    // Read at most a bounded chunk per pass so resuming a huge transcript doesn't
    // allocate the whole file at once (it just catches up over a few ticks).
    let to_read = (len - tail.offset).min(8 * 1024 * 1024);
    let mut buf = Vec::with_capacity(to_read as usize);
    if f.take(to_read).read_to_end(&mut buf).is_err() {
        return false;
    }
    tail.offset += buf.len() as u64;
    // Carry the trailing partial as raw BYTES, not a lossy String: a multibyte
    // char split across a read boundary must not be decoded until all its bytes
    // are present, or it corrupts into U+FFFD (and can desync the next read).
    let mut bytes = std::mem::take(&mut tail.partial);
    bytes.extend_from_slice(&buf);
    let complete_bytes = match bytes.iter().rposition(|&b| b == b'\n') {
        Some(nl) => {
            tail.partial = bytes.split_off(nl + 1); // after the last '\n'
            bytes // up to & including the last '\n' = only whole lines
        }
        None => {
            tail.partial = bytes; // no complete line yet
            return false;
        }
    };
    // Safe to decode now: complete lines fully contain any multibyte char (a '\n'
    // byte, 0x0A, can never be part of one).
    let complete = String::from_utf8_lossy(&complete_bytes);
    let mut added = false;
    for line in complete.lines() {
        if line.trim().is_empty() {
            continue;
        }
        tail.line_no += 1;
        let msgs = parse_line(line, tail.line_no, None);
        // Token usage + dashboard stats ride on the raw entry, which parse_line
        // doesn't surface.
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                tail.usage.input += g("input_tokens");
                tail.usage.output += g("output_tokens");
                tail.usage.cache_read += g("cache_read_input_tokens");
                tail.usage.cache_creation += g("cache_creation_input_tokens");
            }
            dashboard::update_stats(&mut tail.stats, &v, &msgs);
        }
        for m in msgs {
            tail.messages.push(m);
            added = true;
        }
    }
    added
}

/// Start the background tailer for a session: locates the transcript (it may
/// not exist yet), then stat-polls it cheaply and pushes new messages into the
/// shared cache, emitting `syn2:changed` so the frontend pulls the delta.
fn spawn_tailer(app: tauri::AppHandle, tails: Tails, session_id: String) {
    {
        let mut map = tails.lock();
        match map.get(&session_id) {
            Some(t) if t.alive => return, // already tailing
            // A dead entry from a just-closed session may not be reaped yet;
            // replace it so a quick close→resume of the same id still gets a
            // live tailer instead of inheriting a soon-to-be-removed one.
            _ => {
                map.insert(session_id.clone(), SessionTail { alive: true, ..Default::default() });
            }
        }
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(400));
            // Resolve the transcript path OFF the lock (find_transcript scans a
            // directory) so we never hold the global lock during that I/O.
            let need_path = {
                let map = tails.lock();
                match map.get(&session_id) {
                    None => return,
                    Some(t) => t.alive && t.path.is_none(),
                }
            };
            if need_path {
                let found = find_transcript(&session_id);
                let mut map = tails.lock();
                match map.get_mut(&session_id) {
                    Some(t) if t.alive => t.path = found,
                    _ => {
                        map.remove(&session_id);
                        return;
                    }
                }
            }
            let added = {
                let mut map = tails.lock();
                let Some(tail) = map.get_mut(&session_id) else { return };
                if !tail.alive {
                    map.remove(&session_id);
                    return;
                }
                // A malformed/unexpected line must never panic the tailer thread —
                // that would silently freeze this session's feed. Catch and skip.
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drain_tail(tail)))
                    .unwrap_or(false)
            };
            if added {
                let _ = app.emit("syn2:changed", serde_json::json!({ "sessionId": session_id }));
            }
        }
    });
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionOpts {
    folder: String,
    #[serde(default)]
    full_autonomy: bool,
    #[serde(default)]
    worktrees: bool,
}

/// Where Claude Code keeps per-session transcripts.
pub(crate) fn claude_projects_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").ok().or_else(|| std::env::var("HOME").ok())?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// Locate a session's transcript by filename (`<id>.jsonl`) across all projects,
/// so we don't have to reproduce Claude Code's cwd-encoding scheme.
fn find_transcript(session_id: &str) -> Option<PathBuf> {
    let dir = claude_projects_dir()?;
    let want = format!("{session_id}.jsonl");
    for proj in std::fs::read_dir(&dir).ok()?.flatten() {
        let p = proj.path();
        if p.is_dir() {
            let candidate = p.join(&want);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Begin a session: resolve the folder (optionally a fresh git worktree), mint a
/// session id, and hand the frontend the `claude` command + cwd to run in the
/// embedded terminal. Also starts the transcript tailer.
#[tauri::command]
fn start_session(
    app: tauri::AppHandle,
    state: State<AppState>,
    opts: SessionOpts,
) -> Result<serde_json::Value, String> {
    let folder = opts.folder.trim();
    if folder.is_empty() {
        return Err("Choose a folder first.".into());
    }
    let root = PathBuf::from(folder);
    let mut cwd = root.clone();
    if !cwd.is_dir() {
        return Err(format!("Not a folder: {folder}"));
    }

    let mut branch: Option<String> = None;
    // When worktree isolation is requested but can't be created, we fall back to
    // the real folder — but we tell the frontend so it can warn instead of letting
    // the user believe edits are sandboxed.
    let mut worktree_error: Option<String> = None;
    if opts.worktrees {
        let wm = WorktreeManager::new(cwd.clone());
        if wm.is_git_repo() {
            let id = new_id();
            let short = &id[..8.min(id.len())];
            let b = format!("synapse2/{short}");
            let wt = cwd.join(".synapse2").join("worktrees").join(short);
            if let Some(parent) = wt.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            match wm.add(&b, &wt, None) {
                Ok(p) => {
                    info!(target: "synapse2", branch = %b, path = %p.display(), "created worktree");
                    state.active_worktrees.lock().insert(norm_path(&p));
                    cwd = p;
                    branch = Some(b);
                }
                Err(e) => {
                    info!(target: "synapse2", error = %e, "worktree failed; using the folder directly");
                    worktree_error = Some(e.to_string());
                }
            }
        } else {
            worktree_error = Some("the chosen folder isn't a git repository".into());
        }
    }

    let session_id = new_id();
    let mut command = format!("claude --session-id {session_id}");
    if opts.full_autonomy {
        command.push_str(" --dangerously-skip-permissions");
    }
    info!(target: "synapse2", session = %session_id, cwd = %cwd.display(), full_autonomy = opts.full_autonomy, worktree = ?branch, "session start");
    spawn_tailer(app, state.tails.clone(), session_id.clone());

    Ok(serde_json::json!({
        "sessionId": session_id,
        "root": root.to_string_lossy(),
        "cwd": cwd.to_string_lossy(),
        "command": command,
        "branch": branch,
        "worktreeError": worktree_error,
    }))
}

/// Resume an existing Claude Code session (from the session browser) in a new
/// embedded terminal. The tailer preloads the FULL existing transcript, so the
/// turn panel shows the whole history immediately.
#[tauri::command]
fn resume_session(
    app: tauri::AppHandle,
    state: State<AppState>,
    session_id: String,
    cwd: String,
    full_autonomy: bool,
) -> Result<serde_json::Value, String> {
    let cwd = cwd.trim();
    let dir = PathBuf::from(cwd);
    if cwd.is_empty() || !dir.is_dir() {
        return Err(format!("The session's folder no longer exists: {cwd}"));
    }
    let mut command = format!("claude --resume {session_id}");
    if full_autonomy {
        command.push_str(" --dangerously-skip-permissions");
    }
    info!(target: "synapse2", session = %session_id, cwd = %cwd, "session resume");
    spawn_tailer(app, state.tails.clone(), session_id.clone());
    Ok(serde_json::json!({
        "sessionId": session_id,
        "root": cwd,
        "cwd": cwd,
        "command": command,
        "branch": serde_json::Value::Null,
    }))
}

/// Delta read of a session's parsed transcript: returns messages[since..] from
/// the tailer's cache — no file I/O, no re-parsing. `ready` flips true once the
/// transcript file has been located.
#[tauri::command]
fn get_conversation(state: State<AppState>, session_id: String, since: Option<usize>) -> serde_json::Value {
    let map = state.tails.lock();
    let Some(tail) = map.get(&session_id) else {
        return serde_json::json!({ "ready": false, "messages": [], "total": 0 });
    };
    let since = since.unwrap_or(0).min(tail.messages.len());
    serde_json::json!({
        "ready": tail.path.is_some(),
        "messages": &tail.messages[since..],
        "total": tail.messages.len(),
        "usage": tail.usage,
    })
}

/// One snapshot of every open session's dashboard stats — all served from the
/// tailer's in-memory cache, so this is safe to poll frequently.
#[tauri::command]
fn get_dashboard(state: State<AppState>) -> serde_json::Value {
    let map = state.tails.lock();
    let mut sessions = serde_json::Map::new();
    for (id, t) in map.iter() {
        sessions.insert(
            id.clone(),
            serde_json::json!({
                "ready": t.path.is_some(),
                "usage": t.usage,
                "stats": t.stats,
            }),
        );
    }
    serde_json::json!({ "sessions": sessions })
}

/// End a session: stop its tailer and (optionally) deal with its worktree.
/// `action`: "keep" leaves everything; "delete" removes the worktree + branch;
/// "merge" commits any leftover work in the worktree, merges the branch into
/// the root tree, then removes the worktree + branch.
///
/// `async` so the blocking git sequence (merge can take seconds) and the
/// worktree-remove retry loop (up to ~1s of sleeps) run on the async runtime
/// instead of the main/UI thread — otherwise the whole window freezes while a
/// session with a worktree is being closed.
#[tauri::command]
async fn close_session(
    state: State<'_, AppState>,
    session_id: String,
    root: Option<String>,
    worktree_path: Option<String>,
    branch: Option<String>,
    action: Option<String>,
) -> Result<(), String> {
    // Stop the tailer only once any worktree action has succeeded, so a failed
    // merge leaves the session fully usable.
    let stop_tailer = |state: &State<AppState>| {
        if let Some(t) = state.tails.lock().get_mut(&session_id) {
            t.alive = false;
        }
    };
    let action = action.unwrap_or_else(|| "keep".into());
    // Only recognized actions are allowed — never let an unknown/typo'd value fall
    // through to the destructive "remove worktree + delete branch" cleanup.
    if !matches!(action.as_str(), "keep" | "merge" | "delete") {
        return Err(format!("unknown close action: {action}"));
    }
    let (Some(root), Some(wt), Some(branch)) = (root, worktree_path, branch) else {
        stop_tailer(&state);
        return Ok(());
    };
    let root = PathBuf::from(root);
    let wt = PathBuf::from(wt);
    // This worktree is no longer backing a live session (whatever the action).
    state.active_worktrees.lock().remove(&norm_path(&wt));
    if action == "keep" {
        stop_tailer(&state);
        return Ok(());
    }
    if action == "merge" {
        // Commit whatever the session left uncommitted so the merge sees it.
        let dirty = git(&wt, &["status", "--porcelain"])?;
        if !dirty.trim().is_empty() {
            git(&wt, &["add", "-A"])?;
            git(&wt, &[
                "-c", "user.email=synapse@local",
                "-c", "user.name=Synapse",
                "commit", "-q", "-m", &format!("{branch}: session work (committed by Synapse)"),
            ])?;
        }
        // Merge only if the branch actually has commits beyond the root HEAD.
        let ahead = git(&root, &["rev-list", "--count", &format!("HEAD..{branch}")])?;
        if ahead.trim() != "0" {
            if let Err(e) = git(&root, &["merge", "--no-edit", &branch]) {
                // Roll the root tree back so we never leave the user's MAIN folder
                // stuck mid-merge with conflict markers. The branch + worktree stay
                // intact, so the session's work is preserved and still resumable.
                let _ = git(&root, &["merge", "--abort"]);
                return Err(format!(
                    "Couldn't merge {branch} into the main folder ({e}). The merge was rolled back; your session work is still on branch {branch} — resolve it manually or reopen the session."
                ));
            }
            info!(target: "synapse2", branch = %branch, "merged session branch");
        }
    }
    // For both "merge" and "delete": clean up the worktree + branch. Retry the
    // removal briefly — just after the session's terminal is killed the OS may
    // still hold the worktree directory for a moment (Windows sharing violation).
    let wt_str = wt.to_string_lossy().to_string();
    let mut removed = git(&root, &["worktree", "remove", "--force", &wt_str]);
    for _ in 0..5 {
        if removed.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        removed = git(&root, &["worktree", "remove", "--force", &wt_str]);
    }
    removed?;
    let _ = git(&root, &["branch", "-D", &branch]); // may fail if never created
    info!(target: "synapse2", branch = %branch, action = %action, "worktree cleaned up");
    stop_tailer(&state);
    Ok(())
}

/// Worktrees under `<folder>/.synapse2/worktrees` left behind by old sessions.
/// Excludes any worktree currently backing an open session.
#[tauri::command]
fn list_orphan_worktrees(state: State<AppState>, folder: String) -> Vec<serde_json::Value> {
    let dir = PathBuf::from(folder.trim()).join(".synapse2").join("worktrees");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let active = state.active_worktrees.lock().clone();
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter(|e| !active.contains(&norm_path(&e.path())))
        .map(|e| {
            serde_json::json!({
                "path": e.path().to_string_lossy(),
                "name": e.file_name().to_string_lossy(),
            })
        })
        .collect()
}

/// Remove leftover session worktrees under `<folder>/.synapse2/worktrees` (and
/// their `synapse2/<name>` branches) — SKIPPING any worktree that is currently
/// backing an open session (removing those would destroy in-progress work).
/// Returns how many were removed.
#[tauri::command]
fn cleanup_orphan_worktrees(state: State<AppState>, folder: String) -> Result<usize, String> {
    let root = PathBuf::from(folder.trim());
    let dir = root.join(".synapse2").join("worktrees");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(0) };
    let active = state.active_worktrees.lock().clone();
    let mut removed = 0usize;
    for e in entries.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()) {
        if active.contains(&norm_path(&e.path())) {
            continue; // belongs to an open session — never force-remove it
        }
        let name = e.file_name().to_string_lossy().to_string();
        let p = e.path().to_string_lossy().to_string();
        if git(&root, &["worktree", "remove", "--force", &p]).is_ok() {
            removed += 1;
        } else {
            // Not a registered worktree any more — just delete the directory.
            if std::fs::remove_dir_all(e.path()).is_ok() {
                removed += 1;
            }
        }
        let _ = git(&root, &["branch", "-D", &format!("synapse2/{name}")]);
    }
    info!(target: "synapse2", removed, "orphan worktrees cleaned");
    Ok(removed)
}

/// Run a git command rooted at `cwd`, returning trimmed stdout.
fn git(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let mut c = std::process::Command::new("git");
    c.arg("-C").arg(cwd).args(args);
    synapse_core::runner::hide_window(&mut c);
    let out = c.output().map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Write an exported conversation to disk (path comes from the save dialog).
#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(PathBuf::from(path.trim()), content).map_err(|e| e.to_string())
}

/// Last-known Claude rate-limit windows (5-hour session + weekly), cached to
/// `~/.synapse/ratelimits.json` by the user's statusline script on every
/// Claude Code statusline refresh. Free to read; no tokens involved.
#[tauri::command]
fn get_rate_limits() -> serde_json::Value {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());
    let p = PathBuf::from(home).join(".synapse").join("ratelimits.json");
    std::fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// Delete one session transcript from Claude Code's store (the browser's 🗑).
/// Restricted to paths inside `~/.claude/projects`.
#[tauri::command]
fn delete_claude_session(state: State<AppState>, path: String) -> Result<(), String> {
    let p = PathBuf::from(path.trim());
    let root = claude_projects_dir().ok_or("no Claude session store")?;
    let canon = p.canonicalize().map_err(|e| format!("session not found: {e}"))?;
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&canon_root) {
        return Err("path is outside the Claude session store".into());
    }
    // Refuse to delete a transcript that's open & live in a tab: its `claude`
    // process is still writing to that file, so deleting it would freeze the feed
    // and destroy in-progress work. The file stem is the session id (the tails key).
    if let Some(stem) = canon.file_stem().and_then(|s| s.to_str()) {
        if state.tails.lock().get(stem).map(|t| t.alive).unwrap_or(false) {
            return Err("That session is open in a tab — close it before deleting.".into());
        }
    }
    std::fs::remove_file(&canon).map_err(|e| e.to_string())?;
    info!(target: "synapse2", path = %canon.display(), "transcript deleted");
    Ok(())
}

/// Read the OS clipboard (for terminal paste — bypasses the WebView2 clipboard,
/// which doesn't reliably deliver paste into xterm).
#[tauri::command]
fn clip_get() -> Result<String, String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .map_err(|e| e.to_string())
}

/// Write the OS clipboard (for terminal copy).
#[tauri::command]
fn clip_set(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| e.to_string())
}

/// Open an http(s) link (from rendered markdown) in the default browser.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) links can be opened".into());
    }
    // The URL comes from rendered (untrusted) transcript markdown. Reject anything
    // that isn't a clean single-token URL: raw whitespace/control chars and shell
    // metacharacters are the ingredients of argument-splitting / command injection.
    if url.len() > 2048
        || url.chars().any(|c| {
            c.is_whitespace()
                || c.is_control()
                || matches!(c, '"' | '\'' | '&' | '|' | '^' | '<' | '>' | '`' | '(' | ')')
        })
    {
        return Err("refusing to open a malformed URL".into());
    }
    #[cfg(windows)]
    let r = {
        // Do NOT go through `cmd /C start` — cmd interprets & | ^ etc. BEFORE the
        // target sees them, which turned this into a command-injection sink. rundll32
        // receives the URL as a single, non-shell-parsed argument.
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler").arg(&url);
        synapse_core::runner::hide_window(&mut c);
        c.spawn()
    };
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(&url).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_dir = synapse_core::diag::default_log_dir();
    let _log_guard = synapse_core::diag::init(&log_dir, true).ok();
    info!(target: "synapse2", "Synapse 2 starting");

    let state = AppState {
        tails: Arc::new(Mutex::new(HashMap::new())),
        active_worktrees: Arc::new(Mutex::new(HashSet::new())),
        update: Mutex::new(updater::UpdateSlot::default()),
    };

    tauri::Builder::default()
        // single-instance must be registered first; on Windows the deep-link
        // claim URL arrives as an argv on the second launch.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in &argv {
                if arg.starts_with("synapse://") {
                    if let Some(tok) = hv_auth::handle_claim_url(arg) {
                        info!(target: "synapse2", "account linked via deep link");
                        let _ = app.emit("hv-auth-claimed", tok);
                    }
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(terminals::Terminals::default())
        // Re-check for updates whenever the window regains focus — Rust-side,
        // because WebView2 never fires the page's visibilitychange on
        // minimize/restore, so a JS listener misses it. MIN_GAP in updater.rs
        // throttles this to at most once per half hour.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    updater::check(app, false).await;
                });
            }
        })
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("Synapse — Claude Code Workspace");
            }

            // Deep-link: handle warm-instance opens (macOS/Linux) and register
            // the `synapse://` scheme at runtime on Windows/Linux for dev.
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(tok) = hv_auth::handle_claim_url(url.as_str()) {
                        let _ = handle.emit("hv-auth-claimed", tok);
                    }
                }
            });
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }
            // Rust-owned background updater: launch check + 6-hourly re-checks.
            updater::start(app.handle());
            // Cold start via deep link (Windows): the URL is in our own argv.
            for arg in std::env::args() {
                if arg.starts_with("synapse://") {
                    if let Some(tok) = hv_auth::handle_claim_url(&arg) {
                        let _ = app.handle().emit("hv-auth-claimed", tok);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            resume_session,
            get_conversation,
            get_dashboard,
            close_session,
            list_orphan_worktrees,
            cleanup_orphan_worktrees,
            save_text_file,
            get_rate_limits,
            delete_claude_session,
            statusline::statusline_status,
            statusline::install_statusline_hook,
            sessions::list_claude_sessions,
            sessions::search_sessions,
            clip_get,
            clip_set,
            open_external,
            hv_auth::auth_begin_signin,
            hv_auth::auth_is_linked,
            hv_auth::auth_sign_out,
            hv_auth::get_entitlement,
            terminals::term_open,
            terminals::term_input,
            terminals::term_resize,
            terminals::term_close,
            updater::get_update_status,
            updater::get_update_check_info,
            updater::check_for_updates,
            updater::install_update,
            updater::dismiss_update,
            updater::sync_dismissed_update,
            updater::get_release_notes_since
        ])
        .run(tauri::generate_context!())
        .expect("error while running Synapse");
}
