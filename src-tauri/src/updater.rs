//! App-owned update lifecycle, ported from HyperVoice (VoiceForge
//! `desktop/src-tauri/src/updater.rs`), the way Chrome / VS Code / Slack do it:
//!
//!   * Rust checks shortly after launch, then every 6 h, plus on the Settings
//!     button and when the window becomes visible (throttled);
//!   * an available update downloads in the background immediately — the
//!     updater plugin verifies the minisign signature before handing over the
//!     bytes;
//!   * the verified installer is held in memory until the user clicks
//!     "Restart to update" — nothing ever installs mid-session, because a
//!     restart kills every running `claude` terminal.
//!
//! The old flow (one JS `check()` at launch behind a blocking dialog, and a
//! Settings button that downloaded at click-time) never re-checked during a
//! long-running session and made the user wait at exactly the wrong moment.
//!
//! State is broadcast as the `update-status` event; `get_update_status`
//! returns the current value for late subscribers. The dismissed-version
//! preference lives in the frontend's localStorage and is mirrored in at
//! startup via `sync_dismissed_update`, so the backend needs no settings file.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tracing::{info, warn};

pub const EVENT: &str = "update-status";
/// Let the webview mount and push the stored dismissed version first.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Visibility/manual checks are cheap, but don't hammer the endpoint.
const MIN_GAP: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum UpdateStatus {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Downloading {
        version: String,
        progress: u8,
    },
    /// Downloaded, signature verified, waiting for a restart.
    Ready {
        version: String,
        /// Release notes from the update manifest (GitHub release body).
        notes: String,
    },
    Installing {
        version: String,
    },
    Error {
        message: String,
    },
}

#[derive(Default)]
pub struct UpdateSlot {
    status: UpdateStatus,
    /// The verified installer bytes, kept in memory until installed — simpler
    /// and safer than a staging file we'd have to re-verify.
    ready: Option<(Update, Vec<u8>)>,
    last_check: Option<Instant>,
    /// Same moment as `last_check`, as unix seconds, for the Settings card —
    /// "last checked 12 minutes ago" is how a user can see the background
    /// check actually runs.
    last_check_at: Option<u64>,
    /// Version the user chose to skip (mirrored from localStorage). A newer
    /// release supersedes the dismissal automatically.
    dismissed: Option<String>,
    busy: bool,
}

/// What Settings → About shows under the button.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckInfo {
    pub last_check_at: Option<u64>,
    pub interval_secs: u64,
    pub current_version: String,
}

/// Record + broadcast a status.
fn set_status(app: &AppHandle, status: UpdateStatus) {
    app.state::<crate::AppState>().update.lock().status = status.clone();
    let _ = app.emit(EVENT, &status);
}

pub fn status(app: &AppHandle) -> UpdateStatus {
    app.state::<crate::AppState>().update.lock().status.clone()
}

/// Kick off the periodic checker. Called once from setup.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check(app.clone(), false).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// Check for an update and, if there is one, download it in the background.
/// `force` skips the 30-minute throttle (the Settings button).
pub async fn check(app: AppHandle, force: bool) -> UpdateStatus {
    {
        let state = app.state::<crate::AppState>();
        let mut slot = state.update.lock();
        if slot.busy || matches!(slot.status, UpdateStatus::Installing { .. }) {
            return slot.status.clone();
        }
        if !force {
            if let Some(t) = slot.last_check {
                if t.elapsed() < MIN_GAP {
                    return slot.status.clone();
                }
            }
        }
        slot.busy = true;
        slot.last_check = Some(Instant::now());
        slot.last_check_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs());
    }
    let result = check_inner(&app).await;
    app.state::<crate::AppState>().update.lock().busy = false;
    result
}

