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
