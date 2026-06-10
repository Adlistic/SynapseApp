//! Agent runner abstraction. An *agent* is a session driven by some backend.
//! [`AgentRunner`] spawns [`AgentHandle`]s that emit [`AgentEvent`]s over a
//! channel. Two implementations:
//!   * [`MockRunner`] — deterministic, no tokens, used by the test suite and the
//!     CLI `--mock` mode.
//!   * [`ClaudeCliRunner`] — drives the real `claude` CLI in `stream-json` mode.
//!
//! Keeping this behind a trait is also the provider-agnostic seam: a future
//! GPT/Gemini/local runner implements the same trait.

use crate::roles::{PermissionMode, Role};
use crate::transcript::parse_line;
use crate::types::{AgentStatus, Message, MessageKind};
use crate::util::{new_id, now_ms};
use anyhow::Result;
use parking_lot::Mutex;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, error, info, warn};

/// Hard cap on a single agent turn. Guards against an agent launching a
/// long-running process (e.g. `npm start`) that never exits and would otherwise
/// hang the whole run.
const TURN_TIMEOUT_SECS: u64 = 720;

/// On Windows, stop a spawned console subprocess (claude, taskkill, …) from
/// flashing a terminal window when launched from the GUI app. No-op elsewhere.
pub fn hide_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Best-effort kill of a process tree by PID.
fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut c = std::process::Command::new("taskkill");
        c.args(["/F", "/T", "/PID", &pid.to_string()]);
        hide_window(&mut c);
        let _ = c.spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .spawn();
    }
}

/// What to spawn.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub session_id: String,
    pub name: String,
    pub role: Role,
    pub cwd: PathBuf,
    /// Team default model used when the role doesn't pin one.
    pub model_default: Option<String>,
}

/// An event from an agent.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    Spawned { session_id: String },
    Message(Message),
    Status(AgentStatus),
    Exited(i32),
    Error(String),
}

/// A live agent handle.
pub trait AgentHandle: Send {
    fn session_id(&self) -> &str;
    fn name(&self) -> &str;
    /// Deliver a prompt / task to the agent.
    fn send(&self, prompt: &str) -> Result<()>;
    /// Non-blocking poll for the next event.
    fn try_event(&self) -> Option<AgentEvent>;
    /// Request shutdown.
    fn stop(&self);
}

pub trait AgentRunner: Send + Sync {
    fn spawn(&self, spec: SpawnSpec) -> Result<Box<dyn AgentHandle>>;
}

// ───────────────────────── MockRunner ─────────────────────────

/// Deterministic runner. On `send`, it emits Working → an assistant Message →
/// Done, and (optionally) writes a file into the agent's cwd so worktree
/// isolation can be asserted without spending tokens.
pub struct MockRunner {
    pub simulate_edits: bool,
}

impl MockRunner {
    pub fn new() -> Self {
        MockRunner { simulate_edits: false }
    }
    /// Mock that writes `<name>.out` into the agent cwd on each task.
    pub fn with_edits() -> Self {
        MockRunner { simulate_edits: true }
    }
}

impl Default for MockRunner {
    fn default() -> Self {
        Self::new()
    }
}

struct MockHandle {
    session_id: String,
    name: String,
    cwd: PathBuf,
    simulate_edits: bool,
    tx: Sender<AgentEvent>,
    rx: Mutex<Receiver<AgentEvent>>,
}

