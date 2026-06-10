//! Real embedded terminals — ConPTY/PTY-backed shells streamed to xterm.js in
//! the UI. This is the "terminal-first" substrate (à la Plyrium Forge /
//! BridgeSpace): genuine interactive shells inside Synapse, where dev servers
//! run and humans (and later agents) work, decoupled from one-shot turns.
//!
//! Protocol:
//!   - `term_open` spawns a shell on a PTY, returns an id, and streams output
//!     bytes to the frontend via the `term-data` event ({ id, bytes }).
//!   - `term_input` writes the user's keystrokes to the PTY.
//!   - `term_resize` keeps the PTY's window size in sync with xterm.
//!   - `term_close` kills the shell. `term-exit` fires when a shell ends.

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter, State};
use tracing::info;

struct TermSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Live terminal sessions, keyed by id. Managed Tauri state.
#[derive(Default)]
pub struct Terminals {
    inner: Mutex<HashMap<String, TermSession>>,
}

/// The default interactive shell for the platform.
fn default_shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        CommandBuilder::new("powershell.exe")
    }
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
        CommandBuilder::new(sh)
    }
}

/// Open a new terminal: spawn a shell on a PTY and stream its output.
#[tauri::command]
pub fn term_open(
    app: AppHandle,
    state: State<Terminals>,
    rows: Option<u16>,
    cols: Option<u16>,
    cwd: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    let rows = rows.unwrap_or(24).max(1);
    let cols = cols.unwrap_or(80).max(1);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = default_shell();
    // Mark this shell (and anything launched in it, e.g. `claude`) as running
    // inside Synapse, so an env-aware status line can hide itself here while
    // staying visible in a normal terminal.
    cmd.env("SYNAPSE_TERMINAL", "1");
    if let Some(dir) = cwd.as_ref().filter(|d| !d.trim().is_empty()) {
        if std::path::Path::new(dir).is_dir() {
            cmd.cwd(dir);
        }
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Optionally run a command in the fresh shell (e.g. a dev server). The PTY
    // buffers input, so the shell picks it up once it's ready.
    if let Some(c) = command.as_ref().filter(|c| !c.trim().is_empty()) {
        let line = format!("{}\r\n", c.trim());
        let _ = writer.write_all(line.as_bytes());
        let _ = writer.flush();
    }

    let id = synapse_core::util::short_id();
    info!(target: "synapse::desktop", id = %id, "terminal opened");

    // Reap the child when it exits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    // Stream PTY output to the frontend.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = app.emit("term-exit", id.clone());
                        break;
                    }
                    Ok(n) => {
                        let _ = app.emit(
                            "term-data",
                            serde_json::json!({ "id": id, "bytes": &buf[..n] }),
                        );
                    }
                }
            }
        });
    }

    state
        .inner
        .lock()
        .insert(id.clone(), TermSession { writer, master: pair.master, killer });
    Ok(id)
}

/// Write the user's keystrokes into the terminal.
#[tauri::command]
pub fn term_input(state: State<Terminals>, id: String, data: String) -> Result<(), String> {
    let mut map = state.inner.lock();
    let s = map.get_mut(&id).ok_or("no such terminal")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Keep the PTY window size in sync with the xterm viewport.
#[tauri::command]
pub fn term_resize(state: State<Terminals>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = state.inner.lock();
    let s = map.get(&id).ok_or("no such terminal")?;
    s.master
        .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Kill a terminal's shell and drop it.
#[tauri::command]
pub fn term_close(state: State<Terminals>, id: String) -> Result<(), String> {
    if let Some(mut s) = state.inner.lock().remove(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}
