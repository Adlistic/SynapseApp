import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getVersion } from "@tauri-apps/api/app";
import changelogRaw from "../CHANGELOG.md?raw";
import TerminalPane from "./TerminalPane.jsx";
import SettingsModal from "./SettingsModal.jsx";
import SessionBrowser from "./SessionBrowser.jsx";
import Dashboard, { statusFor } from "./Dashboard.jsx";
import { useUpdateStatus, installUpdate, dismissUpdate } from "./updater.js";
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
  normRoot,
  baseNameOf,
  projectColor,
  tabDisplayName,
  saveTitle,
  messageDisplay,
  resolveCategory,
  displayColor,
  pillStyle,
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

const KIND_COLORS = KIND_COLOR;
const CAT_COLOR = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.color]));
const CAT_LABEL = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.label]));

// Persisted terminal/messages split (percent width of the terminal column).
const SPLIT_KEY = "synapse2.split.v1";
function loadSplit() { const v = parseFloat(localStorage.getItem(SPLIT_KEY)); return v >= 20 && v <= 80 ? v : 58; }
function saveSplit(v) { try { localStorage.setItem(SPLIT_KEY, String(Math.round(v))); } catch {} }

// Persisted left tab-rail width (px), used when tab position is "left".
const RAILW_KEY = "synapse2.railw.v1";
function loadRailW() { const v = parseFloat(localStorage.getItem(RAILW_KEY)); return v >= 150 && v <= 340 ? v : 190; }
function saveRailW(v) { try { localStorage.setItem(RAILW_KEY, String(Math.round(v))); } catch {} }

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
            ? `Synapse ${st.version} is downloaded and ready — click for what's new`
            : st.status === "installing"
            ? `Installing Synapse ${st.version}…`
            : `Downloading Synapse ${st.version} in the background — ${st.progress}%`
        }
      >
        {ready ? "⬆ Update available" : st.status === "installing" ? "Installing…" : `⬆ ${st.progress}%`}
      </button>
      {open && ready && (
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
        </div>
      )}
    </div>
  );
}

