//! HyperVoice Code (formerly Synapse) — a Claude Code / Codex workspace.
//!
//! An embedded terminal runs the real `claude` CLI under a session id we mint;
//! the right-hand panel tails that session's transcript JSONL on disk and parses
//! it (via `synapse-core`) into navigable turns. The terminal stays a fully
//! normal interactive shell — the feed is built from the transcript, not by
//! scraping the terminal.

mod codex;
mod dashboard;
mod hv_auth;
mod packaging;
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

use synapse_core::codex::parse_codex_line;
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

/// Which coding CLI a session runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Agent {
    #[default]
    Claude,
    Codex,
}

impl Agent {
    fn parse(s: Option<&str>) -> Agent {
        match s {
            Some("codex") => Agent::Codex,
            _ => Agent::Claude,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }
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
    agent: Agent,
    /// A new Codex session whose file doesn't exist yet: (folder, launch time ms).
    discover: Option<(String, i64)>,
    /// Codex lines carry an increasing `ordinal`; anything at or below this was
    /// already read (so re-reading a compressed file never doubles the feed).
    last_ordinal: i64,
    /// Size of the compressed Codex file when last read.
    zst_len: u64,
    /// Prompts seen in the current Codex turn (a second one was sent mid-turn).
    turn_users: u32,
    /// When a compressed Codex file was last checked for a plain copy.
    zst_checked: Option<std::time::Instant>,
}

type Tails = Arc<Mutex<HashMap<String, SessionTail>>>;

struct AppState {
    tails: Tails,
    /// A new Codex tab starts under an id we make up; once its session file
    /// appears it is re-keyed to Codex's real id. Old id -> real id.
    aliases: Arc<Mutex<HashMap<String, String>>>,
    /// Canonical paths of worktrees backing a currently-open session; the orphan
    /// cleaner must never force-remove these.
    active_worktrees: Arc<Mutex<HashMap<PathBuf, usize>>>,
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
        if tail.agent == Agent::Codex {
            added |= codex_line(tail, line);
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

/// Fold one Codex rollout line into the tail: messages, token totals and the
/// dashboard stats (the same fields the Claude path fills).
fn codex_line(tail: &mut SessionTail, line: &str) -> bool {
    tail.line_no += 1;
    let mut l = parse_codex_line(line, tail.line_no);
    if let Some(o) = l.ordinal {
        if o <= tail.last_ordinal {
            return false;
        }
        tail.last_ordinal = o;
    }
    if l.turn_open == Some(true) {
        tail.turn_users = 0;
    }
    for m in l.messages.iter_mut() {
        if m.kind == synapse_core::types::MessageKind::User {
            m.mid_turn = tail.stats.turn_open == Some(true) && tail.turn_users > 0;
            tail.turn_users += 1;
        }
    }
    if let Some(u) = l.usage {
        tail.usage = Usage { input: u.input, output: u.output, cache_read: u.cache_read, cache_creation: u.cache_creation };
    }
    let ts = l.timestamp.clone().map(serde_json::Value::String).unwrap_or(serde_json::Value::Null);
    dashboard::update_stats(&mut tail.stats, &serde_json::json!({ "timestamp": ts }), &l.messages);
    if let Some(m) = l.model.take().filter(|m| !m.is_empty()) {
        tail.stats.last_model = m;
    }
    if let Some(c) = l.context_tokens {
        tail.stats.context_tokens = c;
    }
    if let Some(w) = l.context_window {
        tail.stats.context_window = w;
    }
    if l.turn_open.is_some() {
        tail.stats.turn_open = l.turn_open;
    }
    if l.rate_limits.is_some() {
        tail.stats.rate_limits = l.rate_limits.take();
    }
    let added = !l.messages.is_empty();
    tail.messages.extend(l.messages);
    // A turn starting or ending changes the status even with no new message.
    added || l.turn_open.is_some()
}

/// A compressed Codex session: re-read it whole when it changes (new lines
/// are picked out by ordinal). Every few seconds, also look for a plain copy
/// (in case Codex writes the session out plain again when it is resumed).
fn drain_codex_zst(tail: &mut SessionTail, session_id: &str) -> bool {
    let Some(path) = tail.path.clone() else { return false };
    let due = tail.zst_checked.map(|t| t.elapsed().as_secs() >= 3).unwrap_or(true);
    if due {
        tail.zst_checked = Some(std::time::Instant::now());
        if let Some(p) = codex::find_rollout(session_id).filter(|p| !codex::is_zst(p)) {
            tail.path = Some(p);
            tail.offset = 0;
            tail.partial.clear();
            return drain_tail(tail);
        }
    }
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if len == 0 || len == tail.zst_len {
        return false;
    }
    tail.zst_len = len;
    let Some(text) = codex::read_zst(&path) else { return false };
    let mut added = false;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        added |= codex_line(tail, line);
    }
    added
}

/// Start the background tailer for a session: locates the transcript (it may
/// not exist yet), then stat-polls it cheaply and pushes new messages into the
/// shared cache, emitting `syn2:changed` so the frontend pulls the delta.
fn spawn_tailer(
    app: tauri::AppHandle,
    tails: Tails,
    aliases: Arc<Mutex<HashMap<String, String>>>,
    session_id: String,
    agent: Agent,
    discover: Option<(String, i64)>,
) {
    {
        let mut map = tails.lock();
        match map.get(&session_id) {
            Some(t) if t.alive => return, // already tailing
            // A dead entry from a just-closed session may not be reaped yet;
            // replace it so a quick close→resume of the same id still gets a
            // live tailer instead of inheriting a soon-to-be-removed one.
            _ => {
                map.insert(session_id.clone(), SessionTail { alive: true, agent, discover, ..Default::default() });
            }
        }
    }
    let mut session_id = session_id;
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
            if need_path && agent == Agent::Claude {
                let found = find_transcript(&session_id);
                let mut map = tails.lock();
                match map.get_mut(&session_id) {
                    Some(t) if t.alive => t.path = found,
                    _ => {
                        map.remove(&session_id);
                        return;
                    }
                }
            } else if need_path {
                // Codex: a resumed session is found by id; a new one by
                // watching for its file to appear (it does on the first prompt).
                let (pending, claimed) = {
                    let map = tails.lock();
                    let pending = map.get(&session_id).and_then(|t| t.discover.clone());
                    let claimed: HashSet<PathBuf> = map.values().filter_map(|t| t.path.clone()).collect();
                    (pending, claimed)
                };
                let found = match &pending {
                    Some((cwd, since)) => codex::discover(cwd, *since, &claimed),
                    None => codex::find_rollout(&session_id).map(|p| (session_id.clone(), p)),
                };
                if let Some((real_id, path)) = found {
                    let mut map = tails.lock();
                    let Some(mut t) = map.remove(&session_id) else { return };
                    if !t.alive {
                        return;
                    }
                    t.path = Some(path);
                    t.discover = None;
                    // The id comes from a file on disk and ends up in a command
                    // line (`codex resume <id>`): only a plain id is accepted.
                    if real_id != session_id && session_id_ok(&real_id) && !map.get(&real_id).is_some_and(|x| x.alive) {
                        // Re-key to Codex's own id so resume, titles and
                        // restore all use the id Codex knows.
                        map.insert(real_id.clone(), t);
                        drop(map);
                        aliases.lock().insert(session_id.clone(), real_id.clone());
                        info!(target: "synapse2", from = %session_id, to = %real_id, "codex session found");
                        let _ = app.emit("syn2:rekey", serde_json::json!({ "from": session_id, "to": real_id }));
                        session_id = real_id;
                    } else {
                        map.insert(session_id.clone(), t);
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
                let zst = tail.agent == Agent::Codex && tail.path.as_deref().is_some_and(codex::is_zst);
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if zst { drain_codex_zst(tail, &session_id) } else { drain_tail(tail) }
                }))
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
    /// Permission mode key (see `perm_flags`). Wins over `full_autonomy`.
    #[serde(default)]
    perm_mode: Option<String>,
    #[serde(default)]
    worktrees: bool,
    /// "claude" (default) or "codex".
    #[serde(default)]
    agent: Option<String>,
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

/// Command-line flags for a permission mode. Only these fixed keys are
/// accepted (the result is typed into a terminal), anything else is an error.
/// `None` / "default" means the agent's own default (it asks before acting).
fn perm_flags(agent: Agent, mode: Option<&str>, full_autonomy: bool) -> Result<(&'static str, &'static str), String> {
    let mode = mode.unwrap_or(if full_autonomy { "bypass" } else { "default" });
    Ok(match (agent, mode) {
        (_, "default") => ("default", ""),
        (Agent::Claude, "acceptEdits") => ("acceptEdits", " --permission-mode acceptEdits"),
        (Agent::Claude, "plan") => ("plan", " --permission-mode plan"),
        (Agent::Claude, "auto") => ("auto", " --permission-mode auto"),
        (Agent::Claude, "bypass") => ("bypass", " --dangerously-skip-permissions"),
        (Agent::Codex, "readOnly") => ("readOnly", " --sandbox read-only"),
        (Agent::Codex, "auto") => ("auto", " --approve-for-me"),
        (Agent::Codex, "bypass") => ("bypass", " --dangerously-bypass-approvals-and-sandbox"),
        _ => return Err(format!("Unknown permission mode: {mode}")),
    })
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
    // Checked before a worktree is made, so a bad mode leaves nothing behind.
    let agent = Agent::parse(opts.agent.as_deref());
    let (perm_mode, flags) = perm_flags(agent, opts.perm_mode.as_deref(), opts.full_autonomy)?;

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
            let (wt_dir, wt_prefix) = WT_LAYOUTS[0];
            let b = format!("{wt_prefix}{short}");
            let wt = cwd.join(wt_dir).join("worktrees").join(short);
            if let Some(parent) = wt.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            // Keep the worktree folder out of the user's repo: without this it
            // shows as untracked, `git add -A` in the main folder would stage the
            // worktrees as embedded repos, and searches see duplicate copies.
            if let Err(e) = ensure_git_excluded(&cwd, &format!("{wt_dir}/")) {
                info!(target: "synapse2", error = %e, "couldn't add .synapse2/ to git exclude");
            }
            match wm.add(&b, &wt, None) {
                Ok(p) => {
                    info!(target: "synapse2", branch = %b, path = %p.display(), "created worktree");
                    *state.active_worktrees.lock().entry(norm_path(&p)).or_insert(0) += 1;
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
    let (command, discover) = match agent {
        Agent::Claude => (format!("claude --session-id {session_id}{flags}"), None),
        Agent::Codex => {
            // Codex can't be told an id: it picks one when the first prompt is
            // sent, and the tailer finds that session by folder + start time.
            let c = format!("codex{flags}");
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            (c, Some((codex::norm_dir(&cwd.to_string_lossy()), now)))
        }
    };
    info!(target: "synapse2", session = %session_id, agent = agent.as_str(), cwd = %cwd.display(), perm_mode, worktree = ?branch, "session start");
    spawn_tailer(app, state.tails.clone(), state.aliases.clone(), session_id.clone(), agent, discover);

    Ok(serde_json::json!({
        "agent": agent.as_str(),
        "sessionId": session_id,
        "root": root.to_string_lossy(),
        "cwd": cwd.to_string_lossy(),
        "command": command,
        "permMode": perm_mode,
        "permFlags": flags,
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
    full_autonomy: Option<bool>,
    perm_mode: Option<String>,
    agent: Option<String>,
) -> Result<serde_json::Value, String> {
    let agent = Agent::parse(agent.as_deref());
    let (perm_mode, flags) = perm_flags(agent, perm_mode.as_deref(), full_autonomy.unwrap_or(false))?;
    // The id goes into the command line typed into the terminal.
    if !session_id_ok(&session_id) {
        return Err("That doesn't look like a session id.".into());
    }
    let cwd = cwd.trim();
    let dir = PathBuf::from(cwd);
    if cwd.is_empty() || !dir.is_dir() {
        return Err(format!("The session's folder no longer exists: {cwd}"));
    }
    let command = match agent {
        Agent::Claude => format!("claude --resume {session_id}{flags}"),
        Agent::Codex => format!("codex resume {session_id}{flags}"),
    };
    // A resumed session that lives in one of our worktrees: protect the folder
    // from "clean up old worktrees" while it is open, and hand back its branch
    // so closing it offers merge / keep / discard like a fresh worktree session.
    let (root, branch) = match session_worktree(&dir) {
        Some((root, branch)) => {
            *state.active_worktrees.lock().entry(norm_path(&dir)).or_insert(0) += 1;
            (root.to_string_lossy().to_string(), branch)
        }
        None => (cwd.to_string(), None),
    };
    info!(target: "synapse2", session = %session_id, agent = agent.as_str(), cwd = %cwd, perm_mode, worktree = ?branch, "session resume");
    spawn_tailer(app, state.tails.clone(), state.aliases.clone(), session_id.clone(), agent, None);
    Ok(serde_json::json!({
        "agent": agent.as_str(),
        "sessionId": session_id,
        "root": root,
        "cwd": cwd,
        "command": command,
        "permMode": perm_mode,
        "permFlags": flags,
        "branch": branch,
    }))
}

/// If `dir` is `<root>/.synapse2/worktrees/<name>`, return the repo root, plus
/// the session branch when the worktree is still checked out on
/// `synapse2/<name>`. The folder is one of ours whatever branch it is on (so it
/// must be protected while open); the branch is only handed back when closing
/// could safely merge or discard it.
fn session_worktree(dir: &std::path::Path) -> Option<(PathBuf, Option<String>)> {
    let name = dir.file_name()?.to_str()?;
    if !valid_worktree_name(name) {
        return None;
    }
    let wts = dir.parent()?;
    if wts.file_name()?.to_str()? != "worktrees" {
        return None;
    }
    let dot = wts.parent()?;
    let dot_name = dot.file_name()?.to_str()?;
    let (_, prefix) = WT_LAYOUTS.iter().find(|(d, _)| *d == dot_name)?;
    let root = dot.parent()?.to_path_buf();
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| *b == format!("{prefix}{name}"));
    Some((root, branch))
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
    // A new Codex tab may have been re-keyed to Codex's own id.
    let session_id = state.aliases.lock().remove(&session_id).unwrap_or(session_id);
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
    // One fewer open session on this worktree (whatever the action).
    let still_open = {
        let mut active = state.active_worktrees.lock();
        let key = norm_path(&wt);
        let left = active.get(&key).copied().unwrap_or(0).saturating_sub(1);
        if left == 0 {
            active.remove(&key);
        } else {
            active.insert(key, left);
        }
        left
    };
    if action != "keep" && still_open > 0 {
        stop_tailer(&state);
        return Err(format!(
            "Another open tab is still using this worktree, so it was kept. Close that tab to {} it.",
            if action == "merge" { "merge" } else { "discard" }
        ));
    }
    if action == "keep" {
        stop_tailer(&state);
        return Ok(());
    }
    // From here on the session is being closed. If anything fails, the tab
    // stays open, so put the worktree back on the "open, don't clean up" list.
    let result = finish_worktree(&root, &wt, &branch, &action);
    if result.is_err() {
        *state.active_worktrees.lock().entry(norm_path(&wt)).or_insert(0) += 1;
        return result;
    }
    stop_tailer(&state);
    Ok(())
}

/// The git part of closing a worktree session: "merge" commits leftovers and
/// merges into the root; then both "merge" and "delete" remove the worktree
/// and its branch.
fn finish_worktree(root: &std::path::Path, wt: &std::path::Path, branch: &str, action: &str) -> Result<(), String> {
    if action == "merge" {
        // Commit whatever the session left uncommitted so the merge sees it.
        let dirty = git(wt, &["status", "--porcelain"])?;
        if !dirty.trim().is_empty() {
            git(wt, &["add", "-A"])?;
            git(wt, &[
                "-c", "user.email=hypervoice-code@local",
                "-c", "user.name=HyperVoice Code",
                "commit", "-q", "-m", &format!("{branch}: session work (committed by HyperVoice Code)"),
            ])?;
        }
        // Merge only if the branch actually has commits beyond the root HEAD.
        let ahead = git(root, &["rev-list", "--count", &format!("HEAD..{branch}")])?;
        if ahead.trim() != "0" {
            if let Err(e) = git(root, &["merge", "--no-edit", branch]) {
                // Roll the root tree back so we never leave the user's MAIN folder
                // stuck mid-merge with conflict markers. The branch + worktree stay
                // intact, so the session's work is preserved and still resumable.
                let _ = git(root, &["merge", "--abort"]);
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
    let mut removed = git(root, &["worktree", "remove", "--force", &wt_str]);
    for _ in 0..5 {
        if removed.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        removed = git(root, &["worktree", "remove", "--force", &wt_str]);
    }
    removed?;
    let _ = git(root, &["branch", "-D", branch]); // may fail if never created
    info!(target: "synapse2", branch = %branch, action = %action, "worktree cleaned up");
    Ok(())
}

/// What one leftover session worktree holds, so the cleanup dialog can say
/// exactly what deleting it would lose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeStatus {
    name: String,
    path: String,
    branch: String,
    /// Uncommitted or untracked files. None = couldn't be read (not a working
    /// git worktree any more).
    changed_files: Option<u32>,
    /// Files git ignores (`.env`, build output, `node_modules`): not part of
    /// any commit, so removing the folder deletes them for good.
    ignored_files: Option<u32>,
    /// One of the ignored paths, to show what kind of thing they are.
    ignored_example: Option<String>,
    /// Commits the main folder's HEAD doesn't have — on the session branch, or
    /// on whatever the worktree has checked out (a detached HEAD included).
    /// None = it couldn't be worked out.
    unmerged_commits: Option<u32>,
    /// True only when we could prove there is nothing to lose.
    safe: bool,
}

/// Where session worktrees live, as (folder in the repo, branch prefix). New
/// sessions use the first. The second is the layout from before the rename
/// (Synapse); it is still recognised, so older worktrees can be resumed,
/// merged and cleaned up.
const WT_LAYOUTS: [(&str, &str); 2] = [(".hvcode", "hvcode/"), (".synapse2", "synapse2/")];

/// Worktree folder names are the 8-char ids we mint; accept nothing that could
/// step outside `<layout folder>/worktrees`.
fn valid_worktree_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// True only when `path` is a linked worktree of the repo at `root`: git in
/// `root` lists it, and its `.git` is a file pointing into root's own
/// `<common dir>/worktrees/`. A folder that merely looks like one (say, a repo
/// planted in a downloaded project) fails, so git never runs with its config.
fn registered_worktree(root: &std::path::Path, path: &std::path::Path) -> bool {
    let want = norm_path(path);
    let listed = git(root, &["worktree", "list", "--porcelain"])
        .map(|out| {
            out.lines()
                .filter_map(|l| l.strip_prefix("worktree "))
                .any(|p| norm_path(std::path::Path::new(p.trim())) == want)
        })
        .unwrap_or(false);
    if !listed {
        return false;
    }
    let Ok(common) = git(root, &["rev-parse", "--git-common-dir"]) else {
        return false;
    };
    let common = PathBuf::from(common.trim());
    let common = if common.is_absolute() { common } else { root.join(common) };
    let wts_dir = norm_path(&common.join("worktrees"));
    let dot_git = path.join(".git");
    if !dot_git.is_file() {
        return false;
    }
    let Ok(link) = std::fs::read_to_string(&dot_git) else {
        return false;
    };
    let Some(target) = link.lines().next().and_then(|l| l.strip_prefix("gitdir:")) else {
        return false;
    };
    let target = PathBuf::from(target.trim());
    let target = if target.is_absolute() { target } else { path.join(target) };
    // Both canonical, so this is a real "inside that folder" check.
    let target = norm_path(&target);
    target != wts_dir && target.starts_with(&wts_dir)
}

fn worktree_status(root: &std::path::Path, path: &std::path::Path, name: &str, prefix: &str) -> WorktreeStatus {
    let branch = format!("{prefix}{name}");
    // These folders may hold anything a session wrote; never let a config in
    // one of them run a program just because we looked at it.
    const QUIET: [&str; 2] = ["-c", "core.fsmonitor=false"];
    let wt_git = |args: &[&str]| {
        let mut all: Vec<&str> = QUIET.to_vec();
        all.extend_from_slice(args);
        git(path, &all)
    };
    // Only trust `git status` when git agrees this folder IS the worktree. If
    // its `.git` link is gone, git would walk up and report the main repo.
    // And never run git in it at all unless it is provably one of root's own
    // worktrees: otherwise it could be a planted repo whose config runs a program.
    let is_worktree = registered_worktree(root, path)
        && wt_git(&["rev-parse", "--show-toplevel"])
            .map(|top| norm_path(std::path::Path::new(&top)) == norm_path(path))
            .unwrap_or(false);
    let (mut changed_files, mut ignored_files, mut ignored_example) = (None, None, None);
    if is_worktree {
        // --untracked-files=all: a user config of showUntrackedFiles=no must not
        // hide new files. --ignored: ignored files are deleted with the folder.
        if let Ok(out) = wt_git(&["status", "--porcelain", "--untracked-files=all", "--ignored=matching"]) {
            let (mut changed, mut ignored) = (0u32, 0u32);
            for l in out.lines().filter(|l| !l.trim().is_empty()) {
                if let Some(rest) = l.strip_prefix("!! ") {
                    ignored += 1;
                    if ignored_example.is_none() {
                        ignored_example = Some(rest.trim().trim_matches('"').to_string());
                    }
                } else {
                    changed += 1;
                }
            }
            changed_files = Some(changed);
            ignored_files = Some(ignored);
        }
    }
    let ahead = |rev: &str| {
        git(root, &["rev-list", "--count", &format!("HEAD..{rev}")])
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
    };
    // The session branch, AND whatever the worktree actually has checked out:
    // commits made on a detached HEAD belong to no branch and would be lost.
    let on_branch = ahead(&branch);
    let on_head = if is_worktree {
        wt_git(&["rev-parse", "HEAD"]).ok().and_then(|sha| ahead(sha.trim()))
    } else {
        None
    };
    let unmerged_commits = match (on_branch, on_head) {
        (Some(a), Some(b)) => Some(a.max(b)),
        _ => None,
    };
    let safe = changed_files == Some(0) && ignored_files == Some(0) && unmerged_commits == Some(0);
    WorktreeStatus {
        name: name.to_string(),
        path: path.to_string_lossy().to_string(),
        branch,
        changed_files,
        ignored_files,
        ignored_example,
        unmerged_commits,
        safe,
    }
}

/// Worktrees under `<folder>/.synapse2/worktrees` left behind by old sessions,
/// each with what it still holds. Excludes any worktree backing an open session.
#[tauri::command]
async fn list_orphan_worktrees(state: State<'_, AppState>, folder: String) -> Result<Vec<WorktreeStatus>, String> {
    let root = PathBuf::from(folder.trim());
    let active = state.active_worktrees.lock().clone();
    let mut out = Vec::new();
    for (wt_dir, prefix) in WT_LAYOUTS {
        let Ok(entries) = std::fs::read_dir(root.join(wt_dir).join("worktrees")) else { continue };
        out.extend(
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter(|e| !active.contains_key(&norm_path(&e.path())))
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    valid_worktree_name(&name).then(|| worktree_status(&root, &e.path(), &name, prefix))
                }),
        );
    }
    Ok(out)
}

/// Remove the NAMED leftover worktrees (and their `synapse2/<name>` branches).
/// A worktree that still holds uncommitted files or unmerged commits is only
/// removed when its name is also listed in `discard_work` — the dialog makes
/// the user tick each of those. Worktrees backing an open session are always
/// skipped. Returns what was removed and what was left alone (with why).
#[tauri::command]
fn cleanup_orphan_worktrees(
    state: State<AppState>,
    folder: String,
    names: Vec<String>,
    discard_work: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(folder.trim());
    let discard: HashSet<String> = discard_work.unwrap_or_default().into_iter().collect();
    let active = state.active_worktrees.lock().clone();
    let mut removed: Vec<String> = Vec::new();
    let mut skipped: Vec<serde_json::Value> = Vec::new();
    let mut skip = |name: &str, why: &str| skipped.push(serde_json::json!({ "name": name, "reason": why }));
    for name in names {
        if !valid_worktree_name(&name) {
            skip(&name, "not a session worktree name");
            continue;
        }
        // The folder it lives in says which layout (and so which branch) it is.
        let Some((path, prefix)) = WT_LAYOUTS
            .iter()
            .map(|(d, p)| (root.join(d).join("worktrees").join(&name), *p))
            .find(|(p, _)| p.is_dir())
        else {
            skip(&name, "already gone");
            continue;
        };
        if active.contains_key(&norm_path(&path)) {
            skip(&name, "open in a session");
            continue;
        }
        // Re-check right now: the listing the user saw may be stale.
        let st = worktree_status(&root, &path, &name, prefix);
        let force = discard.contains(&name);
        if !st.safe && !force {
            skip(&name, "still holds work");
            continue;
        }
        let p = path.to_string_lossy().to_string();
        let gone = if force {
            git(&root, &["worktree", "remove", "--force", &p]).is_ok() || {
                // Not a registered worktree any more: delete the folder, then
                // drop git's stale record of it so the branch can go too.
                let ok = std::fs::remove_dir_all(&path).is_ok();
                let _ = git(&root, &["worktree", "prune"]);
                ok
            }
        } else {
            // No --force: git itself refuses if anything is uncommitted.
            git(&root, &["worktree", "remove", &p]).is_ok()
        };
        if !gone {
            skip(&name, "couldn't be removed (is a program using the folder?)");
            continue;
        }
        // -d refuses to drop unmerged commits; -D only on an explicit discard.
        let _ = git(&root, &["branch", if force { "-D" } else { "-d" }, &st.branch]);
        info!(target: "synapse2", worktree = %name, discarded_work = force && !st.safe, "leftover worktree removed");
        removed.push(name);
    }
    Ok(serde_json::json!({ "removed": removed, "skipped": skipped }))
}

/// Characters allowed in the ids we use to build paths (session ids, tool-use
/// ids): never a separator or a dot.
fn safe_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A session id that is safe to put on a `claude`/`codex` command line: both
/// tools use UUIDs, so only that shape is accepted (never something that
/// could read as a flag, like `--dangerously-...`).
fn session_id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// One subagent's own transcript. Claude Code writes each subagent's work to
/// `<session>/subagents/agent-<id>.jsonl` beside a `.meta.json` naming the
/// tool call that launched it. Returns the agent's parsed messages from line
/// `since` on, so the open panel only pays for what is new.
#[tauri::command]
async fn get_agent_run(
    state: State<'_, AppState>,
    session_id: String,
    tool_use_id: String,
    since: Option<usize>,
) -> Result<serde_json::Value, String> {
    if !safe_id(&session_id) || !safe_id(&tool_use_id) {
        return Err("bad id".into());
    }
    let known = state.tails.lock().get(&session_id).and_then(|t| t.path.clone());
    let Some(transcript) = known.or_else(|| find_transcript(&session_id)) else {
        return Ok(serde_json::json!({ "found": false }));
    };
    let Some(dir) = transcript.parent().map(|p| p.join(&session_id).join("subagents")) else {
        return Ok(serde_json::json!({ "found": false }));
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(serde_json::json!({ "found": false }));
    };
    for e in entries.flatten() {
        let p = e.path();
        let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let Some(stem) = fname.strip_suffix(".meta.json") else { continue };
        let Ok(bytes) = std::fs::read(&p) else { continue };
        let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
        if meta.get("toolUseId").and_then(|v| v.as_str()) != Some(tool_use_id.as_str()) {
            continue;
        }
        // `since` is a byte offset that always sits on a line boundary. Read
        // at most a bounded chunk from there; the panel asks again for more.
        const CHUNK: u64 = 4 * 1024 * 1024;
        let since = since.unwrap_or(0) as u64;
        let mut buf = Vec::new();
        let mut more = false;
        if let Ok(mut f) = std::fs::File::open(dir.join(format!("{stem}.jsonl"))) {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            if since < len && f.seek(SeekFrom::Start(since)).is_ok() {
                let _ = f.take(CHUNK).read_to_end(&mut buf);
                more = since + (buf.len() as u64) < len;
            }
        }
        // Only whole lines: the agent may be mid-write on the last one. (A
        // newline byte can never be part of a multibyte character.)
        let whole = match buf.iter().rposition(|&b| b == b'\n') {
            Some(i) => &buf[..=i],
            None => &buf[..0],
        };
        let lines = since + whole.len() as u64;
        let text = String::from_utf8_lossy(whole);
        let mut messages: Vec<Message> = Vec::new();
        for (n, line) in text.lines().enumerate() {
            if !line.trim().is_empty() {
                messages.extend(parse_line(line, n as i64, Some(stem)));
            }
        }
        let s = |k: &str| meta.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        return Ok(serde_json::json!({
            "found": true,
            "agentType": s("agentType"),
            "description": s("description"),
            "finished": meta.get("finished").and_then(|v| v.as_bool()).unwrap_or(false),
            "more": more,
            "lines": lines,
            "messages": messages,
        }));
    }
    Ok(serde_json::json!({ "found": false }))
}

/// Add `pattern` to the repo's `.git/info/exclude` (local-only ignore: never
/// touches the user's tracked `.gitignore`). Idempotent. Resolves the common
/// git dir so it works from a subfolder or from inside a worktree.
fn ensure_git_excluded(repo: &std::path::Path, pattern: &str) -> Result<(), String> {
    let common = git(repo, &["rev-parse", "--git-common-dir"])?;
    let mut common = PathBuf::from(common);
    if common.is_relative() {
        common = repo.join(common);
    }
    let info = common.join("info");
    std::fs::create_dir_all(&info).map_err(|e| e.to_string())?;
    let path = info.join("exclude");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if exclude_has_pattern(&existing, pattern) {
        return Ok(());
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("# HyperVoice Code session worktrees\n");
    out.push_str(pattern);
    out.push('\n');
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

/// True if an exclude file already lists `pattern` (ignoring a trailing `/`).
/// A root-anchored `/.synapse2` doesn't count: it misses a session started
/// from a subfolder of the repo.
fn exclude_has_pattern(contents: &str, pattern: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('/').to_string();
    let want = norm(pattern);
    contents.lines().any(|l| norm(l) == want)
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
/// `~/.hypervoice-code/ratelimits.json` (or the pre-rename `~/.synapse`) by the
/// user's statusline script on every Claude Code statusline refresh. Free to
/// read; no tokens involved.
#[tauri::command]
fn get_rate_limits() -> serde_json::Value {
    statusline::read_rate_limits()
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

/// Is the HyperVoice dictation app installed on this PC? Purely local file checks
/// (nothing is sent anywhere); drives the "talk to Claude" tip in the left rail.
/// Covers the direct installer (per-user or per-machine) and the Store package.
#[tauri::command]
fn hypervoice_installed() -> bool {
    #[cfg(windows)]
    {
        use std::path::PathBuf;
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            let la = PathBuf::from(la);
            candidates.push(la.join("HyperVoice").join("hypervoice.exe"));
            candidates.push(la.join("Packages").join("ChrisCousens.HyperVoice_wr4m8t8n94mh6"));
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(pf) = std::env::var_os(var) {
                candidates.push(PathBuf::from(pf).join("HyperVoice").join("hypervoice.exe"));
            }
        }
        candidates.iter().any(|p| p.exists())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The app id before the rename to HyperVoice Code. Its data folders hold the
/// settings, open tabs, pins and window position.
const OLD_IDENTIFIER: &str = "com.adlistic.synapse";
const NEW_IDENTIFIER: &str = "com.hypervoice.code";

fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(from, to).map(|_| ())
    }
}

/// The new app id gives the app new data folders. On the first run after the
/// rename, copy over what the user would miss (settings and the rest of the
/// page's saved state, and the window position) — not the web cache. The old
/// folders are left as they were. Runs before any window or web view exists.
fn carry_over_old_data() -> Vec<String> {
    let mut notes = Vec::new();
    #[cfg(windows)]
    {
        let items: [(&str, &[&str]); 3] = [
            ("LOCALAPPDATA", &["EBWebView", "Default", "Local Storage"]),
            ("LOCALAPPDATA", &["EBWebView", "Default", "IndexedDB"]),
            ("APPDATA", &[".window-state.json"]),
        ];
        for (var, rel) in items {
            let Some(root) = std::env::var_os(var).map(PathBuf::from) else { continue };
            let (old_base, new_base) = (root.join(OLD_IDENTIFIER), root.join(NEW_IDENTIFIER));
            let (mut old, mut new) = (old_base.clone(), new_base.clone());
            for part in rel {
                old.push(part);
                new.push(part);
            }
            if !old.exists() || new.exists() {
                continue;
            }
            match copy_tree(&old, &new) {
                Ok(()) => notes.push(format!("carried over {}", rel.join("/"))),
                Err(e) => notes.push(format!("couldn't carry over {}: {e}", rel.join("/"))),
            }
        }
    }
    notes
}

pub fn run() {
    let carried = carry_over_old_data();
    let log_dir = statusline::app_dir().join("logs");
    let _log_guard = synapse_core::diag::init(&log_dir, true).ok();
    info!(target: "synapse2", "HyperVoice Code starting");
    for n in &carried {
        info!(target: "synapse2", "{n} from the pre-rename app data");
    }
    statusline::upgrade_legacy_hook();

    let state = AppState {
        tails: Arc::new(Mutex::new(HashMap::new())),
        aliases: Arc::new(Mutex::new(HashMap::new())),
        active_worktrees: Arc::new(Mutex::new(HashMap::new())),
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
            match event {
                tauri::WindowEvent::Focused(true) => {
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        updater::check(app, false).await;
                    });
                }
                // Save geometry whenever focus leaves the app: the plugin only
                // saves on graceful exit, so a force-killed process (or the
                // update installer replacing us) would otherwise resurrect a
                // stale position — often on the wrong monitor.
                tauri::WindowEvent::Focused(false) => {
                    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                    let _ = window.app_handle().save_window_state(StateFlags::all());
                }
                _ => {}
            }
        })
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title("HyperVoice Code");
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
            // Free build: no sign-in, so don't register the scheme (the Store
            // package has no protocol extension either).
            #[cfg(any(windows, target_os = "linux"))]
            if !hv_auth::FREE_FOR_ALL && !packaging::is_packaged() {
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
            get_agent_run,
            save_text_file,
            get_rate_limits,
            delete_claude_session,
            statusline::statusline_status,
            statusline::install_statusline_hook,
            sessions::list_claude_sessions,
            sessions::search_sessions,
            codex::agent_status,
            codex::list_codex_sessions,
            clip_get,
            clip_set,
            open_external,
            hypervoice_installed,
            packaging::get_install_source,
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
        .expect("error while running HyperVoice Code");
}

#[cfg(test)]
mod tests {
    #[test]
    fn perm_flags_only_known_modes() {
        assert_eq!(perm_flags(Agent::Claude, None, false).unwrap(), ("default", ""));
        assert_eq!(perm_flags(Agent::Claude, None, true).unwrap().1, " --dangerously-skip-permissions");
        assert_eq!(perm_flags(Agent::Claude, Some("auto"), true).unwrap().1, " --permission-mode auto");
        assert_eq!(perm_flags(Agent::Codex, Some("bypass"), false).unwrap().1, " --dangerously-bypass-approvals-and-sandbox");
        assert!(perm_flags(Agent::Codex, Some("plan"), false).is_err());
        assert!(perm_flags(Agent::Claude, Some("auto & calc"), false).is_err());
    }

    use super::*;

    fn codex_lines() -> Vec<String> {
        let at = |s: u32| format!("2026-11-19T06:00:{s:02}.000Z");
        vec![
            format!(r#"{{"timestamp":"{}","ordinal":1,"type":"session_meta","payload":{{"id":"01a1f2aa-0000-7000-8000-0000000000aa","cwd":"D:\\Proj","source":"cli","timestamp":"{}"}}}}"#, at(0), at(0)),
            format!(r#"{{"timestamp":"{}","ordinal":2,"type":"event_msg","payload":{{"type":"task_started","turn_id":"t","model_context_window":272000}}}}"#, at(1)),
            format!(r#"{{"timestamp":"{}","ordinal":3,"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"UserMessage","id":"u1","content":[{{"type":"text","text":"hi"}}]}}}}}}"#, at(2)),
            format!(r#"{{"timestamp":"{}","ordinal":4,"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"CommandExecution","id":"c1","command":["bash","-lc","ls"],"status":"completed","aggregated_output":"a\n","exit_code":0}}}}}}"#, at(3)),
            format!(r#"{{"timestamp":"{}","ordinal":5,"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"cached_input_tokens":40,"output_tokens":9}},"last_token_usage":{{"input_tokens":60,"output_tokens":9}},"model_context_window":272000}},"rate_limits":{{"primary":{{"used_percent":5.0,"window_minutes":300,"resets_at":1}}}}}}}}"#, at(4)),
            format!(r#"{{"timestamp":"{}","ordinal":6,"type":"event_msg","payload":{{"type":"item_completed","item":{{"type":"AgentMessage","id":"a1","content":[{{"type":"Text","text":"done"}}]}}}}}}"#, at(5)),
            format!(r#"{{"timestamp":"{}","ordinal":7,"type":"event_msg","payload":{{"type":"task_complete","turn_id":"t"}}}}"#, at(6)),
        ]
    }

    /// A live Codex file read in two goes, then read again from the start
    /// (as when Codex rewrites it): nothing is lost and nothing doubles.
    #[test]
    fn codex_tail_is_incremental_and_never_doubles() {
        let dir = std::env::temp_dir().join(format!("syn2-codex-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("rollout-2026-11-19T08-00-00-01a1f2aa-0000-7000-8000-0000000000aa.jsonl");
        let lines = codex_lines();
        std::fs::write(&f, lines[..3].join("\n") + "\n" + &lines[3][..20]).unwrap(); // ends mid-line
        let mut tail = SessionTail { alive: true, agent: Agent::Codex, path: Some(f.clone()), ..Default::default() };
        assert!(drain_tail(&mut tail));
        assert_eq!(tail.messages.len(), 1); // the prompt; the half line waits
        assert_eq!(tail.stats.turn_open, Some(true));
        std::fs::write(&f, lines.join("\n") + "\n").unwrap();
        assert!(drain_tail(&mut tail));
        let kinds: Vec<_> = tail.messages.iter().map(|m| m.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "toolcall", "toolresult", "message"]);
        assert_eq!(tail.stats.turn_open, Some(false));
        assert_eq!(tail.usage.input, 60);
        assert_eq!(tail.usage.cache_read, 40);
        assert_eq!(tail.stats.context_tokens, 69);
        assert_eq!(tail.stats.context_window, 272000);
        assert!(tail.stats.rate_limits.is_some());
        assert_eq!(tail.stats.turns, 1);
        // Re-read from the top: ordinals filter out everything already shown.
        tail.offset = 0;
        tail.partial.clear();
        assert!(!drain_tail(&mut tail));
        assert_eq!(tail.messages.len(), 4);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A just-started Codex session is found by folder and start time, and an
    /// older session in the same folder or one in another folder is not.
    #[test]
    fn codex_new_session_is_discovered_by_folder_and_time() {
        let home = std::env::temp_dir().join(format!("syn2-codexhome-{}", new_id()));
        let day = home.join("sessions").join("2026").join("11").join("19");
        std::fs::create_dir_all(&day).unwrap();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let iso = |ms: i64| {
            // Good enough for the test: whole seconds since the epoch → RFC 3339.
            let secs = ms / 1000;
            let days = secs.div_euclid(86_400);
            let rem = secs.rem_euclid(86_400);
            // civil-from-days (Howard Hinnant)
            let z = days + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = if m <= 2 { y + 1 } else { y };
            format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
        };
        let write = |id: &str, cwd: &str, started: i64| {
            let line = format!(
                r#"{{"timestamp":"{t}","ordinal":1,"type":"session_meta","payload":{{"id":"{id}","cwd":"{cwd}","source":"vscode","originator":"codex-tui","timestamp":"{t}"}}}}"#,
                t = iso(started),
                cwd = cwd.replace('\\', "\\\\")
            );
            std::fs::write(day.join(format!("rollout-2026-11-19T08-00-00-{id}.jsonl")), line + "\n").unwrap();
        };
        write("01a1f2aa-0000-7000-8000-000000000001", r"\\?\D:\Proj", now - 3_600_000); // older, same folder
        write("01a1f2aa-0000-7000-8000-000000000002", r"D:\Other", now + 1_000); // other folder
        write("01a1f2aa-0000-7000-8000-000000000003", r"D:\proj\", now + 2_000); // ours
        std::env::set_var("CODEX_HOME", &home);
        let found = codex::discover(&codex::norm_dir(r"D:\Proj"), now, &HashSet::new());
        assert_eq!(found.as_ref().map(|f| f.0.as_str()), Some("01a1f2aa-0000-7000-8000-000000000003"));
        // Already followed by another tab → not handed out twice.
        let claimed: HashSet<PathBuf> = found.into_iter().map(|f| f.1).collect();
        assert!(codex::discover(&codex::norm_dir(r"D:\Proj"), now, &claimed).is_none());
        assert_eq!(
            codex::find_rollout("01a1f2aa-0000-7000-8000-000000000001").map(|p| p.exists()),
            Some(true)
        );
        std::env::remove_var("CODEX_HOME");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn worktree_names_cannot_escape() {
        assert!(valid_worktree_name("a1b2c3d4"));
        for bad in ["", "..", "../x", "a/b", "a:b", "a.b", "C:"] {
            assert!(!valid_worktree_name(bad), "{bad}");
        }
        assert!(safe_id("toolu_019S2utVFUnKJyGHCB1o8sht"));
        assert!(!safe_id("../../etc"));
        assert!(session_id_ok("01a1f25e-d2e7-74e3-a450-7be1e49f2014"));
        assert!(!session_id_ok("--dangerously-bypass-approvals-and-sandbox"));
        assert!(!session_id_ok("01a1f25e-d2e7-74e3-a450-7be1e49f201;"));
    }

    #[test]
    fn new_and_old_worktree_layouts_are_both_recognised() {
        let root = std::env::temp_dir().join(format!("syn2-test-{}", new_id()));
        let wm = WorktreeManager::new(root.clone());
        wm.init().unwrap();
        std::fs::write(root.join("a.txt"), "one").unwrap();
        wm.commit_all("init").unwrap();
        for (dir, prefix, name) in [(".hvcode", "hvcode/", "new12345"), (".synapse2", "synapse2/", "old12345")] {
            let wt = root.join(dir).join("worktrees").join(name);
            std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
            wm.add(&format!("{prefix}{name}"), &wt, None).unwrap();
            assert_eq!(session_worktree(&wt), Some((root.clone(), Some(format!("{prefix}{name}")))));
            assert!(worktree_status(&root, &wt, name, prefix).safe);
        }
        // Some other dot-folder is not ours.
        let other = root.join(".other").join("worktrees").join("abc12345");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(session_worktree(&other), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn leftover_worktree_with_work_is_never_safe() {
        let root = std::env::temp_dir().join(format!("syn2-test-{}", new_id()));
        let wm = WorktreeManager::new(root.clone());
        wm.init().unwrap();
        std::fs::write(root.join("a.txt"), "one").unwrap();
        wm.commit_all("init").unwrap();
        let name = "abc12345";
        let wt = root.join(".synapse2").join("worktrees").join(name);
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        wm.add(&format!("synapse2/{name}"), &wt, None).unwrap();

        // Fresh worktree: nothing to lose.
        let st = worktree_status(&root, &wt, name, "synapse2/");
        assert_eq!((st.changed_files, st.unmerged_commits, st.safe), (Some(0), Some(0), true));
        assert_eq!(session_worktree(&wt), Some((root.clone(), Some(format!("synapse2/{name}")))));

        // An uncommitted file makes it unsafe.
        std::fs::write(wt.join("new.txt"), "work").unwrap();
        let st = worktree_status(&root, &wt, name, "synapse2/");
        assert_eq!(st.changed_files, Some(1));
        assert!(!st.safe);

        // Committed but unmerged work is unsafe too.
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work"]).unwrap();
        let st = worktree_status(&root, &wt, name, "synapse2/");
        assert_eq!((st.changed_files, st.unmerged_commits, st.safe), (Some(0), Some(1), false));

        // A plain folder that isn't a worktree is "unknown", never safe.
        let stray = root.join(".synapse2").join("worktrees").join("stray123");
        std::fs::create_dir_all(&stray).unwrap();
        let st = worktree_status(&root, &stray, "stray123", "synapse2/");
        assert_eq!(st.changed_files, None);
        assert!(!st.safe);
        assert_eq!(session_worktree(&root), None);

        // Merge that work so the branch is clean again, then test the rest.
        git(&root, &["merge", "-q", "--no-edit", &format!("synapse2/{name}")]).unwrap();
        assert!(worktree_status(&root, &wt, name, "synapse2/").safe);

        // An ignored file (.env, build output) is deleted with the folder.
        std::fs::write(wt.join(".gitignore"), "*.secret\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ignore"]).unwrap();
        git(&root, &["merge", "-q", "--no-edit", &format!("synapse2/{name}")]).unwrap();
        std::fs::write(wt.join("key.secret"), "x").unwrap();
        let st = worktree_status(&root, &wt, name, "synapse2/");
        assert_eq!((st.changed_files, st.ignored_files), (Some(0), Some(1)));
        assert_eq!(st.ignored_example.as_deref(), Some("key.secret"));
        assert!(!st.safe);
        std::fs::remove_file(wt.join("key.secret")).unwrap();
        assert!(worktree_status(&root, &wt, name, "synapse2/").safe);

        // A commit on a detached HEAD belongs to no branch: never safe.
        git(&wt, &["checkout", "-q", "--detach"]).unwrap();
        std::fs::write(wt.join("loose.txt"), "x").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "loose"]).unwrap();
        let st = worktree_status(&root, &wt, name, "synapse2/");
        assert_eq!((st.changed_files, st.unmerged_commits, st.safe), (Some(0), Some(1), false));
        // Off its session branch it is still ours to protect, but has no branch to merge.
        assert_eq!(session_worktree(&wt), Some((root.clone(), None)));

        let _ = git(&root, &["worktree", "remove", "--force", &wt.to_string_lossy()]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
