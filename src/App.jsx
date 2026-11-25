import { memo, useEffect, useMemo, useRef, useState } from "react";
import { HvPromoRail, HvPromoChip, HvEmptyHint } from "./HvPromo.jsx";
import { APP_ZOOM, TERM_FONT, READER_ZOOM, stepValue, pct, applyAppZoom } from "./textsize.js";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getVersion } from "@tauri-apps/api/app";
import changelogRaw from "../CHANGELOG.md?raw";
import TerminalPane from "./TerminalPane.jsx";
import SettingsModal from "./SettingsModal.jsx";
import SessionBrowser from "./SessionBrowser.jsx";
import Dashboard, { statusFor, readScreen, sessionFullAutonomy, ctxWindowFor } from "./Dashboard.jsx";
import { useUpdateStatus, installUpdate, dismissUpdate } from "./updater.js";
import Background from "./Background.jsx";
import Orb from "./visuals/Orb.jsx";
import StatusGlyph, { glyphKind, tabWord } from "./StatusGlyph.jsx";
import Markdown from "./Markdown.jsx";
import { Turn, DetailSwitch, BackgroundStrip, AgentFeed } from "./reader/Reader.jsx";
import { AgentPanel, Outline } from "./reader/Panels.jsx";
import { ReaderActions, AgentName } from "./reader/actions.js";
import { AgentCards, AgentSetup } from "./AgentPicker.jsx";
import { AGENTS, agentInfo, agentOf, availability, defaultAgent, lastPermMode, useAgentStatus } from "./agents.js";
import PermModePicker from "./PermModePicker.jsx";
import { useSortDrag, moveTo } from "./sortable.js";
import { groupTurns, backgroundTasks } from "./reader/analyze.js";
import Icon from "./reader/icons.jsx";
import "./reader/reader.css";
import {
  TOOL_CATS,
  KIND_COLOR,
  DEFAULT_FILTERS,
  loadFilters,
  saveFilters,
  loadRecentFolders,
  addRecentFolder,
  normRoot,
  baseNameOf,
  projectColor,
  tabDisplayName,
  saveTitle,
} from "./filters.js";

// Components read the applied theme off the root element; any theme change
// re-renders the whole tree (filters state), so this stays in sync.
const isLightTheme = () => document.documentElement.dataset.theme === "light";

// Windows toast, permission-checked once. Best-effort: failures are silent.
let notifyGranted = null;
async function toast(title, body) {
  try {
    if (notifyGranted === null) {
      notifyGranted = await isPermissionGranted();
      if (!notifyGranted) notifyGranted = (await requestPermission()) === "granted";
    }
    if (notifyGranted) sendNotification({ title, body });
  } catch { /* notifications are never load-bearing */ }
}


// Persisted terminal/messages split (percent width of the terminal column).
const SPLIT_KEY = "synapse2.split.v1";
function loadSplit() { const v = parseFloat(localStorage.getItem(SPLIT_KEY)); return v >= 20 && v <= 80 ? v : 58; }
function saveSplit(v) { try { localStorage.setItem(SPLIT_KEY, String(Math.round(v))); } catch {} }

// Persisted left tab-rail width (px), used when tab position is "left".
const RAILW_KEY = "synapse2.railw.v1";
function loadRailW() { const v = parseFloat(localStorage.getItem(RAILW_KEY)); return v >= 150 && v <= 340 ? v : 190; }
function saveRailW(v) { try { localStorage.setItem(RAILW_KEY, String(Math.round(v))); } catch {} }

// Pinned turns, per session id: { [sessionId]: [turnId, …] }.
const PINS_KEY = "synapse2.pins.v1";
function loadPins() { try { return JSON.parse(localStorage.getItem(PINS_KEY) || "{}") || {}; } catch { return {}; } }
// The sessions that were open, so the next launch can bring them back.
const OPEN_TABS_KEY = "synapse2.openTabs.v1";
function loadOpenTabs() {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || "null");
    const tabs = Array.isArray(v?.tabs) ? v.tabs.filter((t) => t && typeof t.sessionId === "string" && typeof t.cwd === "string").slice(0, 24) : [];
    return { tabs, active: typeof v?.active === "string" ? v.active : null };
  } catch { return { tabs: [], active: null }; }
}
function saveOpenTabs(v) { try { localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(v)); } catch {} }

