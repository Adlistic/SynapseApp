import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadTitles, saveTitle } from "./filters.js";

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

// Browse every Claude Code session on this machine (scanned from
// ~/.claude/projects), search across transcripts, rename, and resume one.
export default function SessionBrowser({ onResume, onClose }) {
  const [projects, setProjects] = useState(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null); // null = not searching
  const [searching, setSearching] = useState(false);
  const [openDirs, setOpenDirs] = useState({});
  const [titles, setTitles] = useState(loadTitles());
  const [renaming, setRenaming] = useState(null); // sessionId
  const [renameVal, setRenameVal] = useState("");
  const [confirmDel, setConfirmDel] = useState(null); // sessionId pending delete
  const [error, setError] = useState("");

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
    invoke("list_claude_sessions").then(setProjects).catch((e) => setError(String(e)));
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

  const row = (s) => (
    <div key={s.sessionId} className="sess-row">
      {renaming === s.sessionId ? (
        <form className="sess-rename" onSubmit={(e) => { e.preventDefault(); commitRename(s.sessionId); }}>
          <input
            autoFocus
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            placeholder={s.title}
            onBlur={() => commitRename(s.sessionId)}
          />
        </form>
      ) : (
        <button
          className="sess-main"
          onClick={() => onResume(s, titles[s.sessionId] || s.title)}
          title={`${s.cwd || "?"}\n${s.sessionId}\nClick to resume this session`}
        >
          <span className="sess-title">{titles[s.sessionId] || s.title}</span>
          <span className="sess-meta">
            {fmtTime(s.modifiedMs)} · {fmtSize(s.sizeBytes)}
            {s.matchCount ? ` · ${s.matchCount} match(es)` : ""}
          </span>
          {s.snippet && <span className="sess-snippet">…{s.snippet}…</span>}
        </button>
      )}
      <button
        className="sess-act"
        title="Rename"
        onClick={() => { setRenaming(s.sessionId); setRenameVal(titles[s.sessionId] || ""); }}
      >
        ✎
      </button>
      {confirmDel === s.sessionId ? (
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
        <div className="browser-body">
          {error && <div className="error">{error}</div>}
          {searching && <div className="empty">Searching…</div>}

          {hits !== null && !searching && (
            <>
              {hits.length === 0 && <div className="empty">No transcripts mention “{query.trim()}”.</div>}
              {hits.map((h) => row(h))}
            </>
          )}

          {hits === null && projects === null && <div className="empty">Scanning ~/.claude/projects…</div>}
          {hits === null && projects !== null && projects.length === 0 && (
            <div className="empty">No Claude Code sessions found on this machine yet.</div>
          )}
          {hits === null &&
            (projects || []).map((p) => {
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
        <div className="browser-foot">Click a session to resume it in a new tab (terminal runs <code>claude --resume</code>).</div>
      </div>
    </div>
  );
}
