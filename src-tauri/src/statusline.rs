//! Usage-limit hook management. Claude Code passes rate-limit data
//! (session/weekly windows) to the user's status-line script on every refresh;
//! Synapse displays it from a cache file that script writes. This module lets
//! the app install a minimal hook for users who don't have a status line —
//! with their consent, from Settings — instead of requiring manual setup.

use serde_json::{json, Value};
use std::path::PathBuf;
use tracing::info;

/// The hook script: caches `rate_limits` for Synapse, prints nothing (no
/// visible status line). ESM, runs under the user's `node`.
const HOOK_SCRIPT: &str = r#"// Synapse usage-limit hook (installed from Synapse Settings).
// Claude Code invokes this after each response; it caches the rate-limit
// windows so Synapse can show session/weekly usage. It prints NOTHING, so no
// visible status line is added. Safe to delete; reinstall from Synapse.
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    if (data && data.rate_limits) {
      const dir = join(homedir(), ".synapse");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "ratelimits.json"),
        JSON.stringify({ rateLimits: data.rate_limits, ts: Date.now() })
      );
    }
  } catch {}
  process.stdout.write("");
});
"#;

/// Snippet for users who already have their own status-line script.
pub const CACHE_SNIPPET: &str = r#"// Add near the top of your statusline script (after parsing stdin JSON as `data`):
try {
  if (data && data.rate_limits) {
    const dir = require("path").join(require("os").homedir(), ".synapse");
    require("fs").mkdirSync(dir, { recursive: true });
    require("fs").writeFileSync(
      require("path").join(dir, "ratelimits.json"),
      JSON.stringify({ rateLimits: data.rate_limits, ts: Date.now() })
    );
  }
} catch {}
"#;

fn home() -> PathBuf {
    let h = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());
    PathBuf::from(h)
}

fn hook_path() -> PathBuf {
    home().join(".synapse").join("statusline-hook.mjs")
}

fn claude_settings_path() -> PathBuf {
    home().join(".claude").join("settings.json")
}

fn cache_age_ms() -> Option<i64> {
    let meta = std::fs::metadata(home().join(".synapse").join("ratelimits.json")).ok()?;
    let modified = meta.modified().ok()?;
    Some(modified.elapsed().ok()?.as_millis() as i64)
}

/// "none" (no statusLine configured), "ours" (our hook), or "other".
fn configured_kind() -> String {
    let Ok(body) = std::fs::read_to_string(claude_settings_path()) else {
        return "none".into();
    };
    let Ok(v) = serde_json::from_str::<Value>(&body) else {
        return "none".into();
    };
    let Some(cmd) = v
        .get("statusLine")
        .and_then(|s| s.get("command"))
        .and_then(|c| c.as_str())
    else {
        return "none".into();
    };
    if cmd.to_lowercase().contains("statusline-hook.mjs") {
        "ours".into()
    } else {
        "other".into()
    }
}

/// Current state for the Settings row.
#[tauri::command]
pub fn statusline_status() -> Value {
    let age = cache_age_ms();
    json!({
        "configured": configured_kind(),
        // Fresh = updated within 24h: the chips have data and the pipe works.
        "cacheFresh": age.map(|a| a < 24 * 3600 * 1000).unwrap_or(false),
        "cacheAgeMs": age,
        "snippet": CACHE_SNIPPET,
    })
}

/// Install the hook: write the script and point `statusLine` at it. Refuses to
/// clobber an existing custom status line (the UI offers a snippet instead).
#[tauri::command]
pub fn install_statusline_hook() -> Result<Value, String> {
    let kind = configured_kind();
    if kind == "other" {
        return Err(
            "You already have a status line configured — add the snippet to it instead.".into(),
        );
    }

    let hook = hook_path();
    if let Some(dir) = hook.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&hook, HOOK_SCRIPT).map_err(|e| e.to_string())?;

    // Merge into ~/.claude/settings.json, preserving everything else.
    let settings_path = claude_settings_path();
    let mut settings: Value = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|b| serde_json::from_str(&b).ok())
        .unwrap_or_else(|| json!({}));
    if !settings.is_object() {
        settings = json!({});
    }
    let cmd = format!("node \"{}\"", hook.to_string_lossy());
    settings["statusLine"] = json!({ "type": "command", "command": cmd });
    if let Some(dir) = settings_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    info!(target: "synapse2", hook = %hook.display(), "statusline hook installed");
    Ok(statusline_status())
}