// Projects pinned to the top of the left rail (normRoot keys).
const PINNED_PROJ_KEY = "synapse2.pinnedProjects.v1";
function loadPinnedProjects() { try { const v = JSON.parse(localStorage.getItem(PINNED_PROJ_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
function savePinnedProjects(v) { try { localStorage.setItem(PINNED_PROJ_KEY, JSON.stringify(v)); } catch {} }
function savePins(p) { try { localStorage.setItem(PINS_KEY, JSON.stringify(p)); } catch {} }

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
function LimitChip({ icon, label, win, who = "Claude" }) {
  if (!win || win.used_percentage == null) return null;
  const pct = Math.min(100, Math.round(win.used_percentage));
  const tier = pct >= 90 ? " red" : pct >= 70 ? " orange" : pct >= 50 ? " gold" : "";
  return (
    <div
      className={"usage-chip limit" + tier}
      title={`${who} ${label} window: ${win.used_percentage}% used\nResets ${new Date((win.resets_at || 0) * 1000).toLocaleString()}`}
    >
      <span className="limit-fill" style={{ width: pct + "%" }} />
      {icon} {label} {pct}%<span className="limit-reset"> · resets in {fmtReset(win.resets_at)}</span>
    </div>
  );
}

// Compact top-right update control. The download happens silently in Rust
// (see src-tauri/src/updater.rs); this button appears once a release is found
// and opens a popover with the release notes ("what's new") plus the install
// choice. Installing restarts the app, which ends every running claude
// session, so it is always the user's click, never automatic.
function UpdateChip() {
  const st = useUpdateStatus();
  const [open, setOpen] = useState(false);
  // Cumulative notes: every release between the running version and the
  // latest, fetched from the release feed when the modal opens. Falls back
  // to the downloaded release's own notes when offline.
  const [notesList, setNotesList] = useState(null);
  useEffect(() => {
    if (!open) return;
    invoke("get_release_notes_since")
      .then((l) => setNotesList(Array.isArray(l) && l.length > 0 ? l : null))
      .catch(() => setNotesList(null));
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (st.status !== "ready" && st.status !== "downloading" && st.status !== "installing") return null;
  const ready = st.status === "ready";
  return (
    <div className="update-wrap">
      <button
        className={"update-chip" + (ready ? " ready" : "")}
        onClick={() => ready && setOpen((v) => !v)}
        title={
          ready
            ? `HyperVoice Code ${st.version} is downloaded and ready — click for what's new`
            : st.status === "installing"
            ? `Installing HyperVoice Code ${st.version}…`
            : `Downloading HyperVoice Code ${st.version} in the background — ${st.progress}%`
        }
      >
        {ready ? "⬆ Update available" : st.status === "installing" ? "Installing…" : `⬆ ${st.progress}%`}
      </button>
      {open && ready && createPortal(
        // Portaled to <body>: the chip lives inside the topbar, whose
        // backdrop-filter (when a background is active) turns it into a
        // containing block that would trap and clip this "fixed" overlay.
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="update-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="update-modal-head">
              <span className="logo"><span className="logo-mark">◆</span> What's new</span>
              <button className="tab-x" onClick={() => setOpen(false)} title="Close (Esc)">✕</button>
            </div>
            <div className="update-modal-sub">
              Everything since the version you're on. The update is downloaded and verified — it installs only when you choose.
            </div>
            <div className="update-modal-notes md">
              {notesList ? (
                notesList.map((r) => (
                  <div key={r.version} className="update-rel">
                    <div className="update-rel-head">v{r.version}</div>
                    <Markdown>{r.notes || "_No notes for this release._"}</Markdown>
                  </div>
                ))
              ) : (
                <div className="update-rel">
                  <div className="update-rel-head">v{st.version}</div>
                  <Markdown>{st.notes || "_No release notes for this version._"}</Markdown>
                </div>
              )}
            </div>
            <div className="update-modal-btns">
              <button
                className="update-go"
                onClick={() => installUpdate().catch(() => {})}
                title="Installs and relaunches — finish any running Claude turn first: restarting closes every session"
              >
                Restart to update
              </button>
              <button
                className="update-later"
                onClick={() => { dismissUpdate(st.version); setOpen(false); }}
                title="Hide this version — the next release will offer again"
              >
                Skip this version
              </button>
              <button className="update-later" onClick={() => setOpen(false)}>Later</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// A project's colour shown as a small folder, not a dot: a coloured dot next
// to a name reads as a status light (red = something's wrong), and status is
// the tab icons' job.
function ProjMark({ color }) {
  return (
    <svg className="proj-mark" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 4.2c0-.8.6-1.4 1.4-1.4h3.3l1.5 1.6h5.4c.8 0 1.4.6 1.4 1.4v6.3c0 .8-.6 1.4-1.4 1.4H2.9c-.8 0-1.4-.6-1.4-1.4z" fill={color} />
    </svg>
  );
}

// ─── empty reader: the orb ─────────────────────────────────────────────────

// A new session with nothing to read yet. The orb lights up as you type or
// dictate into the terminal; once a prompt is sent it sweeps violet until the
// agent's first words arrive (this whole block is then replaced by the turn).
// A sent state with no reply for a while falls back to idle: an Enter can
// also be answering a terminal question, not sending a prompt.
function ReaderEmpty({ agent }) {
  const [sent, setSent] = useState(false);
  // Short windows get a smaller orb so the empty pane never needs a scrollbar.
  const [short, setShort] = useState(() => window.innerHeight < 700);
  useEffect(() => {
    const on = () => setShort(window.innerHeight < 700);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useEffect(() => {
    let timer = 0;
    const onInput = (e) => {
      if (!e.detail?.enter) return;
      setSent(true);
      clearTimeout(timer);
      timer = setTimeout(() => setSent(false), 20000);
    };
    window.addEventListener("hvc:input", onInput);
    return () => { window.removeEventListener("hvc:input", onInput); clearTimeout(timer); };
  }, []);
  return (
    <div className="reader-empty orb-empty">
      <Orb mode={sent ? "sent" : "idle"} size={short ? 150 : 240} />
      <div className="orb-words" role="status" aria-live="polite">
        {sent ? (
          <>
            <strong>Over to {agent}</strong>
            <span>The reply appears here as it comes in, formatted for reading.</span>
          </>
        ) : (
          <>
            <strong>Nothing to read yet</strong>
            <span>Type or say a prompt in the terminal. {agent}'s reply appears here, formatted for reading.</span>
          </>
        )}
      </div>
      <HvEmptyHint />
    </div>
  );
}

// ─── what's-new (post-update) + first-run welcome ───────────────────────────

const SEEN_VERSION_KEY = "synapse2.lastVersion";
const TOURED_KEY = "synapse2.toured.v1";

// Extract one version's section from CHANGELOG.md.
function changelogSection(version) {
  const start = changelogRaw.indexOf(`## [${version}]`);
  if (start === -1) return "";
  const rest = changelogRaw.slice(start);
  const next = rest.indexOf("\n## [", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

function WhatsNew({ version, onClose }) {
  const section = changelogSection(version);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!section) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="wn-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="wn-head">
          <span className="logo"><span className="logo-mark">◆</span> What's new in v{version}</span>
          <button className="tab-x" onClick={onClose}>✕</button>
        </div>
        <div className="wn-body md"><Markdown>{section.replace(/^## .*$/m, "")}</Markdown></div>
        <div className="wn-foot">
          <button className="sm-btn primary" onClick={onClose}>Nice — got it</button>
        </div>
      </div>
    </div>
  );
}

const TOUR = [
  {
    icon: "▶",
    title: "Sessions live in tabs",
    body: "Start a session in any folder, or press ⧉ to resume any Claude Code or Codex session on this machine — full history included. Drag tabs to reorder, double-click to rename.",
  },
  {
    icon: "❯",
    title: "Terminal + conversation, side by side",
    body: "The left pane is the real claude or codex CLI — type there as normal. The right pane lays the conversation out as collapsible turns: search it, expand tool calls and diffs, export it.",
  },
  {
    icon: "⌨",
    title: "Your left hand drives",
    body: "Ctrl+Shift+T new session · Ctrl+Shift+R resume · Ctrl+Shift+F search · Ctrl+Tab switch tabs. Press Ctrl+Shift+D anytime for the full list.",
  },
  {
    icon: "🎙",
    title: "Talk instead of typing",
    body: "Pair it with HyperVoice, our dictation app: press a hotkey, say your prompt, and it's typed into the terminal. Free to start at hypervoice.app.",
  },
];

function Welcome({ onDone }) {
  const [i, setI] = useState(0);
  const last = i === TOUR.length - 1;
  return (
    <div className="modal-backdrop">
      <div className="wn-modal welcome" role="dialog" aria-modal="true">
        <div className="tour-icon">{TOUR[i].icon}</div>
        <h3 className="tour-title">{TOUR[i].title}</h3>
        <p className="tour-body">{TOUR[i].body}</p>
        <div className="tour-dots">
          {TOUR.map((_, d) => <span key={d} className={"tour-dot" + (d === i ? " on" : "")} />)}
        </div>
        <div className="wn-foot">
          <button className="sm-btn ghost" onClick={onDone}>Skip</button>
          <button className="sm-btn primary" onClick={() => (last ? onDone() : setI(i + 1))}>
            {last ? "Get started" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  ["Ctrl+Shift+B", "Mission Control (dashboard)"],
  ["Ctrl+Shift+A", "Next session that needs you"],
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

function Launch({ onStart, recent = [], onOpenSettings, onOpenBrowser, onCancel, filters }) {
  const [folder, setFolder] = useState("");
  // Claude Code or Codex: starts on the Settings default (or the installed
  // one), re-checked every time this screen opens.
  const status = useAgentStatus();
  const [agentPick, setAgentPick] = useState(null);
  const agent = agentPick || defaultAgent(filters, status);
  const agentMissing = availability(status, agent) === "missing";
  const noneInstalled = !!status && ["claude", "codex"].every((k) => availability(status, k) === "missing");
  // Permission mode, per agent: starts on whichever was used last (else the
  // agent's own "ask" default). Skipping permissions is never the first-run default.
  const [modePick, setModePick] = useState({});
  const permMode = modePick[agent] || lastPermMode(filters, agent);
  const [worktrees, setWorktrees] = useState(false);
  const [error, setError] = useState("");
  const [orphans, setOrphans] = useState([]);   // leftover worktrees, each with what it still holds
  const [reviewOpen, setReviewOpen] = useState(false);
  const [picked, setPicked] = useState({});     // name -> bool
  const reviewLinkRef = useRef(null);
  const closeReview = () => { setReviewOpen(false); setTimeout(() => reviewLinkRef.current?.focus(), 0); };
  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeReview(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [reviewOpen]);
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e) => { if (e.key === "Escape" && !reviewOpen) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, reviewOpen]);
  // Old session worktrees left behind in the chosen folder → offer a review.
  function loadOrphans() {
    const f = folder.trim();
    if (!f) { setOrphans([]); return Promise.resolve([]); }
    return invoke("list_orphan_worktrees", { folder: f })
      .then((l) => { const list = Array.isArray(l) ? l : []; setOrphans(list); return list; })
      .catch(() => { setOrphans([]); return []; });
  }
  useEffect(() => {
    setOrphans([]);
    const id = setTimeout(loadOrphans, 350); // not on every keystroke
    return () => clearTimeout(id);
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
    if (noneInstalled) { setError("Neither Claude Code nor Codex is installed on this PC. Install one with its Get it ↗ link; this screen checks again each time it opens."); return; }
    if (agentMissing) { setError(`${AGENTS[agent].name} isn't installed on this PC. Install it (Get it ↗), or pick the other agent.`); return; }
    try { await onStart({ folder, permMode, worktrees, agent }); } catch (e) { setError(String(e)); }
  }
  // Open the review with only the provably-empty worktrees ticked. One that
  // still holds work has to be ticked by hand, with what it holds in view.
  async function openReview() {
    const list = await loadOrphans();
    setPicked(Object.fromEntries(list.map((w) => [w.name, !!w.safe])));
    setReviewOpen(true);
  }
  const pickedList = orphans.filter((w) => picked[w.name]);
  const pickedUnsafe = pickedList.filter((w) => !w.safe);
  async function cleanup() {
    try {
      const r = await invoke("cleanup_orphan_worktrees", {
        folder: folder.trim(),
        names: pickedList.map((w) => w.name),
        discardWork: pickedUnsafe.map((w) => w.name),
      });
      setReviewOpen(false);
      await loadOrphans();
      const removed = (r?.removed || []).length;
      const skipped = r?.skipped || [];
      setError(
        `Removed ${removed} old worktree${removed === 1 ? "" : "s"}.` +
          (skipped.length ? ` Left ${skipped.length} alone: ${skipped.map((x) => `${x.name} (${x.reason})`).join(", ")}.` : "")
      );
    } catch (e) { setError(String(e)); }
  }
  const holds = (w) => {
    if (w.safe) return "Empty — nothing to lose";
    const parts = [];
    if (w.changedFiles == null) parts.push("can't be read as a worktree");
    else if (w.changedFiles > 0) parts.push(`${w.changedFiles} unsaved file${w.changedFiles === 1 ? "" : "s"}`);
    if (w.unmergedCommits == null) parts.push("its branch can't be checked");
    else if (w.unmergedCommits > 0) parts.push(`${w.unmergedCommits} commit${w.unmergedCommits === 1 ? "" : "s"} not merged`);
    if (w.ignoredFiles > 0) parts.push(`${w.ignoredFiles} untracked-by-git item${w.ignoredFiles === 1 ? "" : "s"}${w.ignoredExample ? ` (e.g. ${w.ignoredExample})` : ""}`);
    return parts.join(" · ");
  };
  return (
    <div className="launch">
      <div className="launch-card">
        <div className="launch-head">
          <div className="logo"><span className="logo-mark">◆</span> {onCancel ? "New session" : "HyperVoice Code"}</div>
          <div className="launch-head-btns">
            {onOpenSettings && <button className="launch-gear" onClick={onOpenSettings} title="Settings">⚙</button>}
            {onCancel && <button className="launch-gear" onClick={onCancel} title="Cancel">✕</button>}
          </div>
        </div>
        <div className="tagline">Claude Code or Codex in a terminal, with the conversation laid out beside it.</div>
        <label id="launch-agent-label">Agent</label>
        <AgentCards value={agent} onChange={setAgentPick} status={status} labelledBy="launch-agent-label" />
        {noneInstalled && (
          <p className="launch-note">Neither is installed on this PC yet. Install one with its “Get it” link; this screen checks again each time it opens.</p>
        )}
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
        <label id="launch-perm-label">Permissions</label>
        <PermModePicker agent={agent} value={permMode} onChange={(k) => setModePick((m) => ({ ...m, [agent]: k }))} />
        <div className="toggles">
          <label><input type="checkbox" checked={worktrees} onChange={(e) => setWorktrees(e.target.checked)} /> Git worktree isolation (if the folder is a repo)</label>
        </div>
        {orphans.length > 0 && (
          <div className="orphan-row">
            {orphans.length} old session worktree{orphans.length === 1 ? "" : "s"} in this folder
            {orphans.some((w) => !w.safe) ? ` (${orphans.filter((w) => !w.safe).length} still holding work)` : ""} —{" "}
            <button ref={reviewLinkRef} className="link-like" onClick={openReview}>review</button>
          </div>
        )}
        <button className="start" onClick={go}>▶ Start session</button>
        <button className="resume-link" onClick={onOpenBrowser}>⧉ …or resume a previous session</button>
        {error && <div className="error" role="alert" title="Click to dismiss" onClick={() => setError("")}>{error} <span className="error-x" aria-hidden="true">✕</span></div>}
      </div>
      {reviewOpen && (
        <div className="modal-backdrop" onClick={closeReview}>
          <div className="confirm wt-review" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Old session worktrees">
            <div className="confirm-title">Old session worktrees</div>
            <div className="confirm-body">
              Each is a separate copy of this folder that a past session worked in. Removing one deletes that copy and its branch.
              Sessions open right now are not listed.
            </div>
            <div className="wt-list">
              {orphans.map((w) => (
                <label key={w.name} className={"wt-row" + (w.safe ? "" : " risky")}>
                  <input type="checkbox" checked={!!picked[w.name]} onChange={(e) => setPicked((p) => ({ ...p, [w.name]: e.target.checked }))} />
                  <span className="wt-name"><code>{w.branch}</code></span>
                  <span className="wt-holds">{holds(w)}</span>
                </label>
              ))}
              {orphans.length === 0 && <div className="wt-none">Nothing left to clean up.</div>}
            </div>
            {pickedUnsafe.length > 0 && (
              <div className="wt-warn">
                {pickedUnsafe.length === 1 ? "1 ticked worktree still holds work" : `${pickedUnsafe.length} ticked worktrees still hold work`} that
                exists nowhere else. Removing {pickedUnsafe.length === 1 ? "it" : "them"} deletes that work for good.
              </div>
            )}
            <div className="confirm-btns">
              <button className="btn-ghost" autoFocus onClick={closeReview}>Cancel</button>
              <button className={pickedUnsafe.length ? "confirm-danger" : "sm-btn"} disabled={pickedList.length === 0} onClick={cleanup}>
                {pickedUnsafe.length ? `Remove ${pickedList.length} and delete the work in ${pickedUnsafe.length}` : `Remove ${pickedList.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
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
  const [railW, setRailW] = useState(loadRailW());
  const [error, setError] = useState("");
  const [rateLimits, setRateLimits] = useState(null);
  const [searchQ, setSearchQ] = useState("");
  const [renamingTab, setRenamingTab] = useState(null); // tab id being renamed
  const [renameVal, setRenameVal] = useState("");
  const [ctxMenu, setCtxMenu] = useState(null); // {id, x, y} — tab context menu
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(false);   // Mission Control overlay
  const [dash, setDash] = useState(null);            // get_dashboard snapshot
  const [whatsNew, setWhatsNew] = useState(null); // version string when shown
  const [appVersion, setAppVersion] = useState("");
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  // "Which coding agent do you use?" — once, for new and existing users alike.
  const [agentSetupOpen, setAgentSetupOpen] = useState(() => !loadFilters().defaultAgent);
  const [agentOpen, setAgentOpen] = useState(null);   // {id, label} — subagent feed over the reader
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [pins, setPins] = useState(loadPins);         // sessionId -> [turnId]
  const termApi = useRef({});                         // tabId -> {send, focus} of its terminal
  const outlineBtnRef = useRef(null);
  const [pinnedProj, setPinnedProj] = useState(loadPinnedProjects);
  const feedSearchRef = useRef(null);

  // Post-update "what's new" (once per version) + first-run welcome tour.
  useEffect(() => {
    getVersion().then((v) => {
      setAppVersion(v);
      const seen = localStorage.getItem(SEEN_VERSION_KEY);
      if (!localStorage.getItem(TOURED_KEY)) {
        setWelcomeOpen(true);
      } else if (seen && seen !== v) {
        setWhatsNew(v);
      }
      localStorage.setItem(SEEN_VERSION_KEY, v);
    }).catch(() => {});
  }, []);
  function finishAgentSetup(v) {
    setFlag("defaultAgent", v === "codex" ? "codex" : "claude");
    setAgentSetupOpen(false);
  }
  function finishWelcome() {
    try { localStorage.setItem(TOURED_KEY, "1"); } catch {}
    setWelcomeOpen(false);
  }

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
    dashboard: () => setDashOpen((v) => !v),
    needsYou: () => jumpNeedsYou(),
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
      if (k === "b") return go(h.dashboard);
      if (k === "a") return go(h.needsYou);
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

  // Reopen last time's sessions on launch (Settings → Start-up). Each one is
  // resumed like a manual Resume (full history), in the permission mode it was
  // open in last time (sessions saved before modes existed reopen in "ask").
  const [restoreDone, setRestoreDone] = useState(false);
  const restoreStarted = useRef(false);
  const parkedTabs = useRef([]); // saved tabs whose agent isn't installed (kept for next launch)
  const hadMessages = useRef(new Set(loadOpenTabs().tabs.map((t) => t.sessionId)));
  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;
    (async () => {
      const saved = loadOpenTabs();
      if (filters.restoreTabs !== false) {
        const skipped = [];
        for (const t of saved.tabs) {
          const r = await resume({ sessionId: t.sessionId, cwd: t.cwd, agent: t.agent }, t.title || null, { quiet: true, permMode: t.permMode || "default" });
          if (r === "missing") skipped.push(t);
        }
        // Not reopened because their agent isn't installed: say so, and keep
        // them on the list so they come back once it is.
        parkedTabs.current = skipped;
        if (skipped.length) {
          const names = [...new Set(skipped.map((t) => AGENTS[t.agent === "codex" ? "codex" : "claude"].name))];
          const n = skipped.length;
          setError(`${n} session${n === 1 ? "" : "s"} from last time ${n === 1 ? "wasn't" : "weren't"} reopened because ${names.join(" and ")} ${names.length === 1 ? "isn't" : "aren't"} installed on this PC. ${n === 1 ? "It comes" : "They come"} back once ${names.length === 1 ? "it's" : "they're"} installed.`);
        }
        setTimeout(() => {
          const a = tabsRef.current.find((x) => x.sessionId === saved.active);
          if (a) setActiveId(a.id);
        }, 0);
      }
      setRestoreDone(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Remember what is open. A session with nothing said in it yet has no
  // conversation to come back to, so it is not remembered.
  useEffect(() => {
    if (!restoreDone) return;
    for (const t of tabs) if ((convos[t.id]?.messages?.length || 0) > 0) hadMessages.current.add(t.sessionId);
    saveOpenTabs({
      tabs: [
        ...tabs.filter((t) => t.sessionId && hadMessages.current.has(t.sessionId)).map((t) => ({ sessionId: t.sessionId, cwd: t.cwd, title: t.title || null, agent: agentOf(t), permMode: t.permMode || "default" })),
        ...parkedTabs.current.filter((p) => !tabs.some((t) => t.sessionId === p.sessionId)),
      ],
      active: tabs.find((t) => t.id === activeId)?.sessionId || null,
    });
  }, [tabs, activeId, convos, restoreDone]);

  // A new Codex tab starts under an id the app made up; when Codex creates the
  // session (on the first prompt) the backend switches to Codex's own id.
  // Follow it, so resume, restore, titles and pins use the id Codex knows.
  useEffect(() => {
    let un = null;
    let alive = true;
    listen("syn2:rekey", (e) => {
      const { from, to } = e.payload || {};
      // `to` goes into a command line on terminal restart: plain ids only.
      if (!from || !to || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(to)) return;
      const tab = tabsRef.current.find((t) => t.sessionId === from);
      if (tab?.title) saveTitle(to, tab.title);
      setTabs((ts) => ts.map((t) => {
        if (t.sessionId !== from) return t;
        return { ...t, sessionId: to, resumeCommand: `codex resume ${to}${t.permFlags || ""}` };
      }));
      setPins((p) => {
        if (!p[from]) return p;
        const n = { ...p, [to]: p[from] };
        delete n[from];
        savePins(n);
        return n;
      });
    }).then((u) => { if (alive) un = u; else u(); });
    return () => { alive = false; if (un) un(); };
  }, []);

  // Delta-fetch one tab's new messages (the backend tails the transcript and
  // caches parsed messages — this never re-reads or re-parses the file).
  async function fetchTab(t) {
    if (fetchingRef.current[t.id]) return;
    fetchingRef.current[t.id] = true;
    try {
      const since = (convosRef.current[t.id]?.messages || []).length;
      const r = await invoke("get_conversation", { sessionId: t.sessionId, since });
      // The tab may have been closed while this fetch was in flight (close +
      // remove is synchronous, but the awaited round-trip is not). Bail before
      // resurrecting any per-tab state — otherwise removeTab's cleanup is undone
      // and a stray "Claude finished" toast/timer fires for a dead session.
      if (!tabsRef.current.some((x) => x.id === t.id)) return;
      const delta = r?.messages || [];
      if (delta.length > 0) {
        setBusyById((b) => ({ ...b, [t.id]: true }));
        clearTimeout(busyTimers.current[t.id]);
        // Track activity that happened while the user was elsewhere; when the
        // stream goes quiet, that's "Claude finished" → toast (if enabled).
        const away = t.id !== activeIdRef.current || !document.hasFocus();
        if (away) bgWorkRef.current[t.id] = (bgWorkRef.current[t.id] || 0) + delta.length;
        busyTimers.current[t.id] = setTimeout(() => {
          setBusyById((b) => ({ ...b, [t.id]: false }));
          const steps = bgWorkRef.current[t.id] || 0;
          bgWorkRef.current[t.id] = 0;
          const stillAway = t.id !== activeIdRef.current || !document.hasFocus();
          if (steps > 0 && stillAway && filtersRef.current.notifyOnFinish) {
            const tab = tabsRef.current.find((x) => x.id === t.id);
            const name = tab ? tabDisplayName(tab) : "Session";
            toast(`◆ ${name}`, `${agentInfo(tab).short} finished — ${steps} new step${steps > 1 ? "s" : ""}.`);
          }
        }, 2500);
        // The first fetch is the session's history loading (app start, resume),
        // not something new: only later activity marks the tab as unseen.
        if (since > 0 && t.id !== activeIdRef.current) setNewById((n) => ({ ...n, [t.id]: true }));
      }
      setConvos((c) => {
        const prev = c[t.id] || { messages: [], ready: false, usage: null };
        // Two fetches close together can both start from the same count (the
        // first's result isn't rendered yet); keep only what's really new.
        const fresh = delta.slice(Math.max(0, prev.messages.length - since));
        const next = {
          messages: fresh.length ? [...prev.messages, ...fresh] : prev.messages,
          ready: !!r?.ready,
          usage: r?.usage || prev.usage,
        };
        return { ...c, [t.id]: next };
      });
    } catch (e) {
      setError(String(e));
    } finally {
      // Don't re-add a flag for a tab that was closed mid-fetch.
      if (tabsRef.current.some((x) => x.id === t.id)) fetchingRef.current[t.id] = false;
      else delete fetchingRef.current[t.id];
    }
  }
  // Keep a live view of convos for `since` computation without re-subscribing.
  const convosRef = useRef(convos);
  convosRef.current = convos;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const bgWorkRef = useRef({}); // tabId -> steps that arrived while away

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
    setAgentOpen(null);
    setOutlineOpen(false);
    if (activeId) setNewById((n) => (n[activeId] ? { ...n, [activeId]: false } : n));
  }, [activeId]);

  // Mission Control: poll the dashboard snapshot whenever sessions are open —
  // it also powers the live signals ON the tabs themselves (in-memory on the
  // backend, so 2s polling + change events is cheap).
  useEffect(() => {
    if (tabs.length === 0) return;
    let alive = true;
    let unlisten = null;
    const pull = () => invoke("get_dashboard").then((d) => alive && setDash(d)).catch(() => {});
    pull();
    listen("syn2:changed", pull).then((u) => (unlisten = u));
    const id = setInterval(pull, 2000);
    return () => { alive = false; clearInterval(id); if (unlisten) unlisten(); };
  }, [tabs.length > 0]);

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

  // Drag the rail divider to resize the left tab rail; persists across restarts.
  function startRailDrag(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = railW;
    let last = startW;
    const onMove = (ev) => {
      last = Math.max(150, Math.min(340, startW + (ev.clientX - startX)));
      setRailW(last);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      saveRailW(last);
      window.dispatchEvent(new Event("resize")); // let xterm re-fit
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function addTab(s, title) {
    tabCounter.current += 1;
    const id = "tab" + tabCounter.current;
    setTabs((ts) => {
      // Same-folder sessions get a stable " · N" suffix; the number never
      // shifts when an earlier sibling closes.
      const key = normRoot(s.root || s.cwd);
      const dupSeq =
        Math.max(0, ...ts.filter((x) => normRoot(x.root || x.cwd) === key).map((x) => x.dupSeq || 1)) + 1;
      return [...ts, {
        id,
        sessionId: s.sessionId,
        root: s.root,
        cwd: s.cwd,
        command: s.command,
        agent: s.agent === "codex" ? "codex" : "claude",
        // Set once a new Codex session's id is known: what to run if the
        // terminal is restarted (Claude's is derived from `command`).
        resumeCommand: null,
        permMode: s.permMode || "default",
        permFlags: s.permFlags || "",
        branch: s.branch,
        title: title || null,
        dupSeq,
        createdAt: Date.now(),
      }];
    });
    setActiveId(id);
    setNewOpen(false);
    setBrowserOpen(false);
    return id;
  }

  // Start a session → add a tab (never closes existing ones).
  // Heads-ups about one session (e.g. "another session is in this folder"),
  // keyed by tab id; shown as a dismissible card in that tab's conversation.
  const [notices, setNotices] = useState({});
  async function start(opts) {
    // A second non-worktree session in an already-occupied folder can stomp the
    // first one's edits — nudge toward isolation (after starting; not a block).
    const clash =
      !opts.worktrees &&
      tabsRef.current.some((t) => normRoot(t.root || t.cwd) === normRoot(opts.folder));
    const s = await invoke("start_session", { opts });
    setRecent(addRecentFolder(opts.folder));
    if (opts.agent) setFlag("lastAgent", opts.agent);
    rememberPermMode(s.agent, s.permMode);
    const tabId = addTab(s, null);
    // Isolation was requested but silently fell back to the real folder — warn.
    const note = s.worktreeError
      ? { kind: "error", title: "Not isolated", text: `The worktree couldn't be created (${s.worktreeError}), so this session works directly in the folder. Its edits are not sandboxed.` }
      : clash
      ? { kind: "warn", title: "Another session is in this folder", text: "Sessions working in the same folder can overwrite each other's edits. Choose the worktree option when you start a session to keep each one separate." }
      : null;
    setNotices((n) => {
      const next = { ...n };
      if (note) next[tabId] = note; else delete next[tabId];
      return next;
    });
  }

  // Resume an existing Claude Code session from the browser. Autonomy is OFF by
  // default — resuming to view/continue a session must not silently grant
  // --dangerously-skip-permissions.
  function rememberPermMode(agent, mode) {
    if (!mode) return;
    const a = agent === "codex" ? "codex" : "claude";
    setFilters((f) => {
      if (f.lastPermMode?.[a] === mode) return f;
      const n = { ...f, lastPermMode: { ...(f.lastPermMode || {}), [a]: mode } };
      saveFilters(n);
      return n;
    });
  }
  // `permMode`: what the user picked; null = this agent's last-used mode.
  // A restored tab passes the mode it was open in.
  async function resume(sessionMeta, title, { quiet = false, permMode = null } = {}) {
    // Already open? Go to that tab: two terminals on one session would fight
    // over the same transcript (and the same worktree).
    const open = tabsRef.current.find((t) => t.sessionId === sessionMeta.sessionId);
    if (open) { setActiveId(open.id); setBrowserOpen(false); setNewOpen(false); return "open"; }
    // The session's own tool must be on this PC, or the terminal would only
    // say "command not found". Checked fresh each time (a few file checks).
    const ag = sessionMeta.agent === "codex" ? "codex" : "claude";
    const st = await invoke("agent_status").catch(() => null);
    if (availability(st, ag) === "missing") {
      if (!quiet) setError(`${AGENTS[ag].name} isn't installed on this PC, so this ${AGENTS[ag].name} session can't be reopened. Install it (Settings → Workspace → Coding agent has the link), then resume it again.`);
      return "missing";
    }
    try {
      setError("");
      const s = await invoke("resume_session", {
        sessionId: sessionMeta.sessionId,
        cwd: sessionMeta.cwd || "",
        permMode: permMode || lastPermMode(filtersRef.current, ag),
        agent: ag,
      });
      if (!quiet) rememberPermMode(ag, s.permMode);
      if (sessionMeta.cwd) setRecent(addRecentFolder(sessionMeta.cwd));
      addTab(s, title || sessionMeta.title || null);
      return "ok";
    } catch (e) {
      setError(String(e));
      return "error";
    }
  }

  function removeTab(id) {
    // Cancel this tab's pending busy-timer and drop all per-id bookkeeping, so a
    // closed tab can't fire a stray "Claude finished" toast and the maps/refs
    // don't grow unbounded across open/close cycles.
    clearTimeout(busyTimers.current[id]);
    delete busyTimers.current[id];
    delete bgWorkRef.current[id];
    delete fetchingRef.current[id];
    delete termApi.current[id];
    const prune = (setter) =>
      setter((s) => { if (!(id in s)) return s; const n = { ...s }; delete n[id]; return n; });
    setConvos((c) => { const n = { ...c }; delete n[id]; return n; });
    prune(setExpandById);
    prune(setBusyById);
    prune(setNewById);
    prune(setShowAllTurns);
    // Functional updates from current state (not a stale closure) so a tab opened
    // concurrently with this close isn't dropped.
    const cur = tabsRef.current;
    const idx = cur.findIndex((t) => t.id === id);
    setTabs((ts) => ts.filter((t) => t.id !== id)); // unmounts TerminalPane → kills its PTY
    setActiveId((a) => {
      if (a !== id) return a;
      const next = cur.filter((t) => t.id !== id);
      const fb = next[idx] || next[idx - 1] || next[next.length - 1] || null;
      return fb ? fb.id : null;
    });
  }

  // Close = stop the tailer + (optionally) merge/delete the session worktree.
  async function confirmClose() {
    const t = tabs.find((x) => x.id === confirmCloseId);
    if (!t) { setConfirmCloseId(null); return; }
    const worktreeAction = !!t.branch && closeAction !== "keep";
    setClosing(true);
    try {
      // Kill the terminal / `claude` process FIRST (removeTab unmounts the pane,
      // which calls term_close) so the worktree directory isn't locked and no file
      // is mid-write when the backend merges/removes it.
      removeTab(t.id);
      setConfirmCloseId(null);
      if (worktreeAction) {
        await new Promise((r) => setTimeout(r, 250)); // let the PTY/handles release
      }
      await invoke("close_session", {
        sessionId: t.sessionId,
        root: t.branch ? t.root : null,
        worktreePath: t.branch ? t.cwd : null,
        branch: t.branch || null,
        action: t.branch ? closeAction : "keep",
      });
      setError("");
      setCloseAction("keep");
    } catch (e) {
      // e.g. merge conflict — the backend rolls the merge back and preserves the
      // work on the branch; surface the message so the user can resolve/resume.
      setError(String(e));
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

  // Left-rail layout: one group per project folder, pinned projects first,
  // each section and each group in the order of the tabs. While something is
  // being dragged, `drag` shows the order it would have if dropped now.
  function railLayout(ts, pinned, drag) {
    const by = new Map();
    for (const t of ts) {
      const key = normRoot(t.root || t.cwd);
      if (!by.has(key)) by.set(key, { key, root: t.root || t.cwd, pinned: pinned.includes(key), tabs: [] });
      by.get(key).tabs.push(t);
    }
    let pin = [...by.values()].filter((g) => g.pinned);
    let rest = [...by.values()].filter((g) => !g.pinned);
    if (drag?.kind === "group") {
      if (drag.scope === "groups:pinned") pin = moveTo(pin, drag.id, drag.index, (g) => g.key);
      else rest = moveTo(rest, drag.id, drag.index, (g) => g.key);
    }
    if (drag?.kind === "tab" && drag.scope !== "tabs:*") {
      const g = by.get(drag.scope.slice(5));
      if (g) g.tabs = moveTo(g.tabs, drag.id, drag.index, (t) => t.id);
    }
    return { pin, rest };
  }
  const flatOf = ({ pin, rest }) => [...pin, ...rest].flatMap((g) => g.tabs);
  // Dropped: make the tab order match what was shown.
  const sorter = useSortDrag((d) => {
    setTabs((ts) => (d.scope === "tabs:*" ? moveTo(ts, d.id, d.index, (t) => t.id) : flatOf(railLayout(ts, pinnedRef.current, d))));
  });
  const pinnedRef = useRef(pinnedProj);
  pinnedRef.current = pinnedProj;
  function togglePinProject(key) {
    const next = pinnedProj.includes(key) ? pinnedProj.filter((k) => k !== key) : [...pinnedProj, key];
    setPinnedProj(next);
    savePinnedProjects(next);
    setTabs((ts) => flatOf(railLayout(ts, next, null)));
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
  const tabPos = filters.tabPosition || "left";
  const rootClass = "root" + (bgMode !== "none" ? " bg-active" : "");
  const settingsModal = (
    <SettingsModal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      filters={filters}
      setFlag={setFlag}
      setCat={setCat}
      setAllCats={setAllCats}
      reset={resetFilters}
      initialTab={settingsTab}
      onShowWhatsNew={() => {
        setSettingsOpen(false);
        getVersion().then((v) => setWhatsNew(v)).catch(() => {});
      }}
    />
  );
  const browserModal = browserOpen && (
    <SessionBrowser onResume={(s, title, permMode) => resume(s, title, { permMode })} filters={filters} onClose={() => setBrowserOpen(false)} />
  );

  // NOTE: every hook below must run on EVERY render — including the no-tabs
  // launch screen — so they live ABOVE the early return (hooks after a
  // conditional return crash React with "rendered more hooks than before"
  // the moment the first tab appears).
  const activeTab = tabs.find((t) => t.id === activeId) || tabs[tabs.length - 1] || null;

  // A paste (Ctrl+V, or dictation from HyperVoice, which pastes into whatever
  // window is in front) that lands while no text field has the cursor would
  // otherwise vanish. Send it to the active session instead: into the prompt
  // composer when it's on, else into the terminal's input. Never presses Enter.
  // Pastes into a real field (terminal, composer, search, reply box) and
  // pastes while a dialog is open are left alone.
  const composerOn = !!filters.showComposer;
  const activeTabId = activeTab?.id;
  useEffect(() => {
    const isField = (el) =>
      !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
    const onPaste = (e) => {
      const el = document.activeElement;
      if (isField(el) || isField(e.target)) return;
      if (el?.closest?.('[role="dialog"], .modal-backdrop, .launch-overlay')) return;
      if (document.querySelector('.modal-backdrop, .launch-overlay')) return;
      const text = e.clipboardData?.getData("text/plain");
      const api = termApi.current[activeTabId];
      if (!text || !api || !api.alive()) return;
      e.preventDefault();
      if (composerOn && api.compose && api.compose(text)) return;
      api.paste(text);
      api.focus();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [activeTabId, composerOn]);

  // Zoom and text size, VS Code style (see textsize.js).
  const [zoomNote, setZoomNote] = useState(null);
  const zoomNoteTimer = useRef(0);
  const appZoom = filters.appZoom || 1;
  useEffect(() => { applyAppZoom(appZoom); }, [appZoom]);
  useEffect(() => {
    const show = (text) => {
      setZoomNote(text);
      clearTimeout(zoomNoteTimer.current);
      zoomNoteTimer.current = setTimeout(() => setZoomNote(null), 1200);
    };
    const bump = (spec, dir, label, fmt) => {
      setFilters((f) => {
        const v = dir === 0 ? spec.def : stepValue(spec, f[spec.key], dir);
        show(`${label} ${fmt(v)}`);
        if (v === f[spec.key]) return f;
        const n = { ...f, [spec.key]: v };
        saveFilters(n);
        return n;
      });
    };
    const app = (dir) => bump(APP_ZOOM, dir, "Zoom", pct);
    // A mouse notch is ~100; trackpads send many small deltas. One step per notch.
    let acc = 0;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (document.querySelector(".modal-backdrop, .launch-overlay")) return;
      acc += e.deltaY;
      if (Math.abs(acc) < 50) return;
      const dir = acc < 0 ? 1 : -1;
      acc = 0;
      // Ctrl+scroll zooms the whole window wherever the pointer is (Chris,
      // 2026-11-16). Per-pane sizes are set in Settings → Appearance.
      app(dir);
    };
    const onKey = (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      let dir = null;
      if (k === "=" || k === "+") dir = 1;
      else if (k === "-" || k === "_") dir = -1;
      else if (k === "0" && !e.shiftKey) dir = 0;
      if (dir === null) return;
      e.preventDefault();
      e.stopPropagation();
      app(dir);
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(zoomNoteTimer.current);
    };
  }, []);
  const confirmTab = tabs.find((t) => t.id === confirmCloseId) || null;
  const convo = (activeTab && convos[activeTab.id]) || {};
  const messages = convo.messages || [];
  const ready = convo.ready || false;
  const usage = convo.usage || null;
  const busy = !!(activeTab && busyById[activeTab.id]);
  const activeAgent = agentInfo(activeTab);
  const codexAwaitingFirst = agentOf(activeTab) === "codex" && !/^codex resume /.test(activeTab?.command || "");
  const startupStuck = !!activeTab && !ready && !codexAwaitingFirst && Date.now() - (activeTab.createdAt || 0) > 12000;

  const turns = useMemo(() => groupTurns(messages), [messages]);
  const detail = filters.detail || "answer";
  const [readerMenu, setReaderMenu] = useState(false);
  const activeSess = activeTab ? dash?.sessions?.[activeTab.sessionId] : null;
  // What each session's terminal is showing (a permission prompt, a running
  // step, or nothing we recognise). Read at most twice a second per tab.
  const screenCache = useRef({});
  const screenFor = (tabId) => {
    const hit = screenCache.current[tabId];
    const now = Date.now();
    if (hit && now - hit.t < 500) return hit.v;
    let v = null;
    try {
      const api = termApi.current[tabId];
      // 24 rows: Claude Code's working line can sit above its to-do list,
      // the input box and the status line.
      if (api && api.alive() && api.bottom) v = readScreen(api.bottom(24));
    } catch { v = null; }
    screenCache.current[tabId] = { t: now, v };
    return v;
  };
  const activeStatus = activeTab ? statusFor(activeSess?.stats, busy, ready, { fullAutonomy: sessionFullAutonomy(activeTab), screen: screenFor(activeTab.id), agent: agentOf(activeTab) }) : null;
  // Agents / background commands Claude launched that haven't reported back.
  const bgAll = useMemo(() => backgroundTasks(messages), [messages]);
  const bgRunning = useMemo(() => bgAll.filter((t) => !t.done), [bgAll]);
  const bgMap = useMemo(() => Object.fromEntries(bgAll.map((t) => [t.toolUseId, t])), [bgAll]);
  // What the reader may do in the active session. The object is stable (the
  // memoised turns never re-render for it); the live closures are swapped in
  // on every render through the ref.
  const actImpl = useRef({});
  const readerActions = useMemo(() => ({
    answer: (ask, i) => !!actImpl.current.answer?.(ask, i),
    type: (text) => !!actImpl.current.type?.(text),
    focusTerminal: () => actImpl.current.focusTerminal?.(),
    openAgent: (id, label) => actImpl.current.openAgent?.(id, label),
    togglePin: (t) => actImpl.current.togglePin?.(t),
  }), []);
  const pinList = (activeTab && pins[activeTab.sessionId]) || [];
  actImpl.current = {
    // Answer a single-choice question by pressing its number in the terminal.
    // A keypress goes to whatever is on screen, so first make sure that is
    // this question: it was asked after this terminal opened (not a leftover
    // from a resumed session), and the option, numbered as we expect, is on
    // the terminal's screen. Otherwise send nothing.
    answer: (ask, index) => {
      const api = termApi.current[activeTab?.id];
      const opt = ask?.questions?.[0]?.options?.[index];
      if (!api || !opt || !api.alive() || !(ask.at > api.openedAt)) return false;
      const squash = (s) => String(s).replace(/\s+/g, " ").trim();
      if (!squash(api.screen()).includes(`${index + 1}. ${squash(opt.label).slice(0, 24)}`)) return false;
      api.send(String(index + 1));
      return true;
    },
    // Put a reply in the terminal's input; you press Enter there to send it.
    type: (text) => {
      const api = termApi.current[activeTab?.id];
      if (!api || !api.alive()) return false;
      api.paste(text);
      return true;
    },
    focusTerminal: () => termApi.current[activeTab?.id]?.focus(),
    openAgent: (id, label) => setAgentOpen({ id, label: label || "" }),
    togglePin: (t) => {
      if (!activeTab) return;
      setPins((p) => {
        const cur = p[activeTab.sessionId] || [];
        const next = cur.includes(t.id) ? cur.filter((x) => x !== t.id) : [...cur, t.id];
        const all = { ...p, [activeTab.sessionId]: next };
        if (!next.length) delete all[activeTab.sessionId];
        savePins(all);
        return all;
      });
    },
  };
  const liveNow = busy || activeStatus?.key === "working";
  // Only a tool step names an activity ("Bash"); a prompt or reply's text is
  // not one (it showed your own prompt as "Working · <your prompt>").
  const liveActivity = ["toolcall", "toolresult", "error"].includes(activeSess?.stats?.lastKind)
    ? (activeSess?.stats?.lastActivity || "").split(" · ")[0].replace(/^⑂ /, "").slice(0, 60) || null
    : null;
  const latestId = turns.length ? turns[turns.length - 1].id : null;
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  // The answer to the last thing you asked stays open even when background-task
  // turns arrive after it; otherwise a finished background job folds away the
  // reply you were waiting for.
  const askedId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) if (!turns[i].isNotif) return turns[i].id;
    return null;
  }, [turns]);
  const openByDefault = (id) => id === latestId || id === askedId;
  const overrides = (activeTab && expandById[activeTab.id]) || {};

  // Auto-collapse-on-send: when a brand-new turn appears in the tab you're
  // looking at — i.e. you just sent a message — drop every manual expand/collapse
  // override for that tab so the feed snaps back to "only the latest turn open".
  // Tab switches and the first turns loading in never trigger it (we only fire
  // when the active tab's latest turn id changes within the SAME tab), and a
  // background-task notification doesn't count as something you sent. Off by
  // default, so the feed otherwise keeps your manual choices exactly as before.
  const prevLatestRef = useRef(null);
  const prevActiveRef = useRef(null);
  useEffect(() => {
    const tabId = activeTab?.id || null;
    const sameTab = prevActiveRef.current === tabId;
    const prevLatest = prevLatestRef.current;
    prevActiveRef.current = tabId;
    prevLatestRef.current = latestId;
    if (!sameTab || !tabId || !filters.autoCollapseOnSend) return;
    if (prevLatest && latestId && prevLatest !== latestId && !latestTurn?.isNotif) {
      setExpandById((s) => (s[tabId] ? { ...s, [tabId]: {} } : s));
    }
  }, [latestId, activeTab?.id, filters.autoCollapseOnSend]);

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

  // Paint search-match highlights over the rendered feed via the CSS Custom
  // Highlight API — no DOM mutation, so it works identically across markdown,
  // plain text and tool output. Re-runs whenever the feed's content changes.
  useEffect(() => {
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
    CSS.highlights.delete("syn-search");
    if (!searching || !feedRef.current) return;
    const ranges = [];
    const walker = document.createTreeWalker(feedRef.current, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest(".reader-empty") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let node;
    while ((node = walker.nextNode()) && ranges.length < 2000) {
      const text = node.nodeValue || "";
      const lower = text.toLowerCase();
      let i = lower.indexOf(q);
      while (i !== -1 && ranges.length < 2000) {
        const r = new Range();
        r.setStart(node, i);
        r.setEnd(node, i + q.length);
        ranges.push(r);
        i = lower.indexOf(q, i + q.length);
      }
    }
    if (ranges.length) CSS.highlights.set("syn-search", new Highlight(...ranges));
    return () => CSS.highlights.delete("syn-search");
  }, [q, searching, messages, expandById, activeId, showAllTurns]);

  // Auto-follow: stick to the bottom of the feed unless the user scrolled up.
  const feedRef = useRef(null);
  const stickRef = useRef(true);
  const [unstuck, setUnstuck] = useState(false);
  // NOTE: this reset MUST be declared before the auto-follow effect below.
  // React runs effect setups in declaration order, so on a tab change the reset
  // (stickRef=true) runs first, leaving the follow effect free to scroll the new
  // tab to its live end. If it ran after, a previously scrolled-up tab would
  // leave stickRef=false and the new tab would render parked mid-feed.
  useEffect(() => {
    // Switching tabs re-follows the live end.
    stickRef.current = true;
    setUnstuck(false);
    setHeldNew(false);
  }, [activeId]);
  // Auto-follow the live end, with one exception: when a background task
  // reports back after Claude has answered you, Claude's reply to it starts a
  // second answer below yours. Following that would scroll your answer off the
  // top, so it looks as if nothing came before. Instead stop where you are
  // (your answer stays put) and show a "New reply below" button; you scroll
  // down yourself. Sending your next message follows the live end again.
  const followRef = useRef({ tab: null, id: null });
  const [heldNew, setHeldNew] = useState(false);
  useEffect(() => {
    const prev = followRef.current;
    followRef.current = { tab: activeId, id: latestId };
    const newTurn = prev.tab === activeId && !!prev.id && !!latestId && prev.id !== latestId;
    if (newTurn && latestTurn?.isNotif && stickRef.current && askedId && askedId !== latestId) {
      stickRef.current = false;
      setUnstuck(true);
      setHeldNew(true);
      return;
    }
    if (newTurn && !latestTurn?.isNotif && heldNew) {
      stickRef.current = true;
      setUnstuck(false);
      setHeldNew(false);
    }
    if (stickRef.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages.length, activeId]);
  function onFeedScroll() {
    const el = feedRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = atBottom;
    setUnstuck(!atBottom);
    if (atBottom) setHeldNew(false);
  }
  // Open the turn that launched a background task and scroll to it.
  function jumpToStep(toolUseId) {
    const t = turns.find((x) => x.responses.some((m) => m.toolUseId === toolUseId));
    if (!t || !activeTab) return;
    setExpandById((s) => ({ ...s, [activeTab.id]: { ...(s[activeTab.id] || {}), [t.id]: true } }));
    setTimeout(() => {
      const el = feedRef.current?.querySelector(`[data-turn="${CSS.escape(t.id)}"]`);
      if (el && feedRef.current) feedRef.current.scrollTop = el.offsetTop - feedRef.current.offsetTop - 8;
    }, 50);
  }
  // Open any turn and bring it to the top of the reader (outline, pins).
  function jumpToTurn(turnId) {
    if (!activeTab) return;
    const idx = turns.findIndex((x) => x.id === turnId);
    if (idx < 0) return;
    if (searchQ) setSearchQ("");
    if (turns.length - idx > TURN_CAP) setShowAllTurns((s) => ({ ...s, [activeTab.id]: true }));
    setExpandById((s) => ({ ...s, [activeTab.id]: { ...(s[activeTab.id] || {}), [turnId]: true } }));
    stickRef.current = false;
    setTimeout(() => {
      const el = feedRef.current?.querySelector(`[data-turn="${CSS.escape(turnId)}"]`);
      if (el && feedRef.current) { feedRef.current.scrollTop = el.offsetTop - feedRef.current.offsetTop - 8; setUnstuck(true); }
    }, 60);
  }
  function jumpToLatest() {
    stickRef.current = true;
    setUnstuck(false);
    setHeldNew(false);
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }

  // Focus-scoped feed navigation: after clicking a turn card, ↑/↓ move between
  // cards, Enter/Space toggles (native button behavior), Esc collapses. These
  // only fire when a card has focus, so they can never collide with typing in
  // the terminal or an input.
  function onFeedKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const heads = Array.from(feedRef.current?.querySelectorAll(".turn-toggle") || []);
      if (!heads.length) return;
      const i = heads.indexOf(document.activeElement);
      const next = heads[Math.max(0, Math.min(heads.length - 1, (i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1))))];
      if (next) {
        e.preventDefault();
        next.focus();
        next.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Escape") {
      const openCard = document.activeElement?.closest?.(".turn.open");
      const head = openCard?.querySelector(".turn-toggle");
      if (head) {
        e.preventDefault();
        const id = openCard.dataset.turn;
        head.click(); // collapse, then keep focus on the (re-rendered) row
        setTimeout(() => feedRef.current?.querySelector(`[data-turn="${CSS.escape(id)}"] .turn-toggle`)?.focus(), 30);
      }
    }
  }

  // No sessions yet → full-screen launch.
  if (tabs.length === 0 || !activeTab) {
    return (
      <div className={rootClass}>
        <Background mode={bgMode} color={bgColor} speed={filters.warpSpeed} light={effTheme === "light"} />
        <div className="update-float"><UpdateChip /></div>
        <Launch onStart={start} recent={recentList} filters={filters} onOpenSettings={() => openSettings("appearance")} onOpenBrowser={() => setBrowserOpen(true)} />
        {browserModal}
        {settingsModal}
        {hotkeysOpen && <HotkeySheet onClose={() => setHotkeysOpen(false)} />}
        {agentSetupOpen ? <AgentSetup filters={filters} onDone={finishAgentSetup} /> : welcomeOpen && <Welcome onDone={finishWelcome} />}
        {!welcomeOpen && !agentSetupOpen && whatsNew && <WhatsNew version={whatsNew} onClose={() => setWhatsNew(null)} />}
      </div>
    );
  }

  async function exportConversation(format) {
    try {
      const base = (tabDisplayName(activeTab) || "session").replace(/[^\w.-]+/g, "-");
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
        const lines = [`# ${activeAgent.name} session — ${activeTab.cwd}`, ""];
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

  // Is the agent launched by this tool call still going? Background agents end
  // with a notification; ordinary ones end when their tool call gets a result.
  function agentRunning(toolUseId) {
    const bg = bgMap[toolUseId];
    if (bg) return !bg.done;
    return !messages.some((m) => m.toolUseId === toolUseId && (m.kind === "toolresult" || m.kind === "error"));
  }
  const ctxTokens = activeSess?.stats?.contextTokens || 0;
  const ctxWin = ctxWindowFor(activeSess?.stats?.lastModel, ctxTokens, activeSess?.stats?.contextWindow);
  // Usage-limit chips follow the active tab's agent: Claude's come from its
  // status-line hook, Codex's from its own session file.
  const onCodex = agentOf(activeTab) === "codex";
  const codexWin = (w) => (w && w.used_percent != null ? { used_percentage: w.used_percent, resets_at: w.resets_at } : null);
  const limitFive = onCodex ? codexWin(activeSess?.stats?.rateLimits?.primary) : rateLimits?.rateLimits?.five_hour;
  const limitWeek = onCodex ? codexWin(activeSess?.stats?.rateLimits?.secondary) : rateLimits?.rateLimits?.seven_day;
  // Mark tabs whose agent isn't the usual one (or every tab, when the
  // default is "last used" and both kinds are open).
  const basePref = filters.defaultAgent === "codex" ? "codex" : filters.defaultAgent === "last" ? null : "claude";
  const mixedAgents = new Set(tabs.map(agentOf)).size > 1;
  const showAgentPill = (t) => (basePref ? agentOf(t) !== basePref : mixedAgents);
  const ctxPct = ctxTokens ? Math.min(100, Math.round((ctxTokens / ctxWin) * 100)) : 0;

  // One status per tab, from the same statusFor that drives Mission Control —
  // so the tab dots, the fleet chip and the dashboard can never disagree.
  function tabStatus(t) {
    const sess = dash?.sessions?.[t.sessionId];
    const bgCount = backgroundTasks(convos[t.id]?.messages || []).filter((x) => !x.done).length;
    return statusFor(sess?.stats, !!busyById[t.id], sess?.ready, { fullAutonomy: sessionFullAutonomy(t), background: bgCount, screen: screenFor(t.id), agent: agentOf(t) });
  }
  // Go to the next session that is waiting on you (wraps around).
  function jumpNeedsYou() {
    const need = tabs.filter((t) => tabStatus(t).key === "attention");
    if (!need.length) return;
    const i = need.findIndex((t) => t.id === activeTab?.id);
    setActiveId(need[(i + 1) % need.length].id);
  }
  function tabAttention(id) {
    const t = tabs.find((x) => x.id === id);
    return !!t && tabStatus(t).key === "attention";
  }

  // Fleet aggregates for the top-bar chip: how many sessions are running,
  // streaming, waiting on the human, and how many subagents are live.
  const fleetWorking = tabs.filter((t) => tabStatus(t).key === "working").length;
  const fleetNeeds = tabs.filter((t) => tabStatus(t).key === "attention").length;
  const fleetAgents = tabs.reduce(
    (a, t) => a + ((dash?.sessions?.[t.sessionId]?.stats?.agents || []).filter((x) => !x.done).length),
    0
  );

  // One tab chip. In the grouped left rail the folder name lives on the group
  // header, so the tab itself shows only its distinguishing bit.
  const renderTab = (t, grouped) => {
    const name = grouped ? t.title || `session ${t.dupSeq || 1}` : tabDisplayName(t);
    const scope = grouped ? "tabs:" + normRoot(t.root || t.cwd) : "tabs:*";
    // Always-on status indicator (same derivation as Mission Control).
    const sess = dash?.sessions?.[t.sessionId];
    const st = tabStatus(t);
    const isNew = st.key === "idle" && t.id !== activeTab.id && !!newById[t.id];
    const word = tabWord(st, {
      lastKind: sess?.stats?.lastKind,
      lastActivity: sess?.stats?.lastActivity,
      agentsRunning: (sess?.stats?.agents || []).filter((a) => !a.done).length,
    });
    return (
          <div
            key={t.id}
            className={"tab" + (t.id === activeTab.id ? " active" : "") + (st.key === "attention" ? " needs" : "") + (isNew ? " fresh" : "") + (sorter.drag?.kind === "tab" && sorter.drag.id === t.id ? " sort-dragging" : "")}
            onClick={() => setActiveId(t.id)}
            title={t.cwd + " · " + agentInfo(t).name + " · double-click to rename, drag to reorder"}
            data-sort-scope={scope}
            data-sort-id={t.id}
            onPointerDown={(e) => renamingTab !== t.id && sorter.begin(e, { kind: "tab", scope, id: t.id, axis: grouped ? "y" : "x" })}
            onDoubleClick={() => { setRenamingTab(t.id); setRenameVal(t.title || name); }}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: t.id, x: e.clientX, y: e.clientY }); }}
          >
            <span className="tab-proj" style={{ background: projectColor(t.root || t.cwd) }} title={t.root || t.cwd} />
            <StatusGlyph
              kind={glyphKind(st, { lastKind: sess?.stats?.lastKind, isNew })}
              size={14}
              className="tab-glyph"
              title={isNew ? "Finished while you were on another tab" : `${st.label.charAt(0).toUpperCase() + st.label.slice(1)}: ${st.hint}`}
            />
            {renamingTab === t.id ? (
              <form className="tab-rename" onSubmit={(e) => { e.preventDefault(); commitTabRename(t); }}>
                <input
                  autoFocus
                  onFocus={(e) => e.target.select()}
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
            {showAgentPill(t) && renamingTab !== t.id && (
              <span className="tab-agent" title={`${agentInfo(t).name} session`}>{agentInfo(t).short}</span>
            )}
            {word && renamingTab !== t.id && (
              <span className={"tab-word" + (st.key === "attention" ? " needs" : "")} title={st.hint}>{word}</span>
            )}
            <button className="tab-x" onClick={(e) => { e.stopPropagation(); setCloseAction("keep"); setConfirmCloseId(t.id); }} title="Close session">✕</button>
          </div>
        );
  };

  // Left rail groups tabs under one header per project folder (pinned ones
  // first); the top bar stays flat (horizontal space is too tight for headers).
  const rail = railLayout(tabs, pinnedProj, sorter.drag);
  const topTabs = sorter.drag?.scope === "tabs:*" ? moveTo(tabs, sorter.drag.id, sorter.drag.index, (t) => t.id) : tabs;
  const renderGroup = (g) => (
    <div
      key={g.key}
      className={"tabgroup" + (g.pinned ? " pinned" : "") + (sorter.drag?.kind === "group" && sorter.drag.id === g.key ? " sort-dragging" : "")}
      data-sort-scope={g.pinned ? "groups:pinned" : "groups:rest"}
      data-sort-id={g.key}
    >
      <div
        className="tabgroup-head"
        title={g.root + " · drag to reorder projects"}
        onPointerDown={(e) => sorter.begin(e, { kind: "group", scope: g.pinned ? "groups:pinned" : "groups:rest", id: g.key, axis: "y" })}
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ group: g.key, x: e.clientX, y: e.clientY }); }}
      >
        <ProjMark color={projectColor(g.root)} />
        <span className="tabgroup-name">{baseNameOf(g.root)}</span>
        {g.tabs.length > 1 && <span className="tabgroup-count">{g.tabs.length}</span>}
        <button
          className={"tabgroup-pin" + (g.pinned ? " on" : "")}
          onClick={() => togglePinProject(g.key)}
          title={g.pinned ? "Unpin this project" : "Pin this project to the top"}
          aria-label={g.pinned ? `Unpin ${baseNameOf(g.root)}` : `Pin ${baseNameOf(g.root)} to the top`}
          aria-pressed={g.pinned}
        >📌</button>
      </div>
      {g.tabs.map((t) => renderTab(t, true))}
    </div>
  );

  const tabBar = (
    <div className={"tabbar " + tabPos} style={tabPos === "left" ? { width: railW } : undefined}>
      {/* Left rail: New / Resume stay pinned on top, only the tabs scroll, and
          the HyperVoice card stays pinned below. */}
      {tabPos === "left" && (
        <div className="rail-actions">
          <button className="rail-btn" onClick={() => setNewOpen(true)} title="Start a new session (Ctrl+Shift+T)">＋ New</button>
          <button className="rail-btn" onClick={() => setBrowserOpen(true)} title="Resume a previous session (Ctrl+Shift+R)">⧉ Resume</button>
        </div>
      )}
      <div className={tabPos === "left" ? "tabbar-scroll" : "tabbar-flow"}>
      {tabPos === "left" ? (
        <>
          {rail.pin.length > 0 && <div className="rail-section">Pinned</div>}
          {rail.pin.map(renderGroup)}
          {rail.pin.length > 0 && rail.rest.length > 0 && <div className="rail-section">Projects</div>}
          {rail.rest.map(renderGroup)}
        </>
      ) : (
        <>
          {topTabs.map((t) => renderTab(t, false))}
          <button className="tab-new" onClick={() => setNewOpen(true)} title="New session">＋</button>
          <button className="tab-new" onClick={() => setBrowserOpen(true)} title="Resume a previous session">⧉</button>
        </>
      )}
      </div>
      {tabPos === "left" && <HvPromoRail />}
    </div>
  );

  return (
    <AgentName.Provider value={activeAgent.short}>
    <div className={rootClass}>
      <div className="zoom-note" role="status" aria-live="polite">{zoomNote || ""}</div>
      <Background mode={bgMode} color={bgColor} speed={filters.warpSpeed} light={effTheme === "light"} />
      <div className="app">
        <header className="topbar">
          <div className="logo">
            <span className="logo-mark">◆</span> HyperVoice Code
            {appVersion && (
              <button className="logo-ver" onClick={() => setWhatsNew(appVersion)} title="What's new in this version">
                v{appVersion}
              </button>
            )}
          </div>
          <LimitChip icon="⏱" label="session" win={limitFive} who={activeAgent.short} />
          <LimitChip icon="📅" label="week" win={limitWeek} who={activeAgent.short} />
          <button
            className="usage-chip fleet-chip"
            onClick={() => setDashOpen(true)}
            title={`Fleet: ${tabs.length} session(s) · ${fleetWorking} working · ${fleetNeeds} needing you · ${fleetAgents} subagent(s) live\nClick for Mission Control (Ctrl+Shift+B)`}
          >
            <span className="fleet-seg">▦ {tabs.length}</span>
            <span className={"fleet-seg" + (fleetWorking ? " ok" : " dim")}><StatusGlyph kind={fleetWorking ? "working" : "idle"} size={11} />{fleetWorking} working</span>
            <span className={"fleet-seg" + (fleetNeeds ? " warn" : " dim")}><StatusGlyph kind={fleetNeeds ? "approve" : "idle"} size={11} />{fleetNeeds} need you</span>
            <span className={"fleet-seg" + (fleetAgents ? " ok" : " dim")}>⑂ {fleetAgents} {fleetAgents === 1 ? "subagent" : "subagents"}</span>
          </button>
          {tabs.some((t) => t.id !== activeTab.id && tabStatus(t).key === "attention") && (
            <button className="usage-chip needs-btn" onClick={jumpNeedsYou} title="Go to the next session that needs you (Ctrl+Shift+A)">
              Next waiting →
            </button>
          )}
          <span className="topbar-spacer" />
          <UpdateChip />
          {tabPos === "top" && <HvPromoChip />}
          <button className="filters-btn hk-btn" onClick={() => setHotkeysOpen(true)} title="Keyboard shortcuts (Ctrl+Shift+D)">⌨</button>
          <button className="filters-btn" onClick={() => openSettings("appearance")} title="Settings">⚙ Settings</button>
        </header>
        {tabPos === "top" && tabBar}
        <div className="app-row">
          {tabPos === "left" && (
            <>
              {tabBar}
              <div className="rail-divider" onMouseDown={startRailDrag} title="Drag to resize" />
            </>
          )}
          <div className="cols" ref={colsRef} style={{ gridTemplateColumns: `${split}% 6px minmax(0, 1fr)` }}>
            <section className="term-col">
              {tabs.map((t) => (
                <div key={t.id} className="term-host" style={{ display: t.id === activeTab.id ? "block" : "none" }}>
                  <TerminalPane cwd={t.cwd} command={t.command} resumeCommand={t.resumeCommand} composer={!!filters.showComposer} fontSize={filters.termFontSize || TERM_FONT.def} onApi={(api) => { if (api) termApi.current[t.id] = api; else delete termApi.current[t.id]; }} />
                </div>
              ))}
            </section>
            <div className="divider" onMouseDown={startDrag} title="Drag to resize" />
            <section className="convo-col" style={{ "--reader-scale": filters.readerZoom || 1 }} data-accents={filters.readingAccents === false ? "off" : "on"}>
              <div className="reader-head" inert={agentOpen ? "" : undefined}>
                <span className="reader-title">
                  Conversation
                  {turns.length > 0 && <span className="reader-count">{turns.length}</span>}
                </span>
                <div className="reader-search">
                  <Icon name="search" size={13} />
                  <input
                    ref={feedSearchRef}
                    type="text"
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    placeholder="Search"
                    aria-label="Search conversation"
                    title="Search this session (Ctrl+Shift+F)"
                  />
                  {searchQ && <button className="clear" onClick={() => setSearchQ("")} title="Clear search" aria-label="Clear search">✕</button>}
                </div>
                {searching && <span className="search-meta">{visibleTurns.length} of {turns.length}</span>}
                <span className="spacer" />
                <div className="reader-menu outline-anchor">
                  <button
                    ref={outlineBtnRef}
                    className={"icon-btn" + (pinList.length ? " has-pins" : "")}
                    onClick={() => setOutlineOpen((v) => !v)}
                    title="Jump to a prompt, or to a pinned turn"
                    aria-label="Outline of prompts"
                    aria-haspopup="menu"
                    aria-expanded={outlineOpen}
                  ><Icon name="list" size={14} /></button>
                  {outlineOpen && <Outline turns={turns} pins={pinList} onJump={jumpToTurn} onClose={() => { setOutlineOpen(false); outlineBtnRef.current?.focus(); }} />}
                </div>
                <DetailSwitch value={detail} onChange={(v) => setFlag("detail", v)} />
                <div className="reader-menu">
                  <button
                    className="icon-btn"
                    onClick={() => setReaderMenu((v) => !v)}
                    title="More"
                    aria-label="More"
                    aria-haspopup="menu"
                    aria-expanded={readerMenu}
                  >⋯</button>
                  {readerMenu && (
                    <>
                      <div className="ctx-overlay" onClick={() => setReaderMenu(false)} />
                      <div
                        className="menu-pop"
                        role="menu"
                        onClick={() => setReaderMenu(false)}
                        onKeyDown={(e) => {
                          const items = [...e.currentTarget.querySelectorAll("button")];
                          const i = items.indexOf(document.activeElement);
                          if (e.key === "Escape") { e.preventDefault(); setReaderMenu(false); e.currentTarget.parentElement.querySelector(".icon-btn")?.focus(); }
                          else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                            e.preventDefault();
                            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                          }
                        }}
                        ref={(el) => el && !el.contains(document.activeElement) && el.querySelector("button")?.focus()}
                      >
                        <button role="menuitem" onClick={() => setExpandById((s) => ({ ...s, [activeTab.id]: Object.fromEntries(visibleTurns.map((t) => [t.id, true])) }))}>Expand all turns</button>
                        <button role="menuitem" onClick={() => setExpandById((s) => ({ ...s, [activeTab.id]: Object.fromEntries(visibleTurns.map((t) => [t.id, false])) }))}>Collapse all turns</button>
                        <button role="menuitem" onClick={() => exportConversation("md")}>Export as Markdown <span className="hint">Ctrl+Shift+E</span></button>
                        <button role="menuitem" onClick={() => exportConversation("json")}>Export as JSON</button>
                      </div>
                    </>
                  )}
                </div>
              </div>
              {startupStuck && (
                <div className="warn-banner">
                  No transcript yet — {activeAgent.short} may not have started in the terminal. Check it for errors (or just press Enter there).
                </div>
              )}
              {(() => {
                // Another session is waiting on you: say so here, so it isn't
                // missed while you read this one.
                const waiting = tabs.filter((x) => x.id !== activeTab.id && tabStatus(x).key === "attention");
                if (!waiting.length) return null;
                const first = waiting[0];
                const fst = tabStatus(first);
                const what = fst.label === "asked you" ? "has a question for you" : fst.label === "needs approval" ? "is waiting for your approval" : "may be waiting for you";
                return (
                  <div className="needs-bar" role="status">
                    <StatusGlyph kind={glyphKind(fst, { lastKind: dash?.sessions?.[first.sessionId]?.stats?.lastKind })} size={14} />
                    <span className="needs-text"><b>{tabDisplayName(first)}</b> {what}{waiting.length > 1 ? ` (and ${waiting.length - 1} more)` : ""}</span>
                    <button className="needs-go" onClick={() => setActiveId(first.id)}>Go to it</button>
                  </div>
                );
              })()}
              <AgentName.Provider value={activeAgent.short}>
              <ReaderActions.Provider value={readerActions}>
              <div className="feed-uni" ref={feedRef} onScroll={onFeedScroll} onKeyDown={onFeedKey} inert={agentOpen ? "" : undefined}>
                {turns.length === 0 && (
                  <ReaderEmpty key={activeTab.id} agent={activeAgent.short} />
                )}
                {!allTurnsShown && !searching && turns.length > TURN_CAP && (
                  <button
                    className="show-earlier"
                    onClick={() => setShowAllTurns((s) => ({ ...s, [activeTab.id]: true }))}
                  >
                    Show {turns.length - TURN_CAP} earlier turns
                  </button>
                )}
                {searching && visibleTurns.length === 0 && (
                  <div className="reader-empty"><span>No turns mention “{searchQ.trim()}”.</span></div>
                )}
                {visibleTurns.map((t) => (
                  <Turn
                    key={t.id}
                    t={t}
                    root={activeTab.cwd}
                    bgMap={bgMap}
                    expanded={searching ? !!overrides[t.id] : overrides[t.id] ?? openByDefault(t.id)}
                    live={t.id === latestId && liveNow}
                    latest={t.id === latestId}
                    waiting={t.id === latestId && (activeStatus?.label === "waiting?" || activeStatus?.label === "needs approval")}
                    waitingSure={activeStatus?.label === "needs approval"}
                    pinned={pinList.includes(t.id)}
                    activity={t.id === latestId ? liveActivity : null}
                    detail={detail}
                    matchCount={searching ? searchMatches[t.id] : 0}
                    filters={filters}
                    catById={catById}
                    onToggle={(id) => toggleTurn(id, searching ? !!overrides[id] : overrides[id] ?? openByDefault(id))}
                  />
                ))}
              </div>
              </ReaderActions.Provider>
              </AgentName.Provider>
              <div className="sr-only" role="status" aria-live="polite">
                {turns.length ? (liveNow ? `${activeAgent.short} is working` : bgRunning.length ? "Background work running" : `${activeAgent.short} is idle`) : ""}
              </div>
              <BackgroundStrip
                tasks={bgRunning}
                onJump={(id) => (bgMap[id]?.kind === "agent" ? setAgentOpen({ id, label: bgMap[id].label }) : jumpToStep(id))}
              />
              {agentOpen && (
                <AgentPanel
                  key={agentOpen.id}
                  sessionId={activeTab.sessionId}
                  toolUseId={agentOpen.id}
                  label={agentOpen.label}
                  running={agentRunning(agentOpen.id)}
                  onClose={() => setAgentOpen(null)}
                >
                  {({ turns: agentTurns, live }) => (
                    <AgentFeed turns={agentTurns} live={live} detail={detail === "answer" ? "steps" : detail} filters={filters} root={activeTab.cwd} />
                  )}
                </AgentPanel>
              )}
              <span className="sr-only" role="status" aria-live="polite">{heldNew ? "New reply below" : ""}</span>
              {unstuck && (
                <button className={"jump-bottom" + (heldNew ? " new" : "")} onClick={jumpToLatest} title={heldNew ? "Jump to the new reply" : "Follow the latest activity"}>
                  <Icon name="chevron" size={12} /> {heldNew ? "New reply below" : "Latest"}
                </button>
              )}
              {(() => {
                // One card at the bottom of the conversation. A heads-up steps
                // aside while the background-work strip is showing (they'd sit
                // on top of each other) and comes back when it goes; an error
                // stays, lifted above the strip.
                const note = notices[activeTab.id];
                const strip = bgRunning.length > 0;
                const card = error
                  ? { kind: "error", title: "Something went wrong", text: error, close: () => setError("") }
                  : note && !(strip && note.kind === "warn")
                  ? { ...note, close: () => setNotices((n) => { const x = { ...n }; delete x[activeTab.id]; return x; }) }
                  : null;
                if (!card) return null;
                return (
                  <div className={"notice-card " + card.kind + (strip ? " lifted" : "")} role={card.kind === "error" ? "alert" : "status"}>
                    <span className="notice-ico" aria-hidden="true">{card.kind === "error" ? "!" : "i"}</span>
                    <div className="notice-body"><b>{card.title}</b><span>{card.text}</span></div>
                    <button className="notice-x" onClick={card.close} title="Dismiss" aria-label="Dismiss">✕</button>
                  </div>
                );
              })()}
            </section>
          </div>
        </div>
        <footer className="statusbar" aria-label="Session status">
          {(() => {
            const st = tabStatus(activeTab);
            const label = busy ? "Working" : st.label.charAt(0).toUpperCase() + st.label.slice(1);
            return (
              <span className={"sb-state " + st.key} title={st.hint} role="status">
                <StatusGlyph kind={busy && st.key !== "attention" ? glyphKind({ ...st, key: "working" }) : glyphKind(st, { lastKind: dash?.sessions?.[activeTab.sessionId]?.stats?.lastKind })} size={12} />
                {label}
                {st.key === "working" && liveActivity && <span className="sb-activity">{liveActivity}</span>}
              </span>
            );
          })()}
          {ready && <span className="sb-item">{turns.length} {turns.length === 1 ? "turn" : "turns"}</span>}
          {bgRunning.length > 0 && <span className="sb-item">{bgRunning.length} in background</span>}
          <span className="sb-path" title={activeTab.cwd}>
            <ProjMark color={projectColor(activeTab.root || activeTab.cwd)} />
            <span className="sb-path-text">{activeTab.cwd}</span>
            {activeTab.branch && <span className="sb-branch">⌥ {activeTab.branch}</span>}
          </span>
          {usage && (usage.input > 0 || usage.output > 0) && (
            <span
              className="sb-item"
              tabIndex={0}
              title={`Input ${usage.input.toLocaleString()} · Output ${usage.output.toLocaleString()}\nCache read ${usage.cacheRead.toLocaleString()} · Cache write ${usage.cacheCreation.toLocaleString()}`}
            >
              {fmtTokens(usage.input + usage.cacheCreation)} in · {fmtTokens(usage.output)} out
            </span>
          )}
          {ctxPct > 0 && (
            <span
              className={"sb-item sb-ctx" + (ctxPct >= 90 ? " red" : ctxPct >= 70 ? " orange" : ctxPct >= 50 ? " gold" : "")}
              tabIndex={0}
              aria-label={`Conversation ${ctxPct}% full`}
              title={`How full this conversation is: about ${fmtTokens(ctxTokens)} of ${fmtTokens(ctxWin)} tokens.\n${activeAgent.short} compacts the conversation when it fills up.`}
            >
              <span className="sb-gauge"><span style={{ width: ctxPct + "%" }} /></span>
              Context {ctxPct}%
            </span>
          )}
        </footer>
      </div>
      {ctxMenu && (() => {
        const t = ctxMenu.group ? null : tabs.find((x) => x.id === ctxMenu.id);
        const gKey = ctxMenu.group || (t && normRoot(t.root || t.cwd));
        if (!gKey || (!t && !tabs.some((x) => normRoot(x.root || x.cwd) === gKey))) return null;
        const pinItem = (
          <button onClick={() => { togglePinProject(gKey); setCtxMenu(null); }}>
            📌 {pinnedProj.includes(gKey) ? "Unpin project" : "Pin project to the top"}
          </button>
        );
        if (!t) return (
          <div className="ctx-overlay" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
            <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>{pinItem}</div>
          </div>
        );
        const name = tabDisplayName(t);
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
              {tabPos === "left" && pinItem}
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
          <Launch onStart={start} recent={recentList} filters={filters} onOpenSettings={() => openSettings("appearance")} onOpenBrowser={() => { setNewOpen(false); setBrowserOpen(true); }} onCancel={() => setNewOpen(false)} />
        </div>
      )}
      {confirmTab && (
        <div className="modal-backdrop" onClick={() => !closing && setConfirmCloseId(null)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="confirm-title">Close session?</div>
            <div className="confirm-body">
              {agentOf(confirmTab) === "codex" ? (
                <>
                  This closes the terminal for the Codex session in{" "}
                  <b>{tabDisplayName(confirmTab)}</b>. A turn that is still running may carry on in the background; you can reopen the session from Resume.
                </>
              ) : (
                <>
                  This ends the Claude session in{" "}
                  <b>{tabDisplayName(confirmTab)}</b>{" "}
                  and closes its terminal.
                </>
              )}
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
      {dashOpen && (
        <Dashboard
          tabs={tabs}
          dash={dash}
          busyById={busyById}
          rateLimits={rateLimits}
          screenFor={screenFor}
          onJump={(id) => { setActiveId(id); setDashOpen(false); }}
          onClose={() => setDashOpen(false)}
        />
      )}
      {hotkeysOpen && <HotkeySheet onClose={() => setHotkeysOpen(false)} />}
      {agentSetupOpen && <AgentSetup filters={filters} onDone={finishAgentSetup} />}
      {!agentSetupOpen && whatsNew && <WhatsNew version={whatsNew} onClose={() => setWhatsNew(null)} />}
    </div>
    </AgentName.Provider>
  );
}