const CMD_RE = /^\s*<command-name>([^<]*)<\/command-name>/;
const LOCAL_RE = /^\s*<local-command-(stdout|caveat)>/;
// Harness injections Claude Code's own UI hides: <system-reminder> blocks
// (skill loads, context refreshes) embedded in user text and tool results.
const stripReminders = (s) =>
  (s || "").replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, "").trim();
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
      const isNotif = /^\s*<task-notification>|^\s*\[SYSTEM NOTIFICATION/i.test(text);
      const cleaned = cmd ? cmd[1].trim() : isNotif ? "" : stripReminders(stripAnsi(text));
      if (!cmd && !isNotif && !cleaned) continue; // pure injection — not a real turn
      cur = {
        id: m.id,
        prompt: cmd ? cleaned : isNotif ? "background task notification" : cleaned,
        isCommand: !!cmd || isNotif,
        isNotif,
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

// ─── agent-style response rendering ─────────────────────────────────────────
// Claude's prose is the star: it flows unboxed. Tool calls pair with their
// results into one compact expandable row; thinking collapses to a one-liner.

// Assistant text / question — plain flowing markdown.
const Prose = memo(function Prose({ m }) {
  return (
    <div className="prose md">
      <Markdown>{m.text}</Markdown>
    </div>
  );
});

// Plans keep a light frame — they're artifacts worth visually separating.
const PlanBlock = memo(function PlanBlock({ m }) {
  const color = displayColor(KIND_COLORS.plan, isLightTheme());
  return (
    <div className="plan-block" style={{ borderLeftColor: color }}>
      <div className="plan-cap" style={{ color }}>⌑ plan</div>
      <Markdown>{m.text}</Markdown>
    </div>
  );
});

const RESULT_CLAMP_LINES = 12;

// One tool call + its result(s) as a single expandable row:
//   ▸ Read src/auth.js · 120 lines
const ToolRow = memo(function ToolRow({ call, results }) {
  const failed = results.some((r) => r.isError || r.is_error);
  const [open, setOpen] = useState(failed); // errors start expanded
  const [showAll, setShowAll] = useState(false);
  const m = call || results[0];
  const color = displayColor(
    failed ? KIND_COLORS.error : (CAT_COLOR[m.toolCategory] || KIND_COLORS.toolcall),
    isLightTheme()
  );
  const resultText = stripReminders(results.map((r) => r.text || "").join("\n")).trimEnd();
  const lines = resultText ? resultText.split("\n") : [];
  const summary = failed
    ? "failed"
    : call?.editData
    ? "edit"
    : lines.length > 1
    ? `${lines.length} lines`
    : lines.length === 1 && lines[0].length
    ? lines[0].slice(0, 60)
    : "done";
  const shown = showAll ? lines : lines.slice(0, RESULT_CLAMP_LINES);
  return (
    <div className={"trow" + (failed ? " failed" : "")}>
      <button className="trow-head" onClick={() => setOpen((v) => !v)} title={m.text}>
        <span className="trow-chev">{open ? "▾" : "▸"}</span>
        <span className="trow-name" style={{ color }}>{call ? call.toolName || "tool" : "result"}</span>
        <span className="trow-preview">{call ? call.text : ""}</span>
        <span className="trow-sum">{summary}</span>
      </button>
      {open && (
        <div className="trow-body">
          {call?.editData && <DiffView editData={call.editData} toolName={call.toolName} />}
          {lines.length > 0 && !call?.editData && (
            <>
              <pre className="trow-out">{shown.join("\n")}</pre>
              {lines.length > RESULT_CLAMP_LINES && (
                <button className="trow-more" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "show less" : `show all ${lines.length} lines`}
                </button>
              )}
            </>
          )}
          {lines.length === 0 && !call?.editData && <div className="trow-out empty">no output</div>}
        </div>
      )}
    </div>
  );
});

// "… thought for a moment" — reasoning on demand, never in the way.
const ThinkingRow = memo(function ThinkingRow({ m }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="think-row">
      <button className="think-head" onClick={() => setOpen((v) => !v)}>
        … thought for a moment {open ? "▾" : "▸"}
      </button>
      {open && <pre className="think-body">{m.text}</pre>}
    </div>
  );
});

const ErrorRow = memo(function ErrorRow({ m }) {
  return <div className="err-row">✗ {m.text}</div>;
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
    body: "Start a session in any folder, or press ⧉ to resume any Claude Code session on this machine — full history included. Drag tabs to reorder, double-click to rename.",
  },
  {
    icon: "❯",
    title: "Terminal + conversation, side by side",
    body: "The left pane is the real claude CLI — type there as normal. The right pane lays the conversation out as collapsible turns: search it, expand tool calls and diffs, export it.",
  },
  {
    icon: "⌨",
    title: "Your left hand drives",
    body: "Ctrl+Shift+T new session · Ctrl+Shift+R resume · Ctrl+Shift+F search · Ctrl+Tab switch tabs. Press Ctrl+Shift+D anytime for the full list.",
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
          {items.map((it, i) => {
            switch (it.type) {
              case "prose": return <Prose key={it.m.id} m={it.m} />;
              case "plan": return <PlanBlock key={it.m.id} m={it.m} />;
              case "tool": return <ToolRow key={(it.call || it.results[0]).id} call={it.call} results={it.results} />;
              case "thinking": return <ThinkingRow key={it.m.id} m={it.m} />;
              case "error": return <ErrorRow key={it.m.id} m={it.m} />;
              default: return (
                <div key={"row" + i} className="pill-row">
                  {it.groups.map((g, j) =>
                    g.variant === "pill" ? <PillFull key={j} g={g} /> : <PillDot key={j} g={g} />
                  )}
                </div>
              );
            }
          })}
        </div>
      )}
    </div>
  );
});

