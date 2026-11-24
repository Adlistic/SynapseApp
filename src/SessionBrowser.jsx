import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Orb from "./visuals/Orb.jsx";
import { loadTitles, saveTitle, normRoot } from "./filters.js";
import { AGENTS, agentOf, availability, lastPermMode, useAgentStatus } from "./agents.js";
import PermModePicker from "./PermModePicker.jsx";

function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtSize(b) {
  if (b > 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b > 1024) return Math.round(b / 1024) + " KB";
  return b + " B";
}

// Claude Code and Codex group sessions their own way; show one group per
// folder with both kinds in it, newest activity first.
function mergeGroups(lists) {
  const by = new Map();
  for (const g of lists.flat()) {
    const key = normRoot(g.cwd) || g.dir;
    if (!by.has(key)) by.set(key, { dir: key, cwd: g.cwd, sessions: [] });
    by.get(key).sessions.push(...g.sessions);
  }
  const out = [...by.values()];
  for (const g of out) g.sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
  out.sort((a, b) => (b.sessions[0]?.modifiedMs || 0) - (a.sessions[0]?.modifiedMs || 0));
  return out;
}

// Browse every Claude Code and Codex session on this machine (scanned from
// ~/.claude/projects and ~/.codex/sessions), search across them, rename, and
// resume one in the tool it was made with.
export default function SessionBrowser({ onResume, onClose, filters }) {
  const [projects, setProjects] = useState(null);
  const [only, setOnly] = useState("all"); // "all" | "claude" | "codex"
  // Which agents are installed: a session whose tool is missing is greyed
  // out with the reason, instead of opening a terminal that can't run it.
  const status = useAgentStatus();
  const missing = (s) => availability(status, agentOf(s)) === "missing";
  const getIt = (s) => invoke("open_external", { url: AGENTS[agentOf(s)].installUrl }).catch(() => {});
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null); // null = not searching
  const [searching, setSearching] = useState(false);
  const [openDirs, setOpenDirs] = useState({});
  const [titles, setTitles] = useState(loadTitles());
  const [renaming, setRenaming] = useState(null); // sessionId
  const [renameVal, setRenameVal] = useState("");
  const [confirmDel, setConfirmDel] = useState(null); // sessionId pending delete
  const [error, setError] = useState("");
  // Mode to resume in, per agent; starts on the one used last.
  const [modes, setModes] = useState(() => ({ claude: lastPermMode(filters, "claude"), codex: lastPermMode(filters, "codex") }));

  // Two-step delete: 🗑 → "sure?" → gone (removed from disk and the lists).
  async function deleteSession(s) {
    setConfirmDel(null);
    try {
      await invoke("delete_claude_session", { path: s.path });
      setProjects((ps) =>
        (ps || [])
          .map((p) => ({ ...p, sessions: p.sessions.filter((x) => x.sessionId !== s.sessionId) }))
          .filter((p) => p.sessions.length > 0)
      );
      setHits((h) => (h ? h.filter((x) => x.sessionId !== s.sessionId) : h));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    Promise.all([
      invoke("list_claude_sessions").catch((e) => { setError(String(e)); return []; }),
      invoke("list_codex_sessions").catch(() => []),
    ]).then((lists) => setProjects(mergeGroups(lists)));
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Debounced cross-session search.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      invoke("search_sessions", { query: q })
        .then((h) => { setHits(h); setSearching(false); })
        .catch((e) => { setError(String(e)); setSearching(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  function commitRename(sessionId) {
    setTitles(saveTitle(sessionId, renameVal.trim()));
    setRenaming(null);
  }

  // Both kinds on this PC → badges on rows and a filter; otherwise neither.
  const kinds = new Set([...(projects || []).flatMap((p) => p.sessions.map(agentOf)), ...(hits || []).map(agentOf)]);
  const mixed = kinds.size > 1;
  const keep = (s) => only === "all" || agentOf(s) === only;
  const shown = (projects || [])
    .map((p) => ({ ...p, sessions: p.sessions.filter(keep) }))
    .filter((p) => p.sessions.length > 0);

  const row = (s) => (
    <div key={s.sessionId} className={"sess-row" + (missing(s) ? " unavailable" : "")}>
      {renaming === s.sessionId ? (
        <form className="sess-rename" onSubmit={(e) => { e.preventDefault(); commitRename(s.sessionId); }}>
          <input
            autoFocus
            onFocus={(e) => e.target.select()}
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            placeholder={s.title}
            onBlur={() => commitRename(s.sessionId)}
          />
        </form>
      ) : (
        <button
          className="sess-main"
          onClick={() => !missing(s) && onResume(s, titles[s.sessionId] || s.title, modes[agentOf(s)])}
          aria-disabled={missing(s) || undefined}
          title={missing(s)
            ? `${AGENTS[agentOf(s)].name} isn't installed on this PC, so this session can't be reopened. Install it to resume it.`
            : `${s.cwd || "?"}\n${AGENTS[agentOf(s)].name} · ${s.sessionId}\nClick to resume this session`}
        >
          <span className="sess-title">{titles[s.sessionId] || s.title}</span>
          <span className="sess-meta">
            {fmtTime(s.modifiedMs)} · {fmtSize(s.sizeBytes)}
            {s.matchCount ? ` · ${s.matchCount} match(es)` : ""}
          </span>
          {s.snippet && <span className="sess-snippet">…{s.snippet}…</span>}
          {missing(s) && (
            <span className="sess-why">Can't reopen: {AGENTS[agentOf(s)].name} isn't installed on this PC.</span>
          )}
        </button>
      )}
      {mixed && <span className="sess-agent" title={`${AGENTS[agentOf(s)].name} session`}>{AGENTS[agentOf(s)].short}</span>}
      {missing(s) && (
        <button className="sess-act sess-get" onClick={() => getIt(s)} title={`How to install ${AGENTS[agentOf(s)].name} (opens in your browser)`}>
          Get {AGENTS[agentOf(s)].short} ↗
        </button>
      )}
      <button
        className="sess-act"
        title="Rename"
        onClick={() => { setRenaming(s.sessionId); setRenameVal(titles[s.sessionId] || ""); }}
      >
        ✎
      </button>
      {agentOf(s) === "codex" ? (
        // Codex keeps its own index of sessions; delete them in Codex (`codex delete <id>`).
        <span className="sess-act sess-act-none" aria-hidden="true">🗑</span>
      ) : confirmDel === s.sessionId ? (
        <button
          className="sess-act danger"
          title="Click again to permanently delete this transcript"
          onClick={() => deleteSession(s)}
        >
          sure?
        </button>
      ) : (
        <button
          className="sess-act"
          title="Delete this transcript from disk"
          onClick={() => setConfirmDel(s.sessionId)}
        >
          🗑
        </button>
      )}
    </div>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="browser" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="browser-head">
          <span className="browser-title">⧉ Resume a session</span>
          <input
            className="browser-search"
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every transcript…"
          />
          <button className="tab-x" onClick={onClose} title="Close">✕</button>
        </div>
        <div className="browser-perm">
          {[...kinds].filter((k) => !mixed || only === "all" || only === k).sort().map((k) => (
            <div key={k}>
              <span className="browser-perm-label">{mixed ? `Resume ${AGENTS[k].name} sessions with` : "Resume with"}</span>
              <PermModePicker variant="cards" agent={k} value={modes[k]} label={`Permissions for resumed ${AGENTS[k].name} sessions`} onChange={(v) => setModes((m) => ({ ...m, [k]: v }))} />
            </div>
          ))}
        </div>
        <div className="browser-body">
          {error && <div className="error">{error}</div>}
          {searching && <div className="empty orb-wait" role="status" aria-live="polite"><Orb mode="searching" size={180} reactive={false} /><span>Searching every transcript…</span></div>}

          {mixed && (
            <div className="browser-chips" role="group" aria-label="Show sessions from">
              {[["all", "All"], ["claude", "Claude Code"], ["codex", "Codex"]].map(([k, l]) => (
                <button key={k} aria-pressed={only === k} className={"browser-chip" + (only === k ? " on" : "")} onClick={() => setOnly(k)}>{l}</button>
              ))}
            </div>
          )}
          {hits !== null && !searching && (
            <>
              {hits.filter(keep).length === 0 && <div className="empty">No transcripts mention “{query.trim()}”.</div>}
              {hits.filter(keep).map((h) => row(h))}
            </>
          )}

          {hits === null && projects === null && <div className="empty orb-wait" role="status" aria-live="polite"><Orb mode="searching" size={180} reactive={false} /><span>Looking for sessions…</span></div>}
          {hits === null && projects !== null && projects.length === 0 && (
            <div className="empty">No Claude Code or Codex sessions found on this machine yet.</div>
          )}
          {hits === null &&
            shown.map((p) => {
              const open = openDirs[p.dir] === true; // collapsed by default
              return (
                <div key={p.dir} className="proj-group">
                  <button
                    className="proj-head"
                    onClick={() => setOpenDirs((o) => ({ ...o, [p.dir]: !open }))}
                    title={p.cwd || p.dir}
                  >
                    {open ? "▾" : "▸"} {p.cwd || p.dir}
                    <span className="proj-count">{p.sessions.length}</span>
                  </button>
                  {open && p.sessions.map((s) => row(s))}
                </div>
              );
            })}
        </div>
        <div className="browser-foot">Click a session to resume it in a new tab — it reopens in the tool it was made with (<code>claude --resume</code> or <code>codex resume</code>).</div>
      </div>
    </div>
  );
}
