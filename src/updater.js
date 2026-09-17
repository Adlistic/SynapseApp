// Frontend side of the app-owned updater (src-tauri/src/updater.rs), ported
// from HyperVoice. Rust checks on launch and every six hours, downloads in
// the background, and holds the verified installer until the user restarts.
// This module just mirrors that state — one hook that stays current via the
// `update-status` event — and exposes the actions the UI can take.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const DISMISSED_KEY = "synapse2.dismissedUpdate.v1";

export function getUpdateStatus() {
  return invoke("get_update_status");
}

export function getUpdateCheckInfo() {
  return invoke("get_update_check_info");
}

/** `force` skips the half-hour throttle (the Settings button). */
export function checkForUpdates(force = false) {
  return invoke("check_for_updates", { force });
}

/** Install the downloaded update and relaunch. Never resolves on Windows:
 *  the process exits for the installer. */
export function installUpdate() {
  return invoke("install_update");
}

/** Hide this version. A newer one supersedes the dismissal automatically. */
export function dismissUpdate(version) {
  try { localStorage.setItem(DISMISSED_KEY, version); } catch {}
  return invoke("dismiss_update", { version }).catch(() => {});
}

/** Startup: mirror the persisted dismissal into Rust before its first check
 *  (the checker waits a few seconds for exactly this). */
export function initUpdater() {
  let dismissed = null;
  try { dismissed = localStorage.getItem(DISMISSED_KEY); } catch {}
  invoke("sync_dismissed_update", { version: dismissed || null }).catch(() => {});
}

/** "just now", "12 minutes ago", "3 hours ago" — for the Settings card. */
export function describeAgo(unixSeconds, now = Date.now()) {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * Live update status: the current value from Rust, then every change via the
 * event. Also nudges a (Rust-throttled) check whenever the window comes back
 * into view, so an app that runs for days still notices new versions when
 * someone actually looks at it.
 */
export function useUpdateStatus() {
  const [status, setStatus] = useState({ status: "idle" });
  useEffect(() => {
    let cancelled = false;
    getUpdateStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => {});
    const unlisten = listen("update-status", (e) => setStatus(e.payload));
    const onVisible = () => {
      if (document.visibilityState === "visible") checkForUpdates(false).catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return status;
}
