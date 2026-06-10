//! Real-CLI integration smoke test. Ignored by default (spends a few tokens and
//! needs an authenticated `claude`); run explicitly with:
//!
//!   cargo test -p synapse-core --test real_claude -- --ignored --nocapture
//!
//! Proves the ClaudeCliRunner spawns the real `claude` CLI, streams `stream-json`,
//! and that the transcript parser turns it into a typed assistant Message.

use std::time::{Duration, Instant};
use synapse_core::roles::Role;
use synapse_core::runner::{AgentEvent, AgentRunner, ClaudeCliRunner, SpawnSpec};
use synapse_core::types::MessageKind;
use synapse_core::util::new_id;

#[test]
#[ignore = "spends tokens; requires an authenticated claude CLI"]
fn claude_cli_runner_round_trips_a_prompt() {
    let runner = ClaudeCliRunner::new();
    let role = Role::new("smoke", "Smoke", "").with_model("claude-haiku-4-5-20251001");
    let spec = SpawnSpec {
        session_id: new_id(),
        name: "smoke".into(),
        role,
        cwd: std::env::temp_dir(),
        model_default: None,
    };
    let handle = runner.spawn(spec).expect("spawn");
    handle
        .send("Reply with exactly the word READY and nothing else.")
        .expect("send");

    let deadline = Instant::now() + Duration::from_secs(90);
    let mut texts: Vec<String> = Vec::new();
    let mut exited = false;
    while Instant::now() < deadline && !exited {
        while let Some(ev) = handle.try_event() {
            match ev {
                AgentEvent::Message(m) => {
                    if matches!(m.kind, MessageKind::Message | MessageKind::Question) {
                        texts.push(m.text);
                    }
                }
                AgentEvent::Exited(code) => {
                    eprintln!("[smoke] claude exited with code {code}");
                    exited = true;
                }
                AgentEvent::Error(e) => panic!("runner error: {e}"),
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    assert!(exited, "claude process did not exit within the deadline");
    let joined = texts.join(" ");
    eprintln!("[smoke] assistant said: {joined:?}");
    assert!(
        joined.to_uppercase().contains("READY"),
        "expected an assistant message containing READY, got: {joined:?}"
    );
}