// Collapse a turn's responses into render items: flowing prose, paired
// tool rows (call + its results matched via toolUseId), thinking expanders,
// and 'pillrow' runs of consecutive filtered-out tools.
function buildItems(responses, filters, catById) {
  // Pair every tool result with its originating call up front.
  const resultsByUse = {};
  for (const m of responses) {
    // Include errored results (kind === "error") so a failed tool call's output
    // attaches to its call row (which has dedicated failed-state UI) instead of
    // rendering as a detached error bubble with the call left looking output-less.
    if ((m.kind === "toolresult" || m.kind === "error") && m.toolUseId) {
      (resultsByUse[m.toolUseId] = resultsByUse[m.toolUseId] || []).push(m);
    }
  }
  const paired = new Set();

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
    if (m.kind === "toolcall") {
      const results = (m.toolUseId && resultsByUse[m.toolUseId]) || [];
      const disp = messageDisplay(m, filters, catById);
      if (disp === "full") {
        results.forEach((r) => paired.add(r.id));
        flush();
        items.push({ type: "tool", call: m, results });
      } else if (disp === "hidden") {
        results.forEach((r) => paired.add(r.id));
      } else {
        results.forEach((r) => paired.add(r.id));
        run.push({ m, disp, cat: resolveCategory(m, catById) });
      }
    } else if (m.kind === "toolresult") {
      if (paired.has(m.id)) continue; // shown inside its tool row
      const disp = messageDisplay(m, filters, catById);
      if (disp === "full") { flush(); items.push({ type: "tool", call: null, results: [m] }); }
      else if (disp !== "hidden") run.push({ m, disp, cat: resolveCategory(m, catById) });
    } else if (m.kind === "thinking") {
      if (messageDisplay(m, filters, catById) === "full") { flush(); items.push({ type: "thinking", m }); }
    } else if (m.kind === "error") {
      if (paired.has(m.id)) continue; // already shown inside its tool row
      if (messageDisplay(m, filters, catById) === "full") { flush(); items.push({ type: "error", m }); }
    } else if (m.kind === "plan") {
      if (messageDisplay(m, filters, catById) === "full") { flush(); items.push({ type: "plan", m }); }
    } else {
      // message / question / anything textual → flowing prose
      if (messageDisplay(m, filters, catById) === "full") { flush(); items.push({ type: "prose", m }); }
    }
  }
  flush();
  return items;
}

