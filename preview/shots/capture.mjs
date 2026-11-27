// Capture crisp app screenshots for the Store posters from the preview harness.
//   1. npx vite --config preview/vite.config.js      (serves :1431)
//   2. node preview/shots/capture.mjs                 → preview/shots/raw/*.png
// Uses the "?shot=4" mock (preview/mock/shots.js): four fictional sessions.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "raw");
fs.mkdirSync(OUT, { recursive: true });
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "hvc-shots-"));
// Chrome: CHROME env var, else the usual machine-wide and per-user installs.
const CHROME = [process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error("Chrome not found. Set CHROME to the path of chrome.exe."); process.exit(1); }
const chrome = spawn(CHROME,
  ["--headless=new", "--remote-debugging-port=9334", "--user-data-dir=" + prof, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 60; i++) { try { list = await (await fetch("http://127.0.0.1:9334/json/list")).json(); break; } catch { await sleep(200); } }
const pageT = list?.find((t) => t.type === "page");
if (!pageT) { console.error("Headless Chrome didn't open its debug port (9334) within 12s. Is another Chrome using that port?"); chrome.kill(); process.exit(1); }
const ws = new WebSocket(pageT.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pend = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
const key = async (k, mods = 0, code) => {
  const vk = { Enter: 13, Escape: 27 }[k] || k.toUpperCase().charCodeAt(0);
  for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: code || ("Key" + k.toUpperCase()), windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(500);
};
await send("Page.enable"); await send("Runtime.enable");

const P = "C:\\Projects\\";
const TABS = {
  tabs: [
    { sessionId: "s-notes", cwd: P + "notes-app", title: "Dark mode fix" },
    { sessionId: "s-api", cwd: P + "api-server", title: "Login rate limit" },
    { sessionId: "s-docs", cwd: P + "docs-site", title: "Broken links" },
    { sessionId: "s-mobile", cwd: P + "mobile-app", title: "Rotation crash" },
  ],
};
const base = (over = {}) => ({
  "synapse2.toured.v1": "1",
  "synapse2.lastVersion": "0.3.1",
  "synapse2.railw.v1": "230",
  "synapse2.split.v1": String(over.split || 50),
  "synapse2.filters.v1": JSON.stringify({ tabPosition: "left", theme: "dark", detail: "steps", ...over.filters }),
  "synapse2.openTabs.v1": JSON.stringify({ ...TABS, active: over.active || "s-notes" }),
  ...(over.ls || {}),
});

// Helpers run inside the page.
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const byText = (sel, re) => $$(sel).find((e) => re.test(e.textContent));
`;

const scenarios = [
  { name: "hero", steps: [`${H} await sleep(300);
      const b = $$('.step-line').find((x) => /Edit/.test(x.textContent) && /ThemeToggle\\.tsx/.test(x.textContent)); b?.click(); await sleep(500);
      const f = $('.feed-uni'); if (f) f.scrollTop = 0; await sleep(300); return b ? 'ok' : 'no edit row';`] },
  { name: "answer", over: { filters: { theme: "light", detail: "answer" } }, steps: [`${H} await sleep(300); return 'ok';`] },
  { name: "files", steps: [`${H} await sleep(300);
      byText('button', /files changed/)?.click(); await sleep(500);
      const r = $$('button').filter((x) => /ThemeToggle\\.tsx/.test(x.textContent) && /\\+2/.test(x.textContent)).pop(); r?.click(); await sleep(700); return r ? 'ok' : 'no file row';`] },
  { name: "ask", over: { active: "s-api" }, steps: [`${H} await sleep(300); return 'ok';`] },
  { name: "mission", steps: ["KEY:B:10"] },
  { name: "resume", steps: ["KEY:R:10", `${H} await sleep(400); $$('.sess-proj-head, .sess-group button, button').filter(b=>/notes-app|api-server/.test(b.textContent)).slice(0,2).forEach(b=>b.click()); await sleep(300); return 'ok';`] },
  { name: "talk", over: { filters: { showComposer: true } }, q: "", steps: [`${H} const inp = $('.term-composer input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(inp, 'Also make it follow the Windows setting until I pick one myself'); inp.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300); return 'ok';`] },
  { name: "settings", over: { filters: { theme: "light" } }, steps: [`${H} byText('button', /Settings/)?.click(); await sleep(600); return 'ok';`] },
];

try {
for (const s of scenarios) {
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url: "http://localhost:1431/" }); await sleep(900);
  const ls = base(s.over);
  await ev(`localStorage.clear(); ${Object.entries(ls).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("")} return 1;`);
  await send("Page.navigate", { url: "http://localhost:1431/?shot=4" + (s.q ?? "") }); await sleep(3500);
  const want = (s.over && s.over.active) || "s-notes";
  const tabTitle = { "s-notes": "Dark mode fix", "s-api": "Login rate limit", "s-docs": "Broken links", "s-mobile": "Rotation crash" }[want];
  await ev(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(${JSON.stringify(tabTitle)}))?.click(); return 1;`); await sleep(1200);
  for (const step of s.steps) {
    if (step.startsWith("KEY:")) { const [, k, m] = step.split(":"); await key(k, +m); continue; }
    const v = await ev(step); if (v && v !== "ok") console.log(s.name, "→", v);
    await sleep(300);
  }
  await ev(`document.activeElement?.blur?.(); return 1;`);
  await sleep(500);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, s.name + ".png"), Buffer.from(shot.result.data, "base64"));
  console.log("saved", s.name);
}
} finally {
  ws.close(); chrome.kill();
}