impl AgentHandle for MockHandle {
    fn session_id(&self) -> &str {
        &self.session_id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn send(&self, prompt: &str) -> Result<()> {
        let _ = self.tx.send(AgentEvent::Status(AgentStatus::Working));
        if self.simulate_edits {
            // Simulate the agent doing real work inside its own worktree.
            let out = self.cwd.join(format!("{}.out", crate::util::slug(&self.name)));
            std::fs::create_dir_all(&self.cwd).ok();
            std::fs::write(&out, format!("{} handled: {}", self.name, prompt)).ok();
        }
        let msg = Message {
            id: new_id(),
            role: "assistant".into(),
            kind: MessageKind::Message,
            text: format!("done: {}", prompt),
            tool_name: None,
            tool_category: None,
            tool_use_id: None,
            is_error: false,
            agent_id: Some(self.name.clone()),
            session_id: Some(self.session_id.clone()),
            ts: now_ms(),
            edit_data: None,
        };
        let _ = self.tx.send(AgentEvent::Message(msg));
        let _ = self.tx.send(AgentEvent::Status(AgentStatus::Done));
        Ok(())
    }
    fn try_event(&self) -> Option<AgentEvent> {
        self.rx.lock().try_recv().ok()
    }
    fn stop(&self) {
        let _ = self.tx.send(AgentEvent::Status(AgentStatus::Stopped));
    }
}

impl AgentRunner for MockRunner {
    fn spawn(&self, spec: SpawnSpec) -> Result<Box<dyn AgentHandle>> {
        let (tx, rx) = channel();
        let _ = tx.send(AgentEvent::Spawned {
            session_id: spec.session_id.clone(),
        });
        let _ = tx.send(AgentEvent::Status(AgentStatus::Idle));
        Ok(Box::new(MockHandle {
            session_id: spec.session_id,
            name: spec.name,
            cwd: spec.cwd,
            simulate_edits: self.simulate_edits,
            tx,
            rx: Mutex::new(rx),
        }))
    }
}

// ───────────────────────── ClaudeCliRunner ─────────────────────────

/// Drives the real `claude` CLI. Each `send` runs one non-interactive turn
/// (`claude -p ... --output-format stream-json`), streaming parsed messages back
/// as events. The first turn mints the session via `--session-id`; subsequent
/// turns `--resume` it.
pub struct ClaudeCliRunner {
    /// The program to execute (a real `.exe`, `node`, or `cmd`).
    program: String,
    /// Leading args inserted before the claude args (e.g. `/c claude` for cmd).
    prefix: Vec<String>,
}

/// Resolve a runnable `claude` invocation. `std::process::Command` can't run the
/// npm `.cmd`/`.ps1` shims directly, so prefer the real `claude.exe` the shim
/// points at; fall back to `cmd /c claude` on Windows, or plain `claude`.
pub fn resolve_claude() -> (String, Vec<String>) {
    if let Ok(p) = std::env::var("SYNAPSE_CLAUDE_BIN") {
        if !p.trim().is_empty() {
            return (p, Vec::new());
        }
    }
    #[cfg(windows)]
    {
        // npm global install layout.
        for base in [std::env::var("APPDATA").ok(), std::env::var("USERPROFILE").ok()]
            .into_iter()
            .flatten()
        {
            let candidates = [
                format!("{base}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"),
                format!("{base}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"),
            ];
            for c in candidates {
                if std::path::Path::new(&c).exists() {
                    return (c, Vec::new());
                }
            }
        }
        return ("cmd".to_string(), vec!["/c".to_string(), "claude".to_string()]);
    }
    #[cfg(not(windows))]
    {
        ("claude".to_string(), Vec::new())
    }
}

/// Run a single non-interactive `claude` turn and return its final text result.
/// Used by the LLM Director/planner. Blocks until the turn completes.
pub fn claude_oneshot(prompt: &str, model: Option<&str>, cwd: &std::path::Path) -> Result<String> {
    let (program, prefix) = resolve_claude();
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt.into(),
        "--output-format".into(),
        "json".into(),
    ];
    if let Some(m) = model {
        if !m.is_empty() {
            args.push("--model".into());
            args.push(m.into());
        }
    }
    info!(target: "synapse::director", model = model.unwrap_or(""), prompt_len = prompt.len(), "planning call");
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&prefix).args(&args).current_dir(cwd);
    hide_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| anyhow::anyhow!("spawn claude (planner) failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        error!(target: "synapse::director", code = out.status.code().unwrap_or(-1), "planning call failed: {}", stderr.trim());
        anyhow::bail!("claude planner exited {}: {}", out.status.code().unwrap_or(-1), stderr.trim());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| anyhow::anyhow!("planner output was not JSON: {e}"))?;
    let result = v
        .get("result")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .to_string();
    Ok(result)
}

