import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import TerminalPane from "./TerminalPane.jsx";
import SettingsModal from "./SettingsModal.jsx";
import SessionBrowser from "./SessionBrowser.jsx";
import Background from "./Background.jsx";
import DiffView from "./DiffView.jsx";
import Markdown from "./Markdown.jsx";
import {
  TOOL_CATS,
  KIND_COLOR,
  DEFAULT_FILTERS,
  loadFilters,
  saveFilters,
  loadRecentFolders,
  addRecentFolder,
  saveTitle,
  messageDisplay,
  resolveCategory,
  displayColor,
  pillStyle,
} from "./filters.js";

// Components read the applied theme off the root element; any theme change
// re-renders the whole tree (filters state), so this stays in sync.
const isLightTheme = () => document.documentElement.dataset.theme === "light";

const KIND_COLORS = KIND_COLOR;
const CAT_COLOR = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.color]));
const CAT_LABEL = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.label]));

// Persisted terminal/messages split (percent width of the terminal column).
const SPLIT_KEY = "synapse2.split.v1";
function loadSplit() { const v = parseFloat(localStorage.getItem(SPLIT_KEY)); return v >= 20 && v <= 80 ? v : 58; }
function saveSplit(v) { try { localStorage.setItem(SPLIT_KEY, String(Math.round(v))); } catch {} }

// Render only this many turns by default; older ones sit behind "show earlier".
const TURN_CAP = 120;

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n || 0);
}

