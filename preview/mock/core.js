import { shotInvoke } from "./shots.js";
// Mock of @tauri-apps/api/core `invoke` for the browser preview.
// URL params: ?stream=1 reveals the fixture gradually (live-turn testing);
// ?n=<count> caps the fixture at its first <count> messages.
import { fire } from "./bus.js";

const params = new URLSearchParams(location.search);
let fixture = null;
let revealed = Infinity;
let loading = null;
// One shared load: the first polls run together, and each would otherwise
// fetch the fixture and start its own reveal timer.
const load = () => (loading ??= loadOnce());
const loadOnce = async () => {
  const all = await (await fetch("/__fixture.json")).json();
  const n = parseInt(params.get("n") || "", 10);
  fixture = Number.isFinite(n) ? all.slice(0, n) : all;
  if (params.get("stream")) {
    revealed = Math.max(0, fixture.length - 40);
    const tick = () => {
      if (revealed < fixture.length) {
        revealed += 1;
        fire("syn2:changed", { sessionId: SESSION });
        setTimeout(tick, 700);
      }
    };
    setTimeout(tick, 1500);
  }
  return fixture;
};

const SESSION = "preview-session";
// ?agent=codex → the session is a Codex one (stats as Codex reports them).
// ?agents=both|claude|codex|none|maybe → what agent_status says is installed.
const AGENT = params.get("agent") === "codex" ? "codex" : "claude";
const agentsParam = params.get("agents") || "both";
const agentStatus = () => {
  const has = (k) => agentsParam === "both" || agentsParam === k;
  return {
    claude: { installed: has("claude"), path: null, used: has("claude") },
    codex: { installed: has("codex"), path: null, used: has("codex") || agentsParam === "maybe" },
  };
};
const now = Date.now();
const sess = (agent, id, title, cwd, ago, size) => ({ sessionId: id, path: "x", title, cwd, modifiedMs: now - ago, sizeBytes: size, agent });
const USAGE = { input: 120000, output: 48000, cacheRead: 2400000, cacheCreation: 90000 };
const CWD = String.raw`D:\Development\Synapse2`;
const enc = (s) => Array.from(new TextEncoder().encode(s));
const BANNER =
  "\x1b[38;5;209m╭───────────────────────────────────────────╮\r\n" +
  "│ \x1b[1m✻ Welcome to Claude Code!\x1b[22m                  │\r\n" +
  "│   cwd: D:\\Development\\Synapse2              │\r\n" +
  "╰───────────────────────────────────────────╯\x1b[0m\r\n\r\n" +
  "\x1b[2m> \x1b[0m";

function stats(msgs) {
  const last = msgs[msgs.length - 1];
  return {
    firstTsMs: Date.now() - 3 * 3600_000, lastTsMs: Date.now() - (params.get("stream") ? 1000 : 600_000),
    turns: msgs.filter((m) => m.kind === "user").length,
    toolCalls: msgs.filter((m) => m.kind === "toolcall").length,
    sidechainCalls: 0, toolErrors: msgs.filter((m) => m.isError).length,
    byCategory: {}, models: AGENT === "codex" ? {} : { "claude-opus-4-1": USAGE }, lastModel: AGENT === "codex" ? "gpt-5-codex" : "claude-opus-4-1", contextTokens: AGENT === "codex" ? 21900 : 84000,
    ...(AGENT === "codex" ? { contextWindow: 272000, turnOpen: !!params.get("stream"), rateLimits: { primary: { used_percent: 18, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 9000 }, secondary: { used_percent: 42, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 * 4 } } } : {}),
    lastKind: last?.kind || "message", lastActivity: (last?.kind === "toolcall" ? `${last.toolName} · ` : "") + (last?.text || "").slice(0, 80),
    files: [], todos: [], agents: [], recentEvents: [],
  };
}