async fn check_inner(app: &AppHandle) -> UpdateStatus {
    let (dismissed, held) = {
        let state = app.state::<crate::AppState>();
        let slot = state.update.lock();
        (slot.dismissed.clone(), slot.ready.as_ref().map(|(u, _)| u.version.clone()))
    };

    // Flipping a Ready bar to Checking and back every six hours would be
    // noise; only announce the check when nothing is held.
    if held.is_none() {
        set_status(app, UpdateStatus::Checking);
    }

    let updater = match app.updater_builder().build() {
        Ok(u) => u,
        Err(e) => return settle_error(app, held.is_some(), format!("updater setup: {e}")),
    };
    let found = match updater.check().await {
        Ok(f) => f,
        Err(e) => return settle_error(app, held.is_some(), e.to_string()),
    };
    let Some(update) = found else {
        // Nothing newer — or a release we held was pulled. Drop it.
        app.state::<crate::AppState>().update.lock().ready = None;
        set_status(app, UpdateStatus::UpToDate);
        return UpdateStatus::UpToDate;
    };
    if dismissed.as_deref() == Some(update.version.as_str()) {
        info!(target: "synapse2", version = %update.version, "update available but dismissed by the user");
        app.state::<crate::AppState>().update.lock().ready = None;
        set_status(app, UpdateStatus::UpToDate);
        return UpdateStatus::UpToDate;
    }
    if held.as_deref() == Some(update.version.as_str()) {
        // Already downloaded. Re-announce so late subscribers see it.
        let st = status(app);
        let _ = app.emit(EVENT, &st);
        return st;
    }

    info!(target: "synapse2", version = %update.version, "update available; downloading in the background");
    let version = update.version.clone();
    set_status(app, UpdateStatus::Downloading { version: version.clone(), progress: 0 });

    let progress_app = app.clone();
    let progress_version = version.clone();
    let mut received: u64 = 0;
    let mut last_pct: u8 = 0;
    let downloaded = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = (received.saturating_mul(100) / total).min(100) as u8;
                    if pct >= last_pct.saturating_add(5) || (pct == 100 && last_pct != 100) {
                        last_pct = pct;
                        set_status(
                            &progress_app,
                            UpdateStatus::Downloading { version: progress_version.clone(), progress: pct },
                        );
                    }
                }
            },
            || {},
        )
        .await;

    match downloaded {
        Ok(bytes) => {
            info!(target: "synapse2", version = %version, bytes = bytes.len(), "update downloaded and verified");
            let notes = update.body.clone().unwrap_or_default();
            app.state::<crate::AppState>().update.lock().ready = Some((update, bytes));
            let st = UpdateStatus::Ready { version, notes };
            set_status(app, st.clone());
            st
        }
        Err(e) => settle_error(app, false, format!("download failed: {e}")),
    }
}

/// A failed check must not throw away an update we already hold.
fn settle_error(app: &AppHandle, keep_held: bool, message: String) -> UpdateStatus {
    warn!(target: "synapse2", "updater: {message}");
    if keep_held {
        return status(app);
    }
    let st = UpdateStatus::Error { message };
    set_status(app, st.clone());
    st
}

/// "Restart to update": run the installer, which relaunches the app. On
/// Windows this never returns — the plugin spawns the NSIS installer and
/// exits the process.
fn install_and_restart(app: &AppHandle) -> Result<(), String> {
    let taken = app.state::<crate::AppState>().update.lock().ready.take();
    let Some((update, bytes)) = taken else {
        return Err("No update is downloaded yet.".to_string());
    };
    set_status(app, UpdateStatus::Installing { version: update.version.clone() });
    info!(target: "synapse2", version = %update.version, "installing update and restarting");
    for (_, w) in app.webview_windows() {
        let _ = w.hide();
    }
    match update.install(bytes) {
        Ok(()) => {
            app.restart();
        }
        Err(e) => {
            let message = format!("install failed: {e}");
            set_status(app, UpdateStatus::Error { message: message.clone() });
            Err(message)
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_update_status(app: AppHandle) -> UpdateStatus {
    status(&app)
}

#[tauri::command]
pub fn get_update_check_info(app: AppHandle) -> UpdateCheckInfo {
    let last_check_at = app.state::<crate::AppState>().update.lock().last_check_at;
    UpdateCheckInfo {
        last_check_at,
        interval_secs: CHECK_INTERVAL.as_secs(),
        current_version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle, force: bool) -> UpdateStatus {
    check(app, force).await
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    install_and_restart(&app)
}

/// Hide this version. A newer one supersedes the dismissal automatically.
/// The frontend persists the choice in localStorage and mirrors it back on
/// every launch via `sync_dismissed_update`.
#[tauri::command]
pub fn dismiss_update(app: AppHandle, version: String) {
    {
        let state = app.state::<crate::AppState>();
        let mut slot = state.update.lock();
        slot.dismissed = Some(version.clone());
        slot.ready = None;
    }
    set_status(&app, UpdateStatus::UpToDate);
    info!(target: "synapse2", version = %version, "update dismissed");
}

/// Startup mirror of the persisted dismissal (before the first check runs).
#[tauri::command]
pub fn sync_dismissed_update(app: AppHandle, version: Option<String>) {
    app.state::<crate::AppState>().update.lock().dismissed = version;
}