// Countdown to a window reset: "2h 14m", "45m", or "2d 4h" for long windows.
function fmtReset(epochSec) {
  if (!epochSec) return "?";
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.ceil(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// One rate-limit window chip: "session 23% · resets in 2h 14m". Color climbs
// with usage — neutral → gold (50%) → orange (70%) → red (90%) — and a thin
// progress bar along the bottom shows the exact fill.
function LimitChip({ icon, label, win }) {
  if (!win || win.used_percentage == null) return null;
  const pct = Math.min(100, Math.round(win.used_percentage));
  const tier = pct >= 90 ? " red" : pct >= 70 ? " orange" : pct >= 50 ? " gold" : "";
  return (
    <div
      className={"usage-chip limit" + tier}
      title={`${label} window: ${win.used_percentage}% used\nResets ${new Date((win.resets_at || 0) * 1000).toLocaleString()}`}
    >
      <span className="limit-fill" style={{ width: pct + "%" }} />
      {icon} {label} {pct}% · resets in {fmtReset(win.resets_at)}
    </div>
  );
}

const CMD_RE = /^\s*<command-name>([^<]*)<\/command-name>/;
const LOCAL_RE = /^\s*<local-command-(stdout|caveat)>/;
const stripAnsi = (s) => (s || "").replace(/\[[0-9;]*m/g, "");

// Group a flat parsed transcript into turns keyed by the user's prompts.
// Claude Code's slash-command bookkeeping (<command-name>…, <local-command-stdout>…)
// is cleaned up: commands become "/name" turns, stdout/caveat blobs fold into
// the current turn instead of starting noise turns of their own.
function groupTurns(messages) {
  const turns = [];
  let cur = null;
  for (const m of messages) {
    if (m.kind === "user") {
      const text = m.text || "";
      if (LOCAL_RE.test(text)) {
        const body = stripAnsi(text.replace(/<\/?local-command-[a-z-]+>/g, "")).trim();
        if (cur && body) {
          cur.responses.push({ ...m, kind: "toolresult", text: body });
        }
        continue;
      }
      const cmd = CMD_RE.exec(text);
      cur = {
        id: m.id,
        prompt: cmd ? cmd[1].trim() : stripAnsi(text),
        isCommand: !!cmd,
        ts: m.ts,
        responses: [],
      };
      turns.push(cur);
    } else {
      if (!cur) { cur = { id: "__start", prompt: "(session start)", responses: [] }; turns.push(cur); }
      cur.responses.push(m);
    }
  }
  return turns;
}

// Memoized: a turn's responses don't change once the next turn starts, so the
// markdown/diff work for old bubbles never re-runs on poll updates.
const ResponseBubble = memo(function ResponseBubble({ m }) {
  const color = displayColor(KIND_COLORS[m.kind] || "#9fb0c9", isLightTheme());
  const head =
    m.kind === "toolcall" ? `▸ ${m.toolName || "tool"}${m.toolCategory ? " · " + m.toolCategory : ""}` :
    m.kind === "toolresult" ? "⤷ result" :
    m.kind === "error" ? "✗ error" :
    m.kind === "plan" ? "⌑ plan" :
    m.kind === "thinking" ? "… thinking" :
    m.kind === "question" ? "? question" : "assistant";
  const clamp = m.kind === "thinking" || m.kind === "toolresult";
  return (
    <div className="rsp" style={{ borderLeftColor: color }}>
      <div className="rsp-head" style={{ color }}>{head}</div>
      {(m.kind === "message" || m.kind === "question" || m.kind === "plan") ? (
        <Markdown>{m.text}</Markdown>
      ) : (
        <div className={"rsp-text" + (clamp ? " clamp" : "")}>{m.text}</div>
      )}
      {m.kind === "toolcall" && m.editData && <DiffView editData={m.editData} toolName={m.toolName} />}
    </div>
  );
});

// Filtered-out tools collapse into a row (ClaudeConnect style): consecutive
// same-category tools become ONE marker with a ×N count, packed side-by-side.
const PillDot = memo(function PillDot({ g }) {
  const color = displayColor(CAT_COLOR[g.cat] || "#9fb0c9", isLightTheme());
  return (
    <span className="pdot" title={`${g.last.toolName || g.cat}${g.count > 1 ? ` ×${g.count}` : ""}`}>
      <span className="pdot-dot" style={{ background: color }} />
      {g.count > 1 && <span className="pdot-count">×{g.count}</span>}
    </span>
  );
});
const PillFull = memo(function PillFull({ g }) {
  const style = pillStyle(CAT_COLOR[g.cat] || "#9fb0c9", isLightTheme());
  const label = CAT_LABEL[g.cat] || g.last.toolName || g.cat;
  return (
    <span className="pfull" style={style} title={g.last.toolName || label}>
      ▸ {label}{g.count > 1 ? ` ×${g.count}` : ""}
    </span>
  );
});

// Keyboard cheat-sheet (Ctrl+Shift+D). Primary bindings are left-hand-only so
// the right hand can stay on the mouse.
const HOTKEYS = [
  ["Ctrl+Shift+T", "New session"],
  ["Ctrl+Shift+R", "Resume a session (browser)"],
  ["Ctrl+Shift+W", "Close current session"],
  ["Ctrl+Tab / Ctrl+Shift+Tab", "Next / previous tab"],
  ["Ctrl+1 … 5", "Jump to tab 1–5"],
  ["Ctrl+Shift+F", "Search this session"],
  ["Ctrl+Shift+E", "Export conversation (Markdown)"],
  ["Ctrl+Shift+G", "Jump to latest turn"],
  ["Ctrl+Shift+S", "Settings"],
  ["Ctrl+Shift+D", "This cheat-sheet"],
  ["Esc", "Close any overlay"],
];
function HotkeySheet({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="hk-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="hk-head">
          <span>⌨ Keyboard shortcuts</span>
          <span className="hk-hint">left-hand friendly — mouse stays in your right</span>
          <button className="tab-x" onClick={onClose}>✕</button>
        </div>
        <div className="hk-rows">
          {HOTKEYS.map(([keys, what]) => (
            <div key={keys} className="hk-row">
              <span className="hk-keys">{keys.split(" / ").map((kk, i) => (
                <span key={kk}>{i > 0 && " / "}<kbd>{kk}</kbd></span>
              ))}</span>
              <span className="hk-what">{what}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// One turn in the unified feed: your prompt is the card header, Claude's
// responses nest underneath when expanded. Collapsed turns cost nothing —
// their items aren't even built. `live` is only ever true for the latest
// turn, so busy-flag flips don't re-render the whole feed.
const TurnCard = memo(function TurnCard({ t, expanded, live, matchCount = 0, filters, catById, onToggle }) {
  const items = useMemo(
    () => (expanded ? buildItems(t.responses, filters, catById) : []),
    [expanded, t.responses.length, filters, catById]
  );
  return (
    <div className={"tcard" + (expanded ? " open" : "")}>
      <button className="tcard-head" onClick={() => onToggle(t.id)} title={t.prompt}>
        <span className="tcard-chev">{expanded ? "▾" : "▸"}</span>
        <span className={"tcard-prompt" + (expanded ? "" : " one-line") + (t.isCommand ? " cmd" : "")}>
          {t.isCommand ? "⌘ " : "› "}{(t.prompt || "(session start)").slice(0, 400)}
        </span>
        {live && <span className="turn-live">live</span>}
        {matchCount > 0 && <span className="tcard-match">{matchCount} match{matchCount > 1 ? "es" : ""}</span>}
        {!expanded && <span className="tcard-count">{t.responses.length}</span>}
      </button>
      {expanded && (
        <div className="tcard-body">
          {items.length === 0 && <div className="empty">{live ? "● working…" : "No responses."}</div>}
          {items.map((it, i) =>
            it.type === "full" ? (
              <ResponseBubble key={it.m.id} m={it.m} />
            ) : (
              <div key={"row" + i} className="pill-row">
                {it.groups.map((g, j) =>
                  g.variant === "pill" ? <PillFull key={j} g={g} /> : <PillDot key={j} g={g} />
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
});

// Collapse a turn's responses into render items: 'full' bubbles, and 'pillrow'
// runs of consecutive filtered tools (grouped by category with counts).
function buildItems(responses, filters, catById) {
  const items = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const groups = [];
    for (const it of run) {
      const lg = groups[groups.length - 1];
      if (lg && lg.cat === it.cat && lg.variant === it.disp) { lg.count += 1; lg.last = it.m; }
      else groups.push({ cat: it.cat, variant: it.disp, count: 1, last: it.m });
    }
    items.push({ type: "pillrow", groups });
    run = [];
  };
  for (const m of responses) {
    const disp = messageDisplay(m, filters, catById);
    if (disp === "full") { flush(); items.push({ type: "full", m }); }
    else if (disp === "hidden") { /* drop, keep the run contiguous */ }
    else run.push({ m, disp, cat: resolveCategory(m, catById) });
  }
  flush();
  return items;
}

function Launch({ onStart, recent = [], onOpenSettings, onOpenBrowser, onCancel }) {
  const [folder, setFolder] = useState("");
  const [fullAutonomy, setFullAutonomy] = useState(true);
  const [worktrees, setWorktrees] = useState(false);
  const [error, setError] = useState("");
  const [orphans, setOrphans] = useState(0);
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  // Old session worktrees left behind in the chosen folder → offer cleanup.
  useEffect(() => {
    setOrphans(0);
    const f = folder.trim();
    if (!f) return;
    invoke("list_orphan_worktrees", { folder: f })
      .then((l) => setOrphans((l || []).length))
      .catch(() => {});
  }, [folder]);
  async function pick() {
    try {
      const sel = await open({ directory: true, multiple: false, title: "Choose a folder for the session" });
      if (sel) setFolder(sel);
    } catch (e) { setError(String(e)); }
  }
  async function go() {
    setError("");
    if (!folder.trim()) { setError("Choose a folder first."); return; }
    try { await onStart({ folder, fullAutonomy, worktrees }); } catch (e) { setError(String(e)); }
  }
  async function cleanup() {
    try {
      const n = await invoke("cleanup_orphan_worktrees", { folder: folder.trim() });
      setOrphans(0);
      setError("");
      if (n > 0) setError(`Cleaned up ${n} old worktree(s).`);
    } catch (e) { setError(String(e)); }
  }
  return (
    <div className="launch">
      <div className="launch-card">
        <div className="launch-head">
          <div className="logo"><span className="logo-mark">◆</span> {onCancel ? "New session" : "Synapse 2"}</div>
          <div className="launch-head-btns">
            {onOpenSettings && <button className="launch-gear" onClick={onOpenSettings} title="Settings">⚙</button>}
            {onCancel && <button className="launch-gear" onClick={onCancel} title="Cancel">✕</button>}
          </div>
        </div>
        <div className="tagline">A terminal-driven Claude Code, with your conversation laid out beside it.</div>
        <label>Folder</label>
        <div className="row">
          <input className="folder-input" type="text" value={folder} placeholder="Choose a folder…" onChange={(e) => setFolder(e.target.value)} />
          <button className="browse" onClick={pick}>Browse…</button>
        </div>
        {recent.length > 0 && (
          <div className="recent">
            <label>Recent</label>
            <div className="recent-list">
              {recent.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={"recent-item" + (folder === p ? " sel" : "")}
                  onClick={() => setFolder(p)}
                  title={p}
                >
                  <span className="recent-ic">🗂</span>
                  <span className="recent-path">{p}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="toggles">
          <label><input type="checkbox" checked={fullAutonomy} onChange={(e) => setFullAutonomy(e.target.checked)} /> Full autonomy (--dangerously-skip-permissions)</label>
          <label><input type="checkbox" checked={worktrees} onChange={(e) => setWorktrees(e.target.checked)} /> Git worktree isolation (if the folder is a repo)</label>
        </div>
        {orphans > 0 && (
          <div className="orphan-row">
            {orphans} old session worktree(s) in this folder —{" "}
            <button className="link-like" onClick={cleanup}>clean them up</button>
          </div>
        )}
        <button className="start" onClick={go}>▶ Start session</button>
        <button className="resume-link" onClick={onOpenBrowser}>⧉ …or resume a previous session</button>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState([]);          // {id, sessionId, root, cwd, command, branch, title, createdAt}
  const [activeId, setActiveId] = useState(null);
  const [newOpen, setNewOpen] = useState(false); // show the "new session" overlay
  const [browserOpen, setBrowserOpen] = useState(false);
  const [convos, setConvos] = useState({});      // tabId -> {messages, ready, usage}
  const [expandById, setExpandById] = useState({}); // tabId -> {turnId: bool} overrides
  const [busyById, setBusyById] = useState({});  // tabId -> bool (working right now)
  const [newById, setNewById] = useState({});    // tabId -> bool (unseen activity on a background tab)
  const [showAllTurns, setShowAllTurns] = useState({}); // tabId -> bool
  const [confirmCloseId, setConfirmCloseId] = useState(null);
  const [closeAction, setCloseAction] = useState("keep"); // worktree handling on close
  const [closing, setClosing] = useState(false);
  const [filters, setFilters] = useState(loadFilters());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("appearance");
  const [recent, setRecent] = useState(loadRecentFolders());
  const [split, setSplit] = useState(loadSplit());
  const [error, setError] = useState("");
  const [rateLimits, setRateLimits] = useState(null);
  const [searchQ, setSearchQ] = useState("");
  const [renamingTab, setRenamingTab] = useState(null); // tab id being renamed
  const [renameVal, setRenameVal] = useState("");
  const [ctxMenu, setCtxMenu] = useState(null); // {id, x, y} — tab context menu
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const dragTab = useRef(null);
  const feedSearchRef = useRef(null);

  // App-level hotkeys (terminal-safe: Ctrl+Shift+letter + a few Ctrl combos
  // shells never see). The handler closures are refreshed every render via a
  // ref so the mount-once listener never goes stale.
  const hotkeysRef = useRef({});
  hotkeysRef.current = {
    newSession: () => setNewOpen(true),
    browse: () => setBrowserOpen(true),
    closeTab: () => {
      if (activeId) { setCloseAction("keep"); setConfirmCloseId(activeId); }
    },
    cycle: (dir) => {
      setTabs((ts) => {
        if (ts.length > 1) {
          const i = ts.findIndex((t) => t.id === activeIdRef.current);
          setActiveId(ts[(i + dir + ts.length) % ts.length].id);
        }
        return ts;
      });
    },
    jumpTab: (n) => {
      setTabs((ts) => {
        if (ts[n]) setActiveId(ts[n].id);
        return ts;
      });
    },
    focusSearch: () => feedSearchRef.current?.focus(),
    exportMd: () => { if (activeId) exportConversation("md"); },
    latest: () => jumpToLatest(),
    settings: () => openSettings("appearance"),
    cheatsheet: () => setHotkeysOpen((v) => !v),
  };
  useEffect(() => {
    // Primary bindings live in the LEFT-hand zone (QWERT/ASDFG + 1-5 + Tab)
    // so the mouse hand never has to leave the mouse. A few right-side keys
    // stay as aliases.
    const onKey = (e) => {
      if (!e.ctrlKey || e.altKey) return;
      const h = hotkeysRef.current;
      const k = e.key.toLowerCase();
      const go = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
      if (k === "tab") return go(() => h.cycle(e.shiftKey ? -1 : 1));
      if (!e.shiftKey && e.key >= "1" && e.key <= "9") return go(() => h.jumpTab(Number(e.key) - 1));
      if (!e.shiftKey && e.key === ",") return go(h.settings); // alias
      if (!e.shiftKey && e.key === "/") return go(h.cheatsheet); // alias
      if (!e.shiftKey) return;
      if (k === "t") return go(h.newSession);
      if (k === "r" || k === "o") return go(h.browse); // R primary, O alias
      if (k === "w") return go(h.closeTab);
      if (k === "f") return go(h.focusSearch);
      if (k === "e") return go(h.exportMd);
      if (k === "g" || k === "l") return go(h.latest); // G primary, L alias
      if (k === "s") return go(h.settings);
      if (k === "d") return go(h.cheatsheet);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const colsRef = useRef(null);
  const tabCounter = useRef(0);
  const busyTimers = useRef({});
  const activeIdRef = useRef(activeId);
  const tabsRef = useRef(tabs);
  const fetchingRef = useRef({});
  tabsRef.current = tabs;

  // Delta-fetch one tab's new messages (the backend tails the transcript and
  // caches parsed messages — this never re-reads or re-parses the file).
  async function fetchTab(t) {
    if (fetchingRef.current[t.id]) return;
    fetchingRef.current[t.id] = true;
    try {
      const since = (convosRef.current[t.id]?.messages || []).length;
      const r = await invoke("get_conversation", { sessionId: t.sessionId, since });
      const delta = r?.messages || [];
      if (delta.length > 0) {
        setBusyById((b) => ({ ...b, [t.id]: true }));
        clearTimeout(busyTimers.current[t.id]);
        busyTimers.current[t.id] = setTimeout(() => setBusyById((b) => ({ ...b, [t.id]: false })), 2500);
        if (t.id !== activeIdRef.current) setNewById((n) => ({ ...n, [t.id]: true }));
      }
      setConvos((c) => {
        const prev = c[t.id] || { messages: [], ready: false, usage: null };
        const next = {
          messages: delta.length ? [...prev.messages, ...delta] : prev.messages,
          ready: !!r?.ready,
          usage: r?.usage || prev.usage,
        };
        return { ...c, [t.id]: next };
      });
    } catch (e) {
      setError(String(e));
    } finally {
      fetchingRef.current[t.id] = false;
    }
  }
  // Keep a live view of convos for `since` computation without re-subscribing.
  const convosRef = useRef(convos);
  convosRef.current = convos;

  // Event-driven updates: the backend emits syn2:changed when a transcript
  // grows; a slow interval is only a safety net (and covers `ready` flips).
  useEffect(() => {
    if (tabs.length === 0) return;
    let alive = true;
    let unlisten = null;
    listen("syn2:changed", (e) => {
      if (!alive) return;
      const sid = e.payload?.sessionId;
      const t = tabsRef.current.find((x) => x.sessionId === sid);
      if (t) fetchTab(t);
    }).then((u) => (unlisten = u));
    const tick = () => Promise.all(tabsRef.current.map((t) => fetchTab(t)));
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); if (unlisten) unlisten(); };
  }, [tabs.length > 0]);

  // Track the active tab + clear its unseen-activity marker when you switch to it.
  useEffect(() => {
    activeIdRef.current = activeId;
    if (activeId) setNewById((n) => (n[activeId] ? { ...n, [activeId]: false } : n));
  }, [activeId]);

  // Rate-limit windows (session 5h + weekly), cached by the statusline script
  // on every Claude refresh. Cheap file read; poll slowly + on changes.
  useEffect(() => {
    let alive = true;
    const fetchLimits = () =>
      invoke("get_rate_limits").then((r) => alive && setRateLimits(r)).catch(() => {});
    fetchLimits();
    let unlisten = null;
    listen("syn2:changed", fetchLimits).then((u) => (unlisten = u));
    const id = setInterval(fetchLimits, 30000);
    return () => { alive = false; clearInterval(id); if (unlisten) unlisten(); };
  }, []);

  // Theme + accent: applied at the document root so every panel follows.
  const [effTheme, setEffTheme] = useState("dark");
  useEffect(() => {
    const apply = () => {
      const pref = filters.theme || "dark";
      const effective =
        pref === "system"
          ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
          : pref;
      document.documentElement.dataset.theme = effective;
      setEffTheme(effective);
      if (filters.accent) document.documentElement.style.setProperty("--accent", filters.accent);
      else document.documentElement.style.removeProperty("--accent");
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [filters.theme, filters.accent]);

  // Esc cancels the close-session confirmation.
  useEffect(() => {
    if (!confirmCloseId) return;
    const onKey = (e) => { if (e.key === "Escape") setConfirmCloseId(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmCloseId]);

  function setFlag(key, value) { setFilters((f) => { const n = { ...f, [key]: value }; saveFilters(n); return n; }); }
  function setCat(cat, value) { setFilters((f) => { const n = { ...f, toolCategories: { ...f.toolCategories, [cat]: value } }; saveFilters(n); return n; }); }
  function setAllCats(value) {
    setFilters((f) => { const tc = {}; for (const c of TOOL_CATS) tc[c.key] = value; const n = { ...f, toolCategories: tc }; saveFilters(n); return n; });
  }
  function resetFilters() { setFilters(DEFAULT_FILTERS); saveFilters(DEFAULT_FILTERS); }
  function openSettings(t) { setSettingsTab(t || "appearance"); setSettingsOpen(true); }

  // Drag the divider to resize terminal vs. messages; persists across restarts.
  function startDrag(e) {
    e.preventDefault();
    let last = split;
    const onMove = (ev) => {
      const el = colsRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      let pct = ((ev.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(20, Math.min(80, pct));
      last = pct;
      setSplit(pct);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      saveSplit(last);
      window.dispatchEvent(new Event("resize"));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function addTab(s, title) {
    tabCounter.current += 1;
    const id = "tab" + tabCounter.current;
    setTabs((ts) => [...ts, {
      id,
      sessionId: s.sessionId,
      root: s.root,
      cwd: s.cwd,
      command: s.command,
      branch: s.branch,
      title: title || null,
      createdAt: Date.now(),
    }]);
    setActiveId(id);
    setNewOpen(false);
    setBrowserOpen(false);
  }

  // Start a session → add a tab (never closes existing ones).
  async function start(opts) {
    const s = await invoke("start_session", { opts });
    setRecent(addRecentFolder(opts.folder));
    addTab(s, null);
  }

  // Resume an existing Claude Code session from the browser.
  async function resume(sessionMeta, title) {
    try {
      const s = await invoke("resume_session", {
        sessionId: sessionMeta.sessionId,
        cwd: sessionMeta.cwd || "",
        fullAutonomy: true,
      });
      if (sessionMeta.cwd) setRecent(addRecentFolder(sessionMeta.cwd));
      addTab(s, title || sessionMeta.title || null);
    } catch (e) {
      setError(String(e));
    }
  }

  function removeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next); // removing the tab unmounts its TerminalPane, which kills its PTY
    setConvos((c) => { const n = { ...c }; delete n[id]; return n; });
    if (id === activeId) {
      const fb = next[idx] || next[idx - 1] || next[next.length - 1] || null;
      setActiveId(fb ? fb.id : null);
    }
  }

  // Close = stop the tailer + (optionally) merge/delete the session worktree.
  async function confirmClose() {
    const t = tabs.find((x) => x.id === confirmCloseId);
    if (!t) { setConfirmCloseId(null); return; }
    setClosing(true);
    try {
      await invoke("close_session", {
        sessionId: t.sessionId,
        root: t.branch ? t.root : null,
        worktreePath: t.branch ? t.cwd : null,
        branch: t.branch || null,
        action: t.branch ? closeAction : "keep",
      });
      removeTab(t.id);
      setConfirmCloseId(null);
      setCloseAction("keep");
    } catch (e) {
      setError(String(e)); // e.g. merge conflict — session stays open to resolve it
    } finally {
      setClosing(false);
    }
  }

  // Toggle one turn's expansion (overriding the "latest is open" default).
  function toggleTurn(turnId, effectiveExpanded) {
    setExpandById((s) => ({
      ...s,
      [activeId]: { ...(s[activeId] || {}), [turnId]: !effectiveExpanded },
    }));
  }

  // Drag-reorder tabs.
  function dropTab(targetId) {
    const src = dragTab.current;
    dragTab.current = null;
    if (!src || src === targetId) return;
    setTabs((ts) => {
      const a = [...ts];
      const i = a.findIndex((x) => x.id === src);
      const j = a.findIndex((x) => x.id === targetId);
      if (i < 0 || j < 0) return ts;
      const [m] = a.splice(i, 1);
      a.splice(j, 0, m);
      return a;
    });
  }

  // Inline tab rename (double-click) — also names the session in the browser.
  function commitTabRename(t) {
    const name = renameVal.trim();
    setTabs((ts) => ts.map((x) => (x.id === t.id ? { ...x, title: name || null } : x)));
    saveTitle(t.sessionId, name);
    setRenamingTab(null);
  }

  const recentList = recent.slice(0, filters.recentFoldersLimit ?? 5);
  const bgMode = filters.backgroundMode || "none";
  const bgColor = filters.backgroundColor;
  const tabPos = filters.tabPosition || "top";
  const rootClass = "root" + (bgMode !== "none" ? " bg-active" : "");
  const settingsModal = (
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} filters={filters} setFlag={setFlag} setCat={setCat} setAllCats={setAllCats} reset={resetFilters} initialTab={settingsTab} />
  );
  const browserModal = browserOpen && (
    <SessionBrowser onResume={resume} onClose={() => setBrowserOpen(false)} />
  );

  // NOTE: every hook below must run on EVERY render — including the no-tabs
  // launch screen — so they live ABOVE the early return (hooks after a
  // conditional return crash React with "rendered more hooks than before"
  // the moment the first tab appears).
  const activeTab = tabs.find((t) => t.id === activeId) || tabs[tabs.length - 1] || null;
  const confirmTab = tabs.find((t) => t.id === confirmCloseId) || null;
  const convo = (activeTab && convos[activeTab.id]) || {};
  const messages = convo.messages || [];
  const ready = convo.ready || false;
  const usage = convo.usage || null;
  const busy = !!(activeTab && busyById[activeTab.id]);
  const startupStuck = !!activeTab && !ready && Date.now() - (activeTab.createdAt || 0) > 12000;

  const turns = useMemo(() => groupTurns(messages), [messages]);
  const latestId = turns.length ? turns[turns.length - 1].id : null;
  const overrides = (activeTab && expandById[activeTab.id]) || {};

  const catById = useMemo(() => {
    const map = {};
    for (const m of messages) if (m.kind === "toolcall" && m.toolUseId) map[m.toolUseId] = m.toolCategory || "other";
    return map;
  }, [messages]);

  // In-session search: filter the feed to matching turns (prompt OR responses).
  const q = searchQ.trim().toLowerCase();
  const searchMatches = useMemo(() => {
    if (q.length < 2) return null;
    const map = {};
    for (const t of turns) {
      let n = (t.prompt || "").toLowerCase().includes(q) ? 1 : 0;
      for (const m of t.responses) if ((m.text || "").toLowerCase().includes(q)) n++;
      if (n) map[t.id] = n;
    }
    return map;
  }, [q, turns]);
  const searching = searchMatches !== null;

  // Tail-cap the feed so very long sessions don't bloat the DOM. A search
  // always scans/filters ALL turns, ignoring the cap.
  const allTurnsShown = !!(activeTab && showAllTurns[activeTab.id]);
  const visibleTurns = searching
    ? turns.filter((t) => searchMatches[t.id])
    : allTurnsShown || turns.length <= TURN_CAP
    ? turns
    : turns.slice(turns.length - TURN_CAP);

  // Auto-follow: stick to the bottom of the feed unless the user scrolled up.
  const feedRef = useRef(null);
  const stickRef = useRef(true);
  const [unstuck, setUnstuck] = useState(false);
  useEffect(() => {
    if (stickRef.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages.length, activeId]);
  useEffect(() => {
    // Switching tabs re-follows the live end.
    stickRef.current = true;
    setUnstuck(false);
  }, [activeId]);
  function onFeedScroll() {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = atBottom;
    setUnstuck(!atBottom);
  }
  function jumpToLatest() {
    stickRef.current = true;
    setUnstuck(false);
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }

  // Focus-scoped feed navigation: after clicking a turn card, ↑/↓ move between
  // cards, Enter/Space toggles (native button behavior), Esc collapses. These
  // only fire when a card has focus, so they can never collide with typing in
  // the terminal or an input.
  function onFeedKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const heads = Array.from(feedRef.current?.querySelectorAll(".tcard-head") || []);
      if (!heads.length) return;
      const i = heads.indexOf(document.activeElement);
      const next = heads[Math.max(0, Math.min(heads.length - 1, (i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1))))];
      if (next) {
        e.preventDefault();
        next.focus();
        next.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Escape") {
      const openCard = document.activeElement?.closest?.(".tcard.open");
      const head = openCard?.querySelector(".tcard-head");
      if (head) {
        e.preventDefault();
        head.click(); // collapse, keep focus on the card
        head.focus();
      }
    }
  }

  // No sessions yet → full-screen launch.
  if (tabs.length === 0 || !activeTab) {
    return (
      <div className={rootClass}>
        <Background mode={bgMode} color={bgColor} speed={filters.warpSpeed} light={effTheme === "light"} />
        <Launch onStart={start} recent={recentList} onOpenSettings={() => openSettings("appearance")} onOpenBrowser={() => setBrowserOpen(true)} />
        {browserModal}
        {settingsModal}
        {hotkeysOpen && <HotkeySheet onClose={() => setHotkeysOpen(false)} />}
      </div>
    );
  }

  async function exportConversation(format) {
    try {
      const base = (activeTab.title || (activeTab.cwd || "session").split(/[\\/]/).pop() || "session").replace(/[^\w.-]+/g, "-");
      const path = await save({
        title: "Export conversation",
        defaultPath: `${base}-${activeTab.sessionId.slice(0, 8)}.${format}`,
        filters: format === "md"
          ? [{ name: "Markdown", extensions: ["md"] }]
          : [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      let content;
      if (format === "json") {
        content = JSON.stringify({ sessionId: activeTab.sessionId, cwd: activeTab.cwd, usage, messages }, null, 2);
      } else {
        const lines = [`# Claude Code session — ${activeTab.cwd}`, ""];
        for (const t of turns) {
          lines.push(`## › ${t.prompt || "(session start)"}`, "");
          for (const m of t.responses) {
            if (m.kind === "message" || m.kind === "question" || m.kind === "plan") lines.push(m.text, "");
            else if (m.kind === "toolcall") lines.push(`> ▸ **${m.toolName || "tool"}** ${m.text || ""}`, "");
            else if (m.kind === "error") lines.push(`> ✗ ${m.text}`, "");
          }
        }
        content = lines.join("\n");
      }
      await invoke("save_text_file", { path, content });
    } catch (e) {
      setError(String(e));
    }
  }

  const tabBar = (
    <div className={"tabbar " + tabPos}>
      {tabs.map((t) => {
        const name = t.title || (t.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || t.cwd;
        return (
          <div
            key={t.id}
            className={"tab" + (t.id === activeTab.id ? " active" : "")}
            onClick={() => setActiveId(t.id)}
            title={t.cwd + " · double-click to rename, drag to reorder"}
            draggable={renamingTab !== t.id}
            onDragStart={() => (dragTab.current = t.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => dropTab(t.id)}
            onDoubleClick={() => { setRenamingTab(t.id); setRenameVal(t.title || name); }}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: t.id, x: e.clientX, y: e.clientY }); }}
          >
            {t.id !== activeTab.id && newById[t.id] && (
              <span className={"tab-dot" + (busyById[t.id] ? " working" : "")} title={busyById[t.id] ? "Working…" : "New activity"} />
            )}
            {renamingTab === t.id ? (
              <form className="tab-rename" onSubmit={(e) => { e.preventDefault(); commitTabRename(t); }}>
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => commitTabRename(t)}
                  onKeyDown={(e) => { if (e.key === "Escape") setRenamingTab(null); }}
                  onClick={(e) => e.stopPropagation()}
                />
              </form>
            ) : (
              <span className="tab-name">{name}</span>
            )}
            <button className="tab-x" onClick={(e) => { e.stopPropagation(); setCloseAction("keep"); setConfirmCloseId(t.id); }} title="Close session">✕</button>
          </div>
        );
      })}
      <button className="tab-new" onClick={() => setNewOpen(true)} title="New session">＋</button>
      <button className="tab-new" onClick={() => setBrowserOpen(true)} title="Resume a previous session">⧉</button>
    </div>
  );

  return (
    <div className={rootClass}>
      <Background mode={bgMode} color={bgColor} speed={filters.warpSpeed} light={effTheme === "light"} />
      <div className="app">
        <header className="topbar">
          <div className="logo"><span className="logo-mark">◆</span> Synapse 2</div>
          <div className="session-info" title={activeTab.cwd}>{activeTab.cwd}{activeTab.branch ? ` · ⌥ ${activeTab.branch}` : ""}</div>
          {usage && (usage.input > 0 || usage.output > 0) && (
            <div
              className="usage-chip"
              title={`Input ${usage.input.toLocaleString()} · Output ${usage.output.toLocaleString()}\nCache read ${usage.cacheRead.toLocaleString()} · Cache write ${usage.cacheCreation.toLocaleString()}`}
            >
              ⛁ {fmtTokens(usage.input + usage.cacheCreation)} in · {fmtTokens(usage.output)} out
            </div>
          )}
          <LimitChip icon="⏱" label="session" win={rateLimits?.rateLimits?.five_hour} />
          <LimitChip icon="📅" label="week" win={rateLimits?.rateLimits?.seven_day} />
          <div className="run-state">{busy ? <span className="pulse">● working…</span> : ready ? `${turns.length} turn(s)` : ""}</div>
          <button className="filters-btn hk-btn" onClick={() => setHotkeysOpen(true)} title="Keyboard shortcuts (Ctrl+Shift+D)">⌨</button>
          <button className="filters-btn" onClick={() => openSettings("appearance")} title="Settings">⚙ Settings</button>
        </header>
        {tabPos === "top" && tabBar}
        <div className="app-row">
          {tabPos === "left" && tabBar}
          <div className="cols" ref={colsRef} style={{ gridTemplateColumns: `${split}% 6px minmax(0, 1fr)` }}>
            <section className="term-col">
              {tabs.map((t) => (
                <div key={t.id} className="term-host" style={{ display: t.id === activeTab.id ? "block" : "none" }}>
                  <TerminalPane cwd={t.cwd} command={t.command} composer={!!filters.showComposer} />
                </div>
              ))}
            </section>
            <div className="divider" onMouseDown={startDrag} title="Drag to resize" />
            <section className="convo-col">
              <div className="rsp-head-row">
                <h3 style={{ margin: 0 }}>Conversation</h3>
                <div className="feed-search">
                  <input
                    ref={feedSearchRef}
                    type="text"
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    placeholder="Search this session…   (Ctrl+Shift+F)"
                  />
                  {searching && (
                    <span className="feed-search-meta">
                      {visibleTurns.length} turn(s)
                      <button onClick={() => setSearchQ("")} title="Clear search">✕</button>
                    </span>
                  )}
                </div>
                <span className="head-actions">
                  <button className="head-btn" onClick={() => exportConversation("md")} title="Export this conversation as Markdown">⤓ md</button>
                  <button className="head-btn" onClick={() => exportConversation("json")} title="Export this conversation as JSON">⤓ json</button>
                </span>
              </div>
              {startupStuck && (
                <div className="warn-banner">
                  No transcript yet — Claude may not have started in the terminal. Check it for errors (or just press Enter there).
                </div>
              )}
              <div className="feed-uni" ref={feedRef} onScroll={onFeedScroll} onKeyDown={onFeedKey}>
                {turns.length === 0 && <div className="empty">Type a prompt into the terminal — the conversation appears here.</div>}
                {!allTurnsShown && turns.length > TURN_CAP && (
                  <button
                    className="show-earlier"
                    onClick={() => setShowAllTurns((s) => ({ ...s, [activeTab.id]: true }))}
                  >
                    … show {turns.length - TURN_CAP} earlier turn(s)
                  </button>
                )}
                {searching && visibleTurns.length === 0 && (
                  <div className="empty">No turns mention “{searchQ.trim()}”.</div>
                )}
                {visibleTurns.map((t) => (
                  <TurnCard
                    key={t.id}
                    t={t}
                    expanded={searching ? !!overrides[t.id] : overrides[t.id] ?? t.id === latestId}
                    live={t.id === latestId && busy}
                    matchCount={searching ? searchMatches[t.id] : 0}
                    filters={filters}
                    catById={catById}
                    onToggle={(id) => toggleTurn(id, searching ? !!overrides[id] : overrides[id] ?? id === latestId)}
                  />
                ))}
              </div>
              {unstuck && (
                <button className="jump-bottom" onClick={jumpToLatest} title="Follow the latest activity">
                  ↓ latest
                </button>
              )}
              {error && <div className="error">{error}</div>}
            </section>
          </div>
        </div>
      </div>
      {ctxMenu && (() => {
        const t = tabs.find((x) => x.id === ctxMenu.id);
        if (!t) return null;
        const name = t.title || (t.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || t.cwd;
        return (
          <div
            className="ctx-overlay"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
          >
            <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setRenamingTab(t.id); setRenameVal(t.title || name); setCtxMenu(null); }}>
                ✎ Rename
              </button>
              <button onClick={() => { invoke("clip_set", { text: t.cwd }).catch(() => {}); setCtxMenu(null); }}>
                ⧉ Copy folder path
              </button>
              <button
                className="danger"
                onClick={() => { setCloseAction("keep"); setConfirmCloseId(t.id); setCtxMenu(null); }}
              >
                ✕ Close session
              </button>
            </div>
          </div>
        );
      })()}
      {newOpen && (
        <div className="launch-overlay">
          <Launch onStart={start} recent={recentList} onOpenSettings={() => openSettings("appearance")} onOpenBrowser={() => { setNewOpen(false); setBrowserOpen(true); }} onCancel={() => setNewOpen(false)} />
        </div>
      )}
      {confirmTab && (
        <div className="modal-backdrop" onClick={() => !closing && setConfirmCloseId(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="confirm-title">Close session?</div>
            <div className="confirm-body">
              This ends the Claude session in{" "}
              <b>{(confirmTab.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || confirmTab.cwd}</b>{" "}
              and closes its terminal.
            </div>
            {confirmTab.branch && (
              <div className="confirm-worktree">
                <div className="confirm-sub">This session worked in its own worktree (<code>{confirmTab.branch}</code>). What should happen to its changes?</div>
                <label><input type="radio" name="wt" checked={closeAction === "merge"} onChange={() => setCloseAction("merge")} /> Merge into the main folder, then remove the worktree</label>
                <label><input type="radio" name="wt" checked={closeAction === "keep"} onChange={() => setCloseAction("keep")} /> Keep the worktree (decide later)</label>
                <label><input type="radio" name="wt" checked={closeAction === "delete"} onChange={() => setCloseAction("delete")} /> Discard — delete the worktree and its changes</label>
              </div>
            )}
            <div className="confirm-btns">
              <button className="btn-ghost" disabled={closing} onClick={() => setConfirmCloseId(null)}>Cancel</button>
              <button className="confirm-danger" disabled={closing} onClick={confirmClose}>
                {closing ? "Closing…" : "Close session"}
              </button>
            </div>
          </div>
        </div>
      )}
      {browserModal}
      {settingsModal}
      {hotkeysOpen && <HotkeySheet onClose={() => setHotkeysOpen(false)} />}
    </div>
  );
}