/// Run a single read-only `claude` turn for the Director's CHAT (not planning):
/// answers a user question, optionally inspecting the workspace with read-only
/// tools (Read/Glob/Grep) so it can give accurate run/test instructions. No
/// skip-permissions and no write tools, so it can never modify the user's files.
/// Blocks until the turn completes; returns the final text.
pub fn claude_consult(prompt: &str, model: Option<&str>, cwd: &std::path::Path) -> Result<String> {
    let (program, prefix) = resolve_claude();
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt.into(),
        "--output-format".into(),
        "json".into(),
        // Read-only toolset. These are auto-approved in headless mode, so the
        // call won't hang waiting for a permission prompt, and nothing can be
        // written or executed.
        "--allowedTools".into(),
        "Read,Glob,Grep".into(),
    ];
    if let Some(m) = model {
        if !m.is_empty() {
            args.push("--model".into());
            args.push(m.into());
        }
    }
    info!(target: "synapse::director", model = model.unwrap_or(""), prompt_len = prompt.len(), "director chat call");
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&prefix).args(&args).current_dir(cwd);
    hide_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| anyhow::anyhow!("spawn claude (director chat) failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        error!(target: "synapse::director", code = out.status.code().unwrap_or(-1), "director chat call failed: {}", stderr.trim());
        anyhow::bail!("claude exited {}: {}", out.status.code().unwrap_or(-1), stderr.trim());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| anyhow::anyhow!("director chat output was not JSON: {e}"))?;
    Ok(v.get("result").and_then(|r| r.as_str()).unwrap_or("").to_string())
}

impl ClaudeCliRunner {
    pub fn new() -> Self {
        let (program, prefix) = resolve_claude();
        ClaudeCliRunner { program, prefix }
    }
    pub fn with_bin(bin: &str) -> Self {
        ClaudeCliRunner {
            program: bin.to_string(),
            prefix: Vec::new(),
        }
    }
}

impl Default for ClaudeCliRunner {
    fn default() -> Self {
        Self::new()
    }
}

struct ClaudeHandle {
    session_id: String,
    name: String,
    cwd: PathBuf,
    role: Role,
    program: String,
    prefix: Vec<String>,
    model_default: Option<String>,
    started: Mutex<bool>,
    tx: Sender<AgentEvent>,
    rx: Mutex<Receiver<AgentEvent>>,
}

impl ClaudeHandle {
    fn build_args(&self, prompt: &str, first: bool) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
        ];
        if first {
            args.push("--session-id".into());
            args.push(self.session_id.clone());
        } else {
            args.push("--resume".into());
            args.push(self.session_id.clone());
        }
        let model = if self.role.model.is_empty() {
            self.model_default.clone().unwrap_or_default()
        } else {
            self.role.model.clone()
        };
        if !model.is_empty() {
            args.push("--model".into());
            args.push(model);
        }
        if !self.role.tools.is_empty() {
            args.push("--allowedTools".into());
            args.push(self.role.tools.join(","));
        }
        match self.role.permission_mode {
            PermissionMode::Plan => {
                args.push("--permission-mode".into());
                args.push("plan".into());
            }
            PermissionMode::AcceptEdits => {
                args.push("--permission-mode".into());
                args.push("acceptEdits".into());
            }
            PermissionMode::DontAsk => {
                args.push("--permission-mode".into());
                args.push("dontAsk".into());
            }
            // Full autonomy: nothing needs approval. The flag overrides
            // --allowedTools, so this is what makes unattended building work.
            PermissionMode::Bypass => {
                args.push("--dangerously-skip-permissions".into());
            }
            PermissionMode::Default => {}
        }
        args
    }
}

