import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import TerminalPane from "./TerminalPane.jsx";
import SettingsModal from "./SettingsModal.jsx";
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
  messageDisplay,
  resolveCategory,
} from "./filters.js";

const KIND_COLORS = KIND_COLOR;
const CAT_COLOR = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.color]));
const CAT_LABEL = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.label]));

// Persisted terminal/messages split (percent width of the terminal column).
const SPLIT_KEY = "synapse2.split.v1";
function loadSplit() { const v = parseFloat(localStorage.getItem(SPLIT_KEY)); return v >= 20 && v <= 80 ? v : 58; }
function saveSplit(v) { try { localStorage.setItem(SPLIT_KEY, String(Math.round(v))); } catch {} }

// Group a flat parsed transcript into turns keyed by the user's prompts.
function groupTurns(messages) {
  const turns = [];
  let cur = null;
  for (const m of messages) {
    if (m.kind === "user") {
      cur = { id: m.id, prompt: m.text, ts: m.ts, responses: [] };
      turns.push(cur);
    } else {
      if (!cur) { cur = { id: "__start", prompt: "(session start)", responses: [] }; turns.push(cur); }
      cur.responses.push(m);
    }
  }
  return turns;
}

function ResponseBubble({ m }) {
  const color = KIND_COLORS[m.kind] || "#9fb0c9";
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
}

// Filtered-out tools collapse into a row (ClaudeConnect style): consecutive
// same-category tools become ONE marker with a ×N count, packed side-by-side.
//   dot  → a small colored dot (+ ×N)
//   pill → a category-labeled pill (+ ×N)
function PillDot({ g }) {
  const color = CAT_COLOR[g.cat] || "#9fb0c9";
  return (
    <span className="pdot" title={`${g.last.toolName || g.cat}${g.count > 1 ? ` ×${g.count}` : ""}`}>
      <span className="pdot-dot" style={{ background: color }} />
      {g.count > 1 && <span className="pdot-count">×{g.count}</span>}
    </span>
  );
}
function PillFull({ g }) {
  const color = CAT_COLOR[g.cat] || "#9fb0c9";
  const label = CAT_LABEL[g.cat] || g.last.toolName || g.cat;
  return (
    <span className="pfull" style={{ borderColor: color, color }} title={g.last.toolName || label}>
      ▸ {label}{g.count > 1 ? ` ×${g.count}` : ""}
    </span>
  );
}

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

