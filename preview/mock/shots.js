// "?shot=4" mode for the preview harness: four fictional sessions with
// different states, for Microsoft Store screenshots. Data: preview/shots/*.json
// (made by preview/shots/make_fixtures.py). Returns undefined for commands it
// doesn't handle, so core.js falls through to its normal mocks.
import { fire } from "./bus.js";

const P = "C:\\Projects\\";
export const SHOT_SESSIONS = [
  { sessionId: "s-notes", cwd: P + "notes-app", title: "Dark mode fix", ago: 25 * 60_000 },
  { sessionId: "s-api", cwd: P + "api-server", title: "Login rate limit", ago: 70_000 },
  { sessionId: "s-docs", cwd: P + "docs-site", title: "Broken links", ago: 8_000 },
  { sessionId: "s-mobile", cwd: P + "mobile-app", title: "Rotation crash", ago: 4_000 },
];
// Token use per session, so the cards differ and the cost estimate is real.
const USAGE = {
  "s-notes": { input: 210000, output: 48000, cacheRead: 1_900_000, cacheCreation: 70000 },
  "s-api": { input: 96000, output: 21000, cacheRead: 820_000, cacheCreation: 41000 },
  "s-docs": { input: 164000, output: 37000, cacheRead: 1_400_000, cacheCreation: 58000 },
  "s-mobile": { input: 58000, output: 12500, cacheRead: 410_000, cacheCreation: 26000 },
};
const byId = Object.fromEntries(SHOT_SESSIONS.map((s) => [s.sessionId, s]));
const cache = {};
const load = async (id) => (cache[id] ??= await (await fetch(`/preview/shots/${id}.json`)).json());

function stats(id, msgs) {
  const last = msgs[msgs.length - 1];
  const agents = msgs.filter((m) => m.kind === "toolcall" && m.toolName === "Task")
    .map((m) => ({ id: m.toolUseId, label: "Check links on 49 pages", done: msgs.some((r) => r.kind === "toolresult" && r.toolUseId === m.toolUseId) }));
  return {
    firstTsMs: Date.now() - 40 * 60_000, lastTsMs: Date.now() - byId[id].ago,
    turns: msgs.filter((m) => m.kind === "user").length,
    toolCalls: msgs.filter((m) => m.kind === "toolcall").length,
    sidechainCalls: 0, toolErrors: 0, byCategory: {}, models: { "claude-opus-4-5": USAGE[id] }, lastModel: "claude-opus-4-5",
    contextTokens: { "s-notes": 84000, "s-api": 41000, "s-docs": 63000, "s-mobile": 29000 }[id],
    lastKind: last?.kind || "message",
    lastActivity: (last?.kind === "toolcall" ? `${last.toolName} · ` : "") + (last?.text || "").slice(0, 80),
    files: [], todos: [], agents, recentEvents: [],
  };
}

const enc = (s) => Array.from(new TextEncoder().encode(s));
const G = "\x1b[32m●\x1b[0m", B = (s) => `\x1b[1m${s}\x1b[0m`, D = (s) => `\x1b[2m${s}\x1b[0m`;
const banner = (cwd) =>
  "\x1bc\x1b[38;5;209m╭───────────────────────────────────────────╮\r\n" +
  "│ \x1b[1m✻ Welcome to Claude Code!\x1b[22m                  │\r\n" +
  `│   cwd: ${cwd.padEnd(35)}│\r\n` +
  "╰───────────────────────────────────────────╯\x1b[0m\r\n\r\n";