impl AgentHandle for ClaudeHandle {
    fn session_id(&self) -> &str {
        &self.session_id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn send(&self, prompt: &str) -> Result<()> {
        let first = {
            let mut s = self.started.lock();
            let was = !*s;
            *s = true;
            was
        };
        let args = self.build_args(prompt, first);
        let tx = self.tx.clone();
        let program = self.program.clone();
        let prefix = self.prefix.clone();
        let cwd = self.cwd.clone();
        let name = self.name.clone();
        let session_id = self.session_id.clone();

        // Build a loggable command line with the (potentially large/sensitive)
        // prompt elided.
        let argline = {
            let mut shown: Vec<String> = Vec::new();
            let mut elide = false;
            for a in prefix.iter().chain(args.iter()) {
                if elide {
                    shown.push(format!("<prompt:{}chars>", a.len()));
                    elide = false;
                } else if a == "-p" {
                    shown.push(a.clone());
                    elide = true;
                } else {
                    shown.push(a.clone());
                }
            }
            shown.join(" ")
        };
        info!(target: "synapse::runner", agent = %self.name, first, cwd = %self.cwd.display(), "exec: {} {}", program, argline);

        let _ = tx.send(AgentEvent::Status(AgentStatus::Working));
        std::thread::spawn(move || {
            let mut command = std::process::Command::new(&program);
            command
                .args(&prefix)
                .args(&args)
                .current_dir(&cwd)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            hide_window(&mut command);
            let child = command.spawn();
            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    error!(target: "synapse::runner", agent = %name, program = %program, "spawn failed: {}", e);
                    let _ = tx.send(AgentEvent::Error(format!("spawn claude failed: {e}")));
                    let _ = tx.send(AgentEvent::Status(AgentStatus::Errored));
                    return;
                }
            };

            // Watchdog: kill the turn if it runs past the timeout (e.g. an agent
            // started a server that never returns).
            let pid = child.id();
            let done = Arc::new(AtomicBool::new(false));
            {
                let done = done.clone();
                let agent = name.clone();
                std::thread::spawn(move || {
                    let step = Duration::from_millis(500);
                    let mut waited = Duration::ZERO;
                    let timeout = Duration::from_secs(TURN_TIMEOUT_SECS);
                    while waited < timeout {
                        if done.load(Ordering::Relaxed) {
                            return;
                        }
                        std::thread::sleep(step);
                        waited += step;
                    }
                    if !done.load(Ordering::Relaxed) {
                        warn!(target: "synapse::runner", agent = %agent, pid, timeout_s = TURN_TIMEOUT_SECS, "agent turn exceeded timeout; killing process (likely a long-running command)");
                        kill_process_tree(pid);
                    }
                });
            }

            // Drain stderr on its own thread — this is the #1 thing needed to
            // diagnose a real-Claude failure, and was previously discarded.
            let stderr_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let stderr_handle = child.stderr.take().map(|stderr| {
                let buf = stderr_buf.clone();
                let agent = name.clone();
                std::thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines().map_while(Result::ok) {
                        if line.trim().is_empty() {
                            continue;
                        }
                        warn!(target: "synapse::runner::stderr", agent = %agent, "{}", line);
                        let mut b = buf.lock();
                        if b.len() < 200 {
                            b.push(line);
                        }
                    }
                })
            });

            let mut msg_count = 0usize;
            if let Some(stdout) = child.stdout.take() {
                let reader = BufReader::new(stdout);
                for line in reader.lines().map_while(Result::ok) {
                    let parsed = parse_line(&line, now_ms(), Some(&name));
                    if parsed.is_empty() {
                        // Lines we intentionally skip (system/result/rate_limit)
                        // are fine; log others at debug so nothing is invisible.
                        let trimmed = line.trim();
                        if !trimmed.is_empty()
                            && !trimmed.contains("\"type\":\"system\"")
                            && !trimmed.contains("\"type\":\"result\"")
                            && !trimmed.contains("\"type\":\"rate_limit_event\"")
                        {
                            let preview: String = trimmed.chars().take(300).collect();
                            debug!(target: "synapse::runner::stdout", agent = %name, "unparsed line: {}", preview);
                        }
                        continue;
                    }
                    for mut m in parsed {
                        msg_count += 1;
                        if m.session_id.is_none() {
                            m.session_id = Some(session_id.clone());
                        }
                        let _ = tx.send(AgentEvent::Message(m));
                    }
                }
            }