function Launch({ onStart, recent = [], onOpenSettings, onCancel }) {
  const [folder, setFolder] = useState("");
  const [fullAutonomy, setFullAutonomy] = useState(true);
  const [worktrees, setWorktrees] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
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
  return (
    <div className="launch">
      <div className="launch-card">
        <div className="launch-head">
          <div className="logo">◆ {onCancel ? "New session" : "Synapse 2"}</div>
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
        <button className="start" onClick={go}>▶ Start session</button>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState([]);          // {id, sessionId, cwd, command, branch}
  const [activeId, setActiveId] = useState(null);
  const [newOpen, setNewOpen] = useState(false); // show the "new session" overlay
  const [convos, setConvos] = useState({});      // id -> {messages, ready}
  const [selById, setSelById] = useState({});    // id -> selected turn id
  const [busyById, setBusyById] = useState({});  // id -> bool (working right now)
  const [newById, setNewById] = useState({});    // id -> bool (unseen activity on a background tab)
  const [confirmCloseId, setConfirmCloseId] = useState(null); // tab pending close confirmation
  const [filters, setFilters] = useState(loadFilters());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("appearance");
  const [recent, setRecent] = useState(loadRecentFolders());
  const [split, setSplit] = useState(loadSplit());
  const [error, setError] = useState("");
  const colsRef = useRef(null);
  const tabCounter = useRef(0);
  const countsRef = useRef({});
  const busyTimers = useRef({});
  const activeIdRef = useRef(activeId);

  // Poll every session's transcript so background tabs update + show activity.
  useEffect(() => {
    if (tabs.length === 0) return;
    let alive = true;
    const tick = async () => {
      for (const t of tabs) {
        try {
          const r = await invoke("get_conversation", { sessionId: t.sessionId });
          if (!alive || !r) continue;
          const msgs = r.messages || [];
          const prev = countsRef.current[t.id] ?? 0;
          if (msgs.length > prev) {
            // New output in this session → flash "working", and if it's a
            // background tab, mark it as having unseen activity.
            setBusyById((b) => ({ ...b, [t.id]: true }));
            clearTimeout(busyTimers.current[t.id]);
            busyTimers.current[t.id] = setTimeout(() => setBusyById((b) => ({ ...b, [t.id]: false })), 2500);
            if (t.id !== activeIdRef.current) setNewById((n) => ({ ...n, [t.id]: true }));
          }
          countsRef.current[t.id] = msgs.length;
          setConvos((c) => ({ ...c, [t.id]: { messages: msgs, ready: !!r.ready } }));
        } catch (e) { if (alive) setError(String(e)); }
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [tabs]);

  // Track the active tab + clear its unseen-activity marker when you switch to it.
  useEffect(() => {
    activeIdRef.current = activeId;
    if (activeId) setNewById((n) => (n[activeId] ? { ...n, [activeId]: false } : n));
  }, [activeId]);

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

  // Start a session → add a tab (never closes existing ones).
  async function start(opts) {
    const s = await invoke("start_session", { opts });
    setRecent(addRecentFolder(opts.folder));
    tabCounter.current += 1;
    const id = "tab" + tabCounter.current;
    setTabs((ts) => [...ts, { id, sessionId: s.sessionId, cwd: s.cwd, command: s.command, branch: s.branch }]);
    setActiveId(id);
    setNewOpen(false);
  }
  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next); // removing the tab unmounts its TerminalPane, which kills its PTY
    if (id === activeId) {
      const fb = next[idx] || next[idx - 1] || next[next.length - 1] || null;
      setActiveId(fb ? fb.id : null);
    }
  }
  function setSel(turnId) { setSelById((s) => ({ ...s, [activeId]: turnId })); }

  const recentList = recent.slice(0, filters.recentFoldersLimit ?? 5);
  const bgMode = filters.backgroundMode || "none";
  const bgColor = filters.backgroundColor;
  const tabPos = filters.tabPosition || "top";
  const rootClass = "root" + (bgMode !== "none" ? " bg-active" : "");
  const settingsModal = (
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} filters={filters} setFlag={setFlag} setCat={setCat} setAllCats={setAllCats} reset={resetFilters} initialTab={settingsTab} />
  );

  // No sessions yet → full-screen launch.
  if (tabs.length === 0) {
    return (
      <div className={rootClass}>
        <Background mode={bgMode} color={bgColor} speed={filters.warpSpeed} />
        <Launch onStart={start} recent={recentList} onOpenSettings={() => openSettings("appearance")} />
        {settingsModal}
      </div>
    );
  }

  const activeTab = tabs.find((t) => t.id === activeId) || tabs[tabs.length - 1];
  const confirmTab = tabs.find((t) => t.id === confirmCloseId) || null;
  const messages = convos[activeTab.id]?.messages || [];
  const ready = convos[activeTab.id]?.ready || false;
  const busy = !!busyById[activeTab.id];
  const selected = selById[activeTab.id] ?? null;

  const turns = groupTurns(messages);
  const selTurn = turns.find((t) => t.id === selected) || turns[turns.length - 1] || null;
  const latestId = turns.length ? turns[turns.length - 1].id : null;
  const selIdx = selTurn ? turns.findIndex((t) => t.id === selTurn.id) : -1;
  const pinnedOld = selected != null && selTurn && selTurn.id !== latestId;
  const newerCount = pinnedOld && selIdx >= 0 ? turns.length - 1 - selIdx : 0;

  const catById = {};
  for (const m of messages) if (m.kind === "toolcall" && m.toolUseId) catById[m.toolUseId] = m.toolCategory || "other";
  const items = selTurn ? buildItems(selTurn.responses, filters, catById) : [];
  const fullCount = items.filter((it) => it.type === "full").length;

  const tabBar = (
    <div className={"tabbar " + tabPos}>
      {tabs.map((t) => {
        const name = (t.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || t.cwd;
        return (
          <div key={t.id} className={"tab" + (t.id === activeTab.id ? " active" : "")} onClick={() => setActiveId(t.id)} title={t.cwd}>
            {t.id !== activeTab.id && newById[t.id] && (
              <span className={"tab-dot" + (busyById[t.id] ? " working" : "")} title={busyById[t.id] ? "Working…" : "New activity"} />
            )}
            <span className="tab-name">{name}</span>
            <button className="tab-x" onClick={(e) => { e.stopPropagation(); setConfirmCloseId(t.id); }} title="Close session">✕</button>
          </div>
        );
      })}
      <button className="tab-new" onClick={() => setNewOpen(true)} title="New session">＋</button>
    </div>
  );

  return (
    <div className={rootClass}>
      <Background mode={bgMode} color={bgColor} speed={filters.warpSpeed} />
      <div className="app">
        <header className="topbar">
          <div className="logo">◆ Synapse 2</div>
          <div className="session-info" title={activeTab.cwd}>{activeTab.cwd}{activeTab.branch ? ` · ⌥ ${activeTab.branch}` : ""}</div>
          <div className="run-state">{busy ? <span className="pulse">● working…</span> : ready ? `${turns.length} turn(s)` : ""}</div>
          <button className="filters-btn" onClick={() => openSettings("appearance")} title="Settings">⚙ Settings</button>
        </header>
        {tabPos === "top" && tabBar}
        <div className="app-row">
          {tabPos === "left" && tabBar}
          <div className="cols" ref={colsRef} style={{ gridTemplateColumns: `${split}% 6px minmax(0, 1fr)` }}>
            <section className="term-col">
              {tabs.map((t) => (
                <div key={t.id} className="term-host" style={{ display: t.id === activeTab.id ? "block" : "none" }}>
                  <TerminalPane cwd={t.cwd} command={t.command} />
                </div>
              ))}
            </section>
            <div className="divider" onMouseDown={startDrag} title="Drag to resize" />
            <section className="convo-col">
              <div className="rsp-head-row">
                <h3 style={{ margin: 0 }}>Your messages</h3>
                {pinnedOld && (
                  <button className="jump-latest" onClick={() => setSel(null)} title="Follow the latest turn">
                    ↓ latest{newerCount ? ` (${newerCount} newer)` : ""}
                  </button>
                )}
              </div>
              <div className="turns">
                {turns.length === 0 && <div className="empty">Type a prompt into the terminal — it'll appear here.</div>}
                {turns.map((t) => {
                  const isLatest = t.id === latestId;
                  return (
                    <button
                      key={t.id}
                      className={"turn" + (t === selTurn ? " sel" : "") + (isLatest ? " latest" : "")}
                      onClick={() => setSel(t.id)}
                    >
                      <span className={"turn-dot" + (isLatest && busy ? " live" : "")} />
                      <span className="turn-text">{(t.prompt || "(no text)").slice(0, 200)}</span>
                      {isLatest && busy && <span className="turn-live">live</span>}
                      <span className="turn-count">{t.responses.length}</span>
                    </button>
                  );
                })}
              </div>

              <h3>Claude's response {selTurn && <span className="muted">— {fullCount} shown</span>}</h3>
              <div className="responses">
                {!selTurn && <div className="empty">Select one of your messages above.</div>}
                {selTurn && items.length === 0 && <div className="empty">No responses yet.</div>}
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
              {error && <div className="error">{error}</div>}
            </section>
          </div>
        </div>
      </div>
      {newOpen && (
        <div className="launch-overlay">
          <Launch onStart={start} recent={recentList} onOpenSettings={() => openSettings("appearance")} onCancel={() => setNewOpen(false)} />
        </div>
      )}
      {confirmTab && (
        <div className="modal-backdrop" onClick={() => setConfirmCloseId(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="confirm-title">Close session?</div>
            <div className="confirm-body">
              This ends the Claude session in{" "}
              <b>{(confirmTab.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || confirmTab.cwd}</b>{" "}
              and closes its terminal.
            </div>
            <div className="confirm-btns">
              <button className="btn-ghost" onClick={() => setConfirmCloseId(null)}>Cancel</button>
              <button className="confirm-danger" onClick={() => { closeTab(confirmCloseId); setConfirmCloseId(null); }}>
                Close session
              </button>
            </div>
          </div>
        </div>
      )}
      {settingsModal}
    </div>
  );
}
