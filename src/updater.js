// Auto-update against the GitHub-hosted release feed (see tauri.conf.json
// updater.endpoints). Best-effort: silent no-op in dev or when offline.
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let ran = false;

export async function checkForUpdates() {
  if (ran) return;
  ran = true;
  try {
    const update = await check();
    if (update && update.available) {
      await update.downloadAndInstall();
      await relaunch();
    }
  } catch {
    // No updater artifacts in dev, or offline — ignore.
  }
}

// Manual check (Settings → "Check for updates"): reports what happened instead
// of failing silently. Installs + relaunches when an update is found.
export async function checkForUpdatesManual() {
  try {
    const update = await check();
    if (update && update.available) {
      await update.downloadAndInstall();
      await relaunch();
      return { status: "installing", version: update.version };
    }
    return { status: "uptodate" };
  } catch (e) {
    return { status: "error", message: String(e) };
  }
}