const TERM = {
  "notes-app":
    `${D(">")} Dark mode doesn't stick: if I switch it on in Settings and\r\n  reload the page, it's light again. Can you fix that and add a test?\r\n\r\n` +
    `${G} Let me find where the theme is set.\r\n\r\n` +
    `${G} ${B("Search")}(pattern: "theme", path: "src")\r\n  ⎿  Found 3 files\r\n\r\n` +
    `${G} ${B("Update")}(src\\settings\\ThemeToggle.tsx)\r\n  ⎿  Updated with 2 additions and 1 removal\r\n\r\n` +
    `${G} ${B("Write")}(src\\settings\\ThemeToggle.test.tsx)\r\n  ⎿  Wrote 7 lines\r\n\r\n` +
    `${G} ${B("Bash")}(npm test -- ThemeToggle)\r\n  ⎿  Tests: 1 passed, 1 total\r\n\r\n` +
    `${G} Fixed. Dark mode now stays on after a reload.\r\n\r\n`,
  "api-server":
    `${D(">")} Add rate limiting to the login endpoint so people can't\r\n  brute-force passwords.\r\n\r\n` +
    `${G} ${B("Read")}(src\\routes\\auth.ts)\r\n  ⎿  Read 64 lines\r\n\r\n` +
    `${G} There's already a Redis client, so I can store the counters there.\r\n\r\n` +
    ` How should the login limit be counted?\r\n\r\n` +
    ` \x1b[36m❯ 1. Per account (Recommended)\x1b[0m\r\n   2. Per IP address\r\n   3. Both\r\n\r\n`,
  "docs-site":
    `${D(">")} Check every page in the docs for broken links and fix the\r\n  ones you can.\r\n\r\n` +
    `${G} ${B("Search")}(pattern: "content/**/*.md")\r\n  ⎿  Found 49 files\r\n\r\n` +
    `${G} ${B("Task")}(Check links on 49 pages)\r\n  ⎿  Running… (32s)\r\n\r\n`,
  "mobile-app":
    `${D(">")} The app crashes when I rotate the screen on the profile page.\r\n  Can you find out why?\r\n\r\n` +
    `${G} ${B("Read")}(src\\screens\\Profile.tsx)\r\n  ⎿  Read 118 lines\r\n\r\n` +
    `${G} ${B("Bash")}(npm run test -- Profile)\r\n  ⎿  3 passed\r\n\r\n` +
    `\x1b[38;5;209m✻ Thinking…\x1b[0m\r\n\r\n`,
};
let lastCwd = SHOT_SESSIONS[0].cwd;

export async function shotInvoke(cmd, args) {
  switch (cmd) {
    case "start_session": {
      // A brand-new session: fresh id, in the folder the user picked.
      const cwd = args.opts?.folder || args.opts?.cwd || lastCwd;
      lastCwd = cwd;
      return { sessionId: "s-new-" + Date.now().toString(36), root: cwd, cwd, command: "claude", branch: null, permMode: args.opts?.permMode || "default", permFlags: "" };
    }
    case "resume_session": {
      // Any other id with a folder: open it as-is (lets a test fill the rail).
      if (!byId[args.sessionId] && args.sessionId && args.cwd) {
        return { sessionId: args.sessionId, root: args.cwd, cwd: args.cwd, command: "claude", branch: null, permMode: args.permMode || "default", permFlags: "" };
      }
      const s = byId[args.sessionId] || SHOT_SESSIONS[0];
      lastCwd = s.cwd;
      return { sessionId: s.sessionId, root: s.cwd, cwd: s.cwd, command: "claude", branch: null, permMode: args.permMode || args.opts?.permMode || "default", permFlags: "" };
    }
    case "get_conversation": {
      if (!byId[args.sessionId]) return undefined;
      const f = await load(args.sessionId);
      const since = Math.min(args.since || 0, f.length);
      return { ready: true, messages: f.slice(since), total: f.length, usage: USAGE[args.sessionId] };
    }
    case "get_dashboard": {
      const sessions = {};
      for (const s of SHOT_SESSIONS) {
        const f = await load(s.sessionId);
        sessions[s.sessionId] = { ready: true, usage: USAGE[s.sessionId], stats: stats(s.sessionId, f) };
      }
      return { sessions };
    }
    case "term_open": {
      const cwd = args.cwd || lastCwd;
      const key = cwd.split("\\").pop();
      const id = "t-" + key;
      setTimeout(() => fire("term-data", { id, bytes: enc(banner(cwd) + (TERM[key] || "")) }), 60);
      return id;
    }
    case "list_claude_sessions": {
      const now = Date.now();
      const extra = {
        "notes-app": ["Dark mode fix", "Search is slow on big notebooks", "Export to PDF", "Keyboard shortcuts help screen"],
        "api-server": ["Login rate limit", "Move config to env vars", "Add request logging"],
        "docs-site": ["Broken links", "New install guide for Linux"],
        "mobile-app": ["Rotation crash", "Push notifications on Android", "Offline mode"],
      };
      return SHOT_SESSIONS.map((s, i) => {
        const key = s.cwd.split("\\").pop();
        return {
          dir: key, cwd: s.cwd,
          sessions: extra[key].map((title, j) => ({
            sessionId: j === 0 ? s.sessionId : `${s.sessionId}-${j}`, path: "x", title, cwd: s.cwd,
            modifiedMs: now - (i * 3 + j * 26) * 3600_000 - s.ago, sizeBytes: (180 + j * 140 + i * 37) * 1024,
          })),
        };
      });
    }
    default:
      return undefined;
  }
}