function Launch({ onStart, recent = [], onOpenSettings, onOpenBrowser, onCancel }) {
  const [folder, setFolder] = useState("");
  // Default OFF: --dangerously-skip-permissions lets Claude run shell/edits/deletes
  // with no prompts, so it must be a deliberate opt-in, not the default.
  const [fullAutonomy, setFullAutonomy] = useState(false);
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
        {error && <div className="error" role="button" title="Dismiss" onClick={() => setError("")}>{error} <span className="error-x">✕</span></div>}
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
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const dragTab = useRef(null);
  const feedSearchRef = useRef(null);

  // Post-update "what's new" (once per version) + first-run welcome tour.
  useEffect(() => {
    getVersion().then((v) => {
      const seen = localStorage.getItem(SEEN_VERSION_KEY);
      if (!localStorage.getItem(TOURED_KEY)) {
        setWelcomeOpen(true);
      } else if (seen && seen !== v) {
        setWhatsNew(v);
      }
      localStorage.setItem(SEEN_VERSION_KEY, v);
    }).catch(() => {});
  }, []);
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
            toast(`◆ ${name}`, `Claude finished — ${steps} new step${steps > 1 ? "s" : ""}.`);
          }
        }, 2500);
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
        branch: s.branch,
        title: title || null,
        dupSeq,
        createdAt: Date.now(),
      }];
    });
    setActiveId(id);
    setNewOpen(false);
    setBrowserOpen(false);
  }

  // Start a session → add a tab (never closes existing ones).
  async function start(opts) {
    // A second non-worktree session in an already-occupied folder can stomp the
    // first one's edits — nudge toward isolation (after starting; not a block).
    const clash =
      !opts.worktrees &&
      tabsRef.current.some((t) => normRoot(t.root || t.cwd) === normRoot(opts.folder));
    const s = await invoke("start_session", { opts });
    setRecent(addRecentFolder(opts.folder));
    addTab(s, null);
    // Isolation was requested but silently fell back to the real folder — warn.
    setError(
      s.worktreeError
        ? `Worktree isolation couldn't be created (${s.worktreeError}); this session runs directly in the folder — edits are NOT sandboxed.`
        : clash
        ? "Heads up: another session is already running in this folder — parallel sessions can overwrite each other's edits. The worktree option isolates each session."
        : ""
    );
  }

  // Resume an existing Claude Code session from the browser. Autonomy is OFF by
  // default — resuming to view/continue a session must not silently grant
  // --dangerously-skip-permissions.
  async function resume(sessionMeta, title) {
    try {
      setError("");
      const s = await invoke("resume_session", {
        sessionId: sessionMeta.sessionId,
        cwd: sessionMeta.cwd || "",
        fullAutonomy: false,
      });
      if (sessionMeta.cwd) setRecent(addRecentFolder(sessionMeta.cwd));
      addTab(s, title || sessionMeta.title || null);
    } catch (e) {
      setError(String(e));
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
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
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
    const walker = document.createTreeWalker(feedRef.current, NodeFilter.SHOW_TEXT);
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
  }, [activeId]);
  useEffect(() => {
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
        <div className="update-float"><UpdateChip /></div>
        <Launch onStart={start} recent={recentList} onOpenSettings={() => openSettings("appearance")} onOpenBrowser={() => setBrowserOpen(true)} />
        {browserModal}
        {settingsModal}
        {hotkeysOpen && <HotkeySheet onClose={() => setHotkeysOpen(false)} />}
        {welcomeOpen && <Welcome onDone={finishWelcome} />}
        {!welcomeOpen && whatsNew && <WhatsNew version={whatsNew} onClose={() => setWhatsNew(null)} />}
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

  // A session likely "needs attention" when its last activity was a tool call
  // and the stream has gone quiet — typically Claude waiting for an approval
  // in the terminal. Heuristic, so it's a hint, not an alarm.
  function tabAttention(id) {
    const msgs = convos[id]?.messages;
    const last = msgs && msgs[msgs.length - 1];
    return !!last && last.kind === "toolcall" && !busyById[id];
  }

  // Fleet aggregates for the top-bar chip: how many sessions are running,
  // streaming, waiting on the human, and how many subagents are live.
  const fleetWorking = tabs.filter((t) => busyById[t.id]).length;
  const fleetNeeds = tabs.filter((t) => tabAttention(t.id)).length;
  const fleetAgents = tabs.reduce(
    (a, t) => a + ((dash?.sessions?.[t.sessionId]?.stats?.agents || []).filter((x) => !x.done).length),
    0
  );

  // One tab chip. In the grouped left rail the folder name lives on the group
  // header, so the tab itself shows only its distinguishing bit.
  const renderTab = (t, grouped) => {
    const name = grouped ? t.title || `session ${t.dupSeq || 1}` : tabDisplayName(t);
    // Always-on status indicator (same derivation as Mission Control).
    const sess = dash?.sessions?.[t.sessionId];
    const st = statusFor(sess?.stats, !!busyById[t.id], sess?.ready);
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
            <span className="tab-proj" style={{ background: projectColor(t.root || t.cwd) }} title={t.root || t.cwd} />
            {st.key === "attention" ? (
              <span className="tab-sig" title={st.hint}>
                {{ toolcall: "⚠", question: "?", plan: "▤" }[sess?.stats?.lastKind] || "⚠"}
              </span>
            ) : st.key === "working" ? (
              <span className="tab-dot working" title={st.hint} />
            ) : t.id !== activeTab.id && newById[t.id] ? (
              <span className="tab-dot" title="New activity" />
            ) : (
              <span className="tab-dot idle" title={st.hint} />
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
  };

  // Left rail groups tabs under one header per project folder; the top bar
  // stays flat (horizontal space is too tight for headers).
  const tabGroups = (() => {
    const by = new Map();
    for (const t of tabs) {
      const key = normRoot(t.root || t.cwd);
      if (!by.has(key)) by.set(key, { key, root: t.root || t.cwd, tabs: [] });
      by.get(key).tabs.push(t);
    }
    return [...by.values()];
  })();

  const tabBar = (
    <div className={"tabbar " + tabPos} style={tabPos === "left" ? { width: railW } : undefined}>
      {tabPos === "left"
        ? tabGroups.map((g) => (
            <div key={g.key} className="tabgroup">
              <div className="tabgroup-head" title={g.root}>
                <span className="proj-dot" style={{ background: projectColor(g.root) }} />
                <span className="tabgroup-name">{baseNameOf(g.root)}</span>
                {g.tabs.length > 1 && <span className="tabgroup-count">{g.tabs.length}</span>}
              </div>
              {g.tabs.map((t) => renderTab(t, true))}
            </div>
          ))
        : tabs.map((t) => renderTab(t, false))}
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
          <div className="session-info" title={activeTab.cwd}>
            <span className="proj-dot" style={{ background: projectColor(activeTab.root || activeTab.cwd) }} />
            {activeTab.cwd}{activeTab.branch ? ` · ⌥ ${activeTab.branch}` : ""}
          </div>
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
          <button
            className="usage-chip fleet-chip"
            onClick={() => setDashOpen(true)}
            title={`Fleet: ${tabs.length} session(s) · ${fleetWorking} working · ${fleetNeeds} needing you · ${fleetAgents} subagent(s) live\nClick for Mission Control (Ctrl+Shift+B)`}
          >
            <span className="fleet-seg">▦ {tabs.length}</span>
            <span className={"fleet-seg" + (fleetWorking ? " ok" : " dim")}>● {fleetWorking} working</span>
            <span className={"fleet-seg" + (fleetNeeds ? " warn" : " dim")}>⚠ {fleetNeeds} need you</span>
            <span className={"fleet-seg" + (fleetAgents ? " ok" : " dim")}>⑂ {fleetAgents} agents</span>
          </button>
          <div className="run-state">
            {tabAttention(activeTab.id) && !busy && (
              <span className="attn-hint" title="The last activity was a tool call with no result yet — Claude may be waiting for you in the terminal">⚠ waiting?</span>
            )}
            {busy ? <span className="pulse">● working…</span> : ready ? `${turns.length} turn(s)` : ""}
          </div>
          <UpdateChip />
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
              {error && <div className="error" role="button" title="Dismiss" onClick={() => setError("")}>{error} <span className="error-x">✕</span></div>}
            </section>
          </div>
        </div>
      </div>
      {ctxMenu && (() => {
        const t = tabs.find((x) => x.id === ctxMenu.id);
        if (!t) return null;
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
              <b>{tabDisplayName(confirmTab)}</b>{" "}
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
      {dashOpen && (
        <Dashboard
          tabs={tabs}
          dash={dash}
          busyById={busyById}
          rateLimits={rateLimits}
          onJump={(id) => { setActiveId(id); setDashOpen(false); }}
          onClose={() => setDashOpen(false)}
        />
      )}
      {hotkeysOpen && <HotkeySheet onClose={() => setHotkeysOpen(false)} />}
      {whatsNew && <WhatsNew version={whatsNew} onClose={() => setWhatsNew(null)} />}
    </div>
  );
}