            if let Some(h) = stderr_handle {
                let _ = h.join();
            }
            let status = child.wait();
            done.store(true, Ordering::Relaxed); // stop the watchdog
            let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
            let stderr_tail = stderr_buf.lock().join("\n");

            if code == 0 {
                info!(target: "synapse::runner", agent = %name, code, messages = msg_count, "claude turn finished");
            } else {
                error!(target: "synapse::runner", agent = %name, code, messages = msg_count, "claude turn FAILED; stderr: {}", stderr_tail);
                let detail = if stderr_tail.is_empty() {
                    format!("claude exited with code {code} (no stderr)")
                } else {
                    format!("claude exited with code {code}: {stderr_tail}")
                };
                let _ = tx.send(AgentEvent::Error(detail));
            }
            let _ = tx.send(AgentEvent::Exited(code));
            let _ = tx.send(AgentEvent::Status(if code == 0 {
                AgentStatus::Done
            } else {
                AgentStatus::Errored
            }));
        });
        Ok(())
    }
    fn try_event(&self) -> Option<AgentEvent> {
        self.rx.lock().try_recv().ok()
    }
    fn stop(&self) {
        let _ = self.tx.send(AgentEvent::Status(AgentStatus::Stopped));
    }
}

impl AgentRunner for ClaudeCliRunner {
    fn spawn(&self, spec: SpawnSpec) -> Result<Box<dyn AgentHandle>> {
        let (tx, rx) = channel();
        let _ = tx.send(AgentEvent::Spawned {
            session_id: spec.session_id.clone(),
        });
        let _ = tx.send(AgentEvent::Status(AgentStatus::Idle));
        Ok(Box::new(ClaudeHandle {
            session_id: spec.session_id,
            name: spec.name,
            cwd: spec.cwd,
            role: spec.role,
            program: self.program.clone(),
            prefix: self.prefix.clone(),
            model_default: spec.model_default,
            started: Mutex::new(false),
            tx,
            rx: Mutex::new(rx),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::RoleLibrary;

    fn spec(name: &str, cwd: PathBuf) -> SpawnSpec {
        let lib = RoleLibrary::builtin_default();
        SpawnSpec {
            session_id: new_id(),
            name: name.into(),
            role: lib.get("fullstack-dev").unwrap().clone(),
            cwd,
            model_default: None,
        }
    }

    fn drain(h: &dyn AgentHandle) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        while let Some(e) = h.try_event() {
            out.push(e);
        }
        out
    }

    #[test]
    fn mock_emits_spawn_then_idle() {
        let r = MockRunner::new();
        let h = r.spawn(spec("dev", std::env::temp_dir())).unwrap();
        let evs = drain(&*h);
        assert!(matches!(evs[0], AgentEvent::Spawned { .. }));
        assert!(matches!(evs[1], AgentEvent::Status(AgentStatus::Idle)));
    }

    #[test]
    fn mock_send_runs_full_cycle_and_writes_file() {
        let dir = tempfile::tempdir().unwrap();
        let r = MockRunner::with_edits();
        let h = r.spawn(spec("dev", dir.path().to_path_buf())).unwrap();
        let _ = drain(&*h); // clear spawn/idle
        h.send("implement the thing").unwrap();
        let evs = drain(&*h);
        let kinds: Vec<_> = evs
            .iter()
            .map(|e| match e {
                AgentEvent::Status(s) => format!("status:{s:?}"),
                AgentEvent::Message(m) => format!("msg:{}", m.text),
                other => format!("{other:?}"),
            })
            .collect();
        assert!(kinds.iter().any(|k| k == "status:Working"));
        assert!(kinds.iter().any(|k| k.starts_with("msg:done:")));
        assert!(kinds.iter().any(|k| k == "status:Done"));
        // it wrote into its own cwd
        assert!(dir.path().join("dev.out").exists());
    }
}
