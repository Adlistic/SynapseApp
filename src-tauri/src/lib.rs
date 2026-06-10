//! Synapse 2 — a Claude Code viewer.
//!
//! An embedded terminal runs the real `claude` CLI under a session id we mint;
//! the right-hand panel tails that session's transcript JSONL on disk and parses
//! it (via `synapse-core`) into navigable turns. The terminal stays a fully
//! normal interactive shell — the feed is built from the transcript, not by
//! scraping the terminal.

mod hv_auth;
mod terminals;

use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};
use tracing::info;

use synapse_core::transcript::parse_line;
use synapse_core::util::new_id;
use synapse_core::worktree::WorktreeManager;

struct AppState {
    /// session id → resolved transcript path (cached once located on disk).
    transcript_paths: Mutex<HashMap<String, PathBuf>>,
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
fn claude_projects_dir() -> Option<PathBuf> {
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
/// embedded terminal.
#[tauri::command]
fn start_session(opts: SessionOpts) -> Result<serde_json::Value, String> {
    let folder = opts.folder.trim();
    if folder.is_empty() {
        return Err("Choose a folder first.".into());
    }
    let mut cwd = PathBuf::from(folder);
    if !cwd.is_dir() {
        return Err(format!("Not a folder: {folder}"));
    }

    let mut branch: Option<String> = None;
    if opts.worktrees {
        let wm = WorktreeManager::new(cwd.clone());
        if wm.is_git_repo() {
            let id = new_id();
            let short = &id[..8.min(id.len())];
            let b = format!("synapse2/{short}");
            let wt = cwd.join(".synapse2").join("worktrees").join(short);
            std::fs::create_dir_all(wt.parent().unwrap()).ok();
            match wm.add(&b, &wt, None) {
                Ok(p) => {
                    info!(target: "synapse2", branch = %b, path = %p.display(), "created worktree");
                    cwd = p;
                    branch = Some(b);
                }
                Err(e) => {
                    info!(target: "synapse2", error = %e, "worktree failed; using the folder directly");
                }
            }
        }
    }

    let session_id = new_id();
    let mut command = format!("claude --session-id {session_id}");
    if opts.full_autonomy {
        command.push_str(" --dangerously-skip-permissions");
    }
    info!(target: "synapse2", session = %session_id, cwd = %cwd.display(), full_autonomy = opts.full_autonomy, worktree = ?branch, "session start");

    Ok(serde_json::json!({
        "sessionId": session_id,
        "cwd": cwd.to_string_lossy(),
        "command": command,
        "branch": branch,
    }))
}

/// Return the parsed transcript for a session (flat, typed messages). The
/// frontend groups them into turns. `ready` is false until the file appears.
#[tauri::command]
fn get_conversation(state: State<AppState>, session_id: String) -> serde_json::Value {
    let path = {
        let mut paths = state.transcript_paths.lock();
        if let Some(p) = paths.get(&session_id) {
            Some(p.clone())
        } else if let Some(p) = find_transcript(&session_id) {
            paths.insert(session_id.clone(), p.clone());
            Some(p)
        } else {
            None
        }
    };
    let Some(path) = path else {
        return serde_json::json!({ "ready": false, "messages": [] });
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return serde_json::json!({ "ready": false, "messages": [] }),
    };
    let mut msgs = Vec::new();
    let mut ts = 0i64;
    for line in content.lines() {
        ts += 1;
        for m in parse_line(line, ts, None) {
            msgs.push(m);
        }
    }
    serde_json::json!({ "ready": true, "messages": msgs })
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
    #[cfg(windows)]
    let r = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
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
        transcript_paths: Mutex::new(HashMap::new()),
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .manage(terminals::Terminals::default())
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
            get_conversation,
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
            terminals::term_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Synapse");
}
