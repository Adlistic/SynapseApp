//! Usage-limit hook management. Claude Code passes rate-limit data
//! (session/weekly windows) to the user's status-line script on every refresh;
//! HyperVoice Code displays it from a cache file that script writes. This
//! module lets the app install a minimal hook for users who don't have a status
//! line — with their consent, from Settings — instead of requiring manual setup.
//!
//! The app's own folder is `~/.hypervoice-code` (hook script, rate-limit
//! cache, logs). Before the rename it was `~/.synapse`: a cache written there
//! by an older hook or a user's own script is still read, and the hook we
//! installed there is moved over on start-up (`upgrade_legacy_hook`).

use serde_json::{json, Value};
use std::path::PathBuf;
use tracing::info;

/// The app's folder in the user's home, and the one it had before the rename.
pub const APP_DIR: &str = ".hypervoice-code";
const LEGACY_DIR: &str = ".synapse";

/// The hook script: caches `rate_limits` for HyperVoice Code, prints nothing
/// (no visible status line). ESM, runs under the user's `node`.
const HOOK_SCRIPT: &str = r#"// HyperVoice Code usage-limit hook (installed from HyperVoice Code Settings).
// Claude Code invokes this after each response; it caches the rate-limit
// windows so HyperVoice Code can show session/weekly usage. It prints NOTHING,
// so no visible status line is added. Safe to delete; reinstall from the app.
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
      const dir = join(homedir(), ".hypervoice-code");
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
    const dir = require("path").join(require("os").homedir(), ".hypervoice-code");
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

pub fn app_dir() -> PathBuf {
    home().join(APP_DIR)
}

fn hook_path() -> PathBuf {
    app_dir().join("statusline-hook.mjs")
}

/// Where a rate-limit cache may be: the app's folder, then the old one.
fn cache_files() -> [PathBuf; 2] {
    [app_dir().join("ratelimits.json"), home().join(LEGACY_DIR).join("ratelimits.json")]
}

fn age_ms(p: &std::path::Path) -> Option<i64> {
    let modified = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(modified.elapsed().ok()?.as_millis() as i64)
}

/// The freshest rate-limit cache, wherever it was written.
fn freshest_cache() -> Option<(PathBuf, i64)> {
    cache_files()
        .into_iter()
        .filter_map(|p| age_ms(&p).map(|a| (p, a)))
        .min_by_key(|(_, a)| *a)
}

/// Last-known Claude rate-limit windows (5-hour session + weekly).
pub fn read_rate_limits() -> Value {
    freshest_cache()
        .and_then(|(p, _)| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

fn claude_settings_path() -> PathBuf {
    home().join(".claude").join("settings.json")
}

fn cache_age_ms() -> Option<i64> {
    freshest_cache().map(|(_, a)| a)
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

/// Before the rename the hook lived in `~/.synapse`. If Claude Code's status
/// line still points at that copy (one we installed, with the user's consent),
/// move it to the app's folder: write the current script there and repoint
/// the setting. A status line of the user's own is never touched. Runs once
/// per start-up; does nothing when there is nothing to move.
pub fn upgrade_legacy_hook() {
    let Ok(body) = std::fs::read_to_string(claude_settings_path()) else { return };
    let Ok(v) = serde_json::from_str::<Value>(&body) else { return };
    let Some(cmd) = v.get("statusLine").and_then(|s| s.get("command")).and_then(|c| c.as_str()) else { return };
    let lower = cmd.to_lowercase().replace('/', "\\");
    if !(lower.contains("statusline-hook.mjs") && lower.contains(&format!("\\{LEGACY_DIR}\\"))) {
        return;
    }
    match write_hook_and_point_at_it() {
        Ok(()) => info!(target: "synapse2", "usage-limit hook moved from ~/{LEGACY_DIR} to ~/{APP_DIR}"),
        Err(e) => info!(target: "synapse2", error = %e, "couldn't move the usage-limit hook; the old one keeps working"),
    }
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
    write_hook_and_point_at_it()?;
    info!(target: "synapse2", hook = %hook_path().display(), "statusline hook installed");
    Ok(statusline_status())
}

/// Write the hook script to the app's folder and set Claude Code's
/// `statusLine` to run it, keeping every other setting.
fn write_hook_and_point_at_it() -> Result<(), String> {

    let hook = hook_path();
    if let Some(dir) = hook.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&hook, HOOK_SCRIPT).map_err(|e| e.to_string())?;

    // Merge into ~/.claude/settings.json, preserving everything else. If the file
    // exists but is unparseable, ABORT rather than fall back to `{}` — otherwise we
    // would silently overwrite the user's whole settings (permissions, MCP servers,
    // hooks) with just our statusLine key.
    let settings_path = claude_settings_path();
    let mut settings: Value = match std::fs::read_to_string(&settings_path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            format!("~/.claude/settings.json isn't valid JSON ({e}); fix or remove it, then retry. Refusing to overwrite it.")
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("couldn't read ~/.claude/settings.json: {e}")),
    };
    if !settings.is_object() {
        return Err("~/.claude/settings.json isn't a JSON object; refusing to overwrite it.".into());
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Our pre-rename hook is moved to ~/.hypervoice-code with the rest of the
    /// user's Claude settings kept; a status line of the user's own is left
    /// alone; a cache in the old folder is still read.
    #[test]
    fn legacy_hook_moves_and_old_cache_still_reads() {
        let h = std::env::temp_dir().join(format!("hvc-home-{}", synapse_core::util::new_id()));
        std::fs::create_dir_all(h.join(".claude")).unwrap();
        std::fs::create_dir_all(h.join(".synapse")).unwrap();
        let old_hook = h.join(".synapse").join("statusline-hook.mjs");
        std::fs::write(&old_hook, "// old").unwrap();
        let settings = json!({
            "model": "opus",
            "statusLine": { "type": "command", "command": format!("node \"{}\"", old_hook.display()) }
        });
        std::fs::write(h.join(".claude").join("settings.json"), settings.to_string()).unwrap();
        std::fs::write(h.join(".synapse").join("ratelimits.json"), r#"{"rateLimits":{"five_hour":{"used_percentage":7}}}"#).unwrap();
        let saved = std::env::var_os("USERPROFILE");
        std::env::set_var("USERPROFILE", &h);

        assert_eq!(read_rate_limits()["rateLimits"]["five_hour"]["used_percentage"], 7);
        upgrade_legacy_hook();
        let after: Value = serde_json::from_str(&std::fs::read_to_string(h.join(".claude").join("settings.json")).unwrap()).unwrap();
        let cmd = after["statusLine"]["command"].as_str().unwrap().to_string();
        assert!(cmd.contains(".hypervoice-code"), "{cmd}");
        assert_eq!(after["model"], "opus");
        assert!(h.join(".hypervoice-code").join("statusline-hook.mjs").exists());

        // A user's own status line is never rewritten.
        let own = json!({ "statusLine": { "type": "command", "command": r"node C:\Users\x\.synapse\mine.mjs" } });
        std::fs::write(h.join(".claude").join("settings.json"), own.to_string()).unwrap();
        upgrade_legacy_hook();
        let still: Value = serde_json::from_str(&std::fs::read_to_string(h.join(".claude").join("settings.json")).unwrap()).unwrap();
        assert_eq!(still, own);

        match saved {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
        let _ = std::fs::remove_dir_all(&h);
    }
}
