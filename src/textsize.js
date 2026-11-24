// Text size and zoom, VS Code style.
//   - App zoom (Ctrl+scroll anywhere, Ctrl+= / Ctrl+- / Ctrl+0): scales the
//     whole window, chrome and content together.
//   - Terminal text size (Settings): the terminal only.
//   - Reading size (Settings): the conversation only.
// All three persist in the filters store (filters.js).

export const APP_ZOOM = { key: "appZoom", min: 0.8, max: 1.5, step: 0.1, def: 1 };
export const TERM_FONT = { key: "termFontSize", min: 9, max: 24, step: 1, def: 13 };
export const READER_ZOOM = { key: "readerZoom", min: 0.9, max: 1.6, step: 0.1, def: 1 };

export function stepValue(spec, current, dir) {
  const v = (current ?? spec.def) + dir * spec.step;
  const r = Math.round(v * 100) / 100;
  return Math.min(spec.max, Math.max(spec.min, r));
}

export const pct = (v) => `${Math.round((v ?? 1) * 100)}%`;

// Real webview zoom in the app (xterm handles it correctly: it is just a
// device-pixel-ratio change). The browser preview has no Tauri webview, so it
// falls back to CSS zoom there.
export async function applyAppZoom(factor) {
  const f = factor || 1;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(f);
  } catch {
    try { document.documentElement.style.zoom = String(f); } catch { /* ignore */ }
  }
}