export async function invoke(cmd, args = {}) {
  if (params.get("shot") === "4") { const r = await shotInvoke(cmd, args); if (r !== undefined) return r; }
  // ?slow=<ms> holds session listing/search that long (to see the loading orb).
  if (params.get("slow") && /^(list_claude_sessions|list_codex_sessions|search_sessions)$/.test(cmd)) await new Promise((r) => setTimeout(r, +params.get("slow")));
  switch (cmd) {
    case "get_install_source": return params.get("store") ? "store" : "direct";
    case "hypervoice_installed": return params.get("hv") === "1";
    case "get_entitlement":
      return { linked: true, http_status: 200, parsed: true, suite_access: true, plan: "pro", status: "active" };
    case "auth_is_linked": return true;
    case "start_session":
    case "resume_session":
      return { sessionId: SESSION, root: CWD, cwd: CWD, command: (args.opts?.agent || args.agent || AGENT) === "codex" ? "codex" : "claude", branch: null, agent: args.opts?.agent || args.agent || AGENT };
    case "agent_status": return agentStatus();
    case "list_codex_sessions":
      return [
        { dir: "codex:recipe-box", cwd: String.raw`D:\Projects\recipe-box`, sessions: [
          sess("codex", "01a1f2aa-0000-7000-8000-000000000001", "Fix case-insensitive recipe search", String.raw`D:\Projects\recipe-box`, 3600_000, 48000),
          sess("codex", "01a1f2aa-0000-7000-8000-000000000002", "Add a shopping-list export", String.raw`D:\Projects\recipe-box`, 86400_000 * 2, 210000),
        ] },
      ];
    case "get_conversation": {
      const f = await load();
      const vis = f.slice(0, Math.min(revealed, f.length));
      const since = Math.min(args.since || 0, vis.length);
      return { ready: true, messages: vis.slice(since), total: vis.length,
        usage: { input: 120000, output: 48000, cacheRead: 2_400_000, cacheCreation: 90000 } };
    }
    case "get_dashboard": {
      const f = await load();
      const vis = f.slice(0, Math.min(revealed, f.length));
      return { sessions: { [SESSION]: { ready: true, usage: { input: 120000, output: 48000, cacheRead: 2400000, cacheCreation: 90000 }, stats: stats(vis) } } };
    }
    case "term_open": {
      const id = "t1";
      setTimeout(() => fire("term-data", { id, bytes: enc(BANNER + (params.get("termq") ? "\r\n ❯ 1. v0.3.0 (Recommended)\r\n   2. v0.2.13\r\n   3. Hold for now\r\n" : "")) }), 50);
      return id;
    }
    case "get_rate_limits":
      // Same shape as the real command: { rateLimits: { five_hour, seven_day } }.
      return { rateLimits: { five_hour: { used_percentage: params.get("limit") ? +params.get("limit") : 34, resets_at: Math.floor(Date.now() / 1000) + 7200 },
                             seven_day: { used_percentage: 61, resets_at: Math.floor(Date.now() / 1000) + 86400 * 3 } } };
    case "list_claude_sessions":
      return [
        { dir: "D--Projects-recipe-box", cwd: String.raw`D:\Projects\recipe-box`, sessions: [
          sess("claude", "6f1d2c3b-0000-4000-8000-000000000003", "Set up the recipe photo uploader", String.raw`D:\Projects\recipe-box`, 7200_000, 96000),
        ] },
        { dir: "D--Projects-garden-planner", cwd: String.raw`D:\Projects\garden-planner`, sessions: [
          sess("claude", "6f1d2c3b-0000-4000-8000-000000000004", "Frost-date lookup by postcode", String.raw`D:\Projects\garden-planner`, 86400_000, 130000),
        ] },
      ];
    case "term_input":
      (window.__sent = window.__sent || []).push(args.data);
      return null;
    case "get_agent_run": {
      const all = await (await fetch("/__agent.json")).json();
      if (!all.length) return { found: false };
      const since = args.since || 0;
      return { found: true, agentType: "ui-reviewer", description: "UI review of new reader pane", finished: !params.get("agentlive"), more: false, lines: all.length, messages: since ? [] : all };
    }
    case "list_orphan_worktrees":
      return params.get("wt")
        ? [
            { name: "a1b2c3d4", path: "x", branch: "synapse2/a1b2c3d4", changedFiles: 0, unmergedCommits: 0, safe: true },
            { name: "e5f6a7b8", path: "x", branch: "synapse2/e5f6a7b8", changedFiles: 3, unmergedCommits: 2, ignoredFiles: 0, safe: false },
            { name: "0a1b2c3d", path: "x", branch: "synapse2/0a1b2c3d", changedFiles: 0, unmergedCommits: 0, ignoredFiles: 2, ignoredExample: ".env.local", safe: false },
            { name: "c9d0e1f2", path: "x", branch: "synapse2/c9d0e1f2", changedFiles: null, unmergedCommits: null, safe: false },
          ]
        : [];
    case "cleanup_orphan_worktrees":
      window.__cleanup = args;
      return { removed: args.names, skipped: [] };
    case "search_sessions":
    case "get_release_notes_since":
      return [];
    case "get_update_status": return { state: "idle" };
    case "get_update_check_info": return {};
    case "check_for_updates": return { state: "idle" };
    case "statusline_status": return { installed: true };
    case "clip_get": return "";
    default: return null;
  }
}

// ?auto=1 starts a session straight away; ?zoom=<n> counteracts browser zoom.
if (params.get("zoom")) document.documentElement.style.zoom = params.get("zoom");
if (params.get("auto")) {
  const go = () => {
    const b = document.querySelector(".browse");
    if (!b) return setTimeout(go, 150);
    b.click();
    setTimeout(() => document.querySelector(".start")?.click(), 200);
  };
  setTimeout(go, 300);
}
if (params.get("theme")) localStorage.setItem("synapse2.filters.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("synapse2.filters.v1") || "{}"), theme: params.get("theme") }));
// ?fl=<json> merges settings into the saved filters (e.g. {"defaultAgent":"claude"}).
if (params.get("fl")) { try { localStorage.setItem("synapse2.filters.v1", JSON.stringify({ ...JSON.parse(localStorage.getItem("synapse2.filters.v1") || "{}"), ...JSON.parse(params.get("fl")) })); } catch {} }
if (params.get("toured")) { try { localStorage.setItem("synapse2.toured.v1", "1"); } catch {} }
// ?browser=1 opens the Resume browser (Ctrl+Shift+R) once the app is up, with every folder expanded.
if (params.get("browser")) {
  setTimeout(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true, bubbles: true }));
    setTimeout(() => document.querySelectorAll(".proj-head").forEach((b) => b.click()), 600);
  }, 1200);
}
