// Reader pieces that go beyond "prompt, steps, answer": answering Claude from
// the reader, the per-reply change summary, a subagent's own feed, and the
// outline of prompts.

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import DiffView from "../DiffView.jsx";
import Icon from "./icons.jsx";
import { ReaderActions, AgentName } from "./actions.js";
import { agentTurns, turnChanges, splitPath, toolLabel, fmtClock, fmtDuration, plural } from "./analyze.js";
import Orb from "../visuals/Orb.jsx";

// ─── Claude asked a multiple-choice question ────────────────────────────────

// Shows an AskUserQuestion call. While it is waiting and is one single-choice
// question, the options are buttons: Claude Code's picker selects option N on
// the N key, so a click presses that key in the terminal — but only after
// checking that this very option is on the terminal's screen (see `answer` in
// App). If it isn't, nothing is sent. Anything richer (several questions,
// multi-select, a typed answer) is answered in the terminal, one click away.
export function AskCard({ ask, canAct = false, compact = false }) {
  const actions = useContext(ReaderActions);
  const [sent, setSent] = useState(null);
  const [blocked, setBlocked] = useState(false);
  const interactive = canAct && !ask.answered && ask.quick && !!actions.answer && sent === null && !blocked;
  if (compact) {
    return (
      <div className="ask-done">
        {ask.questions.map((q, i) => (
          <div key={i} className="ask-done-row">
            <Icon name="ask-user" size={12} />
            <span className="ask-done-q">{q.question}</span>
            <span className="ask-done-a">{q.answer || (ask.declined ? "not answered" : "answered")}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={"ask-card" + (ask.answered ? " answered" : "")}>
      <div className="ask-flag" role={ask.answered ? undefined : "status"}>
        <Icon name="ask-user" size={13} />
        {ask.answered ? (ask.declined ? "Claude asked — not answered" : "Claude asked — you answered") : "Claude is asking you"}
      </div>
      {ask.questions.map((q, qi) => (
        <div key={qi} className="ask-q">
          {q.header && <span className="ask-head">{q.header}</span>}
          <div className="ask-text">{q.question}</div>
          <div className="ask-opts" role={interactive ? "group" : undefined} aria-label={interactive ? "Answers" : undefined}>
            {q.options.map((o, oi) => {
              const chosen = ask.answered ? (q.answer || "").split(", ").includes(o.label) || q.answer === o.label : sent === oi;
              const body = (
                <>
                  <span className="ask-num">{chosen ? <Icon name="check" size={11} /> : oi + 1}</span>
                  <span className="ask-opt-text">
                    <span className="ask-label">{o.label}</span>
                    {o.description && <span className="ask-desc">{o.description}</span>}
                  </span>
                </>
              );
              return interactive ? (
                <button
                  key={oi}
                  className="ask-opt"
                  title={`Answer “${o.label}” (presses ${oi + 1} in the terminal)`}
                  onClick={() => { if (actions.answer(ask, oi)) setSent(oi); else setBlocked(true); }}
                >
                  {body}
                </button>
              ) : (
                <div key={oi} className={"ask-opt static" + (chosen ? " chosen" : "")}>{body}</div>
              );
            })}
          </div>
          {ask.answered && q.answer && !q.options.some((o) => q.answer.split(", ").includes(o.label)) && (
            <div className="ask-own"><span>You answered</span> {q.answer}</div>
          )}
        </div>
      ))}
      {!ask.answered && canAct && (
        <div className="ask-foot">
          {sent !== null ? (
            <span className="ask-note"><Icon name="check" size={12} /> Sent to the terminal. If the question is still showing there, press Enter in it.</span>
          ) : blocked ? (
            <span className="ask-note">Nothing was sent: this question isn't what the terminal is showing right now. Answer it there.</span>
          ) : (
            <span className="ask-note">
              {ask.quick ? "Pick an answer here, or type your own in the terminal." : "This one has several parts — answer it in the terminal."}
            </span>
          )}
          {actions.focusTerminal && (
            <button className="mini-btn" onClick={() => actions.focusTerminal()}>
              <Icon name="shell" size={12} /> Go to terminal
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Claude looks stuck on a permission prompt ──────────────────────────────

// A tool call that has had no result for a while in a session that asks for
// approvals. The prompt itself only exists in the terminal, and the reader
// sees a shortened description of the call — so this only points you there.
// Approving is deliberately NOT offered from here: a permission prompt is the
// safeguard against Claude being talked into something, and it should be
// answered while looking at the real thing.
export function WaitCard({ step, sure = false }) {
  const agent = useContext(AgentName);
  const actions = useContext(ReaderActions);
  const call = step.call;
  if (!call) return null;
  const { name, ns } = toolLabel(call.toolName);
  return (
    <div className="wait-card">
      <div className="ask-flag warn" role="status"><Icon name="error" size={13} /> {sure ? `${agent} is waiting for your approval` : `${agent} may be waiting for your approval`}</div>
      <div className="wait-what">
        <span className="wait-tool" title={call.toolName}>{name}{ns ? ` · ${ns}` : ""}</span>
        {call.desc && <span className="wait-desc">{call.desc}</span>}
        {call.text && <code className="wait-target">{call.text}</code>}
      </div>
      <div className="ask-foot">
        <span className="ask-note">
          {sure
            ? "The terminal is showing a permission prompt. Answer it there — it has the full command."
            : "This step has been quiet for a while and the terminal can't be read. It may be showing a permission prompt — it has the full command."}
        </span>
        {actions.focusTerminal && (
          <button className="mini-btn" onClick={() => actions.focusTerminal()}>
            <Icon name="shell" size={12} /> Go to terminal
          </button>
        )}
      </div>
    </div>
  );
}

// ─── reply to Claude without leaving the reader ─────────────────────────────

// A normal text box (so dictation tools can target it). Enter puts the text
// into the terminal's input and moves the keyboard there; you press Enter in
// the terminal to send it. The reader never submits text itself: it can't be
// sure Claude (rather than a plain shell) is what would receive it.
export function ReplyBox({ placeholder = "Write a reply — Enter puts it in the terminal…" }) {
  const agent = useContext(AgentName);
  const actions = useContext(ReaderActions);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const ref = useRef(null);
  if (!actions.type) return null;
  const go = () => {
    const t = text.trim();
    if (!t) return;
    if (!actions.type(t)) return;
    setText("");
    if (ref.current) ref.current.style.height = "auto";
    setSent(true);
    setTimeout(() => setSent(false), 4000);
  };
  return (
    <form className="reply-box" onSubmit={(e) => { e.preventDefault(); go(); }}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={sent ? "It's in the terminal — press Enter there to send" : placeholder}
        aria-label={`Reply to ${agent}`}
        onChange={(e) => {
          setText(e.target.value);
          const el = e.target;
          el.style.height = "auto";
          el.style.height = Math.min(160, el.scrollHeight) + "px";
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); }
        }}
      />
      <button type="submit" className="reply-send" disabled={!text.trim()} title="Put it in the terminal (Enter)" aria-label="Put the reply in the terminal">
        <Icon name="send" size={14} />
      </button>
    </form>
  );
}

// ─── what this reply changed ────────────────────────────────────────────────

function relPath(p, root) {
  if (!root) return p;
  const r = root.replace(/[\\/]+$/, "");
  const norm = (s) => s.replace(/\//g, "\\").toLowerCase();
  return norm(p).startsWith(norm(r) + "\\") ? p.slice(r.length + 1) : p;
}

// One block per reply: every file it touched, with lines in and out. A file
// opens to show all of its edits from this reply together, before and after.
export function Changes({ steps, root }) {
  const files = useMemo(() => turnChanges(steps), [steps]);
  const [open, setOpen] = useState(false);
  const [openFiles, setOpenFiles] = useState({});
  if (!files.length) return null;
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  return (
    <section className={"changes" + (open ? " open" : "")}>
      <button className="changes-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? "Hide the changes" : "Show what this reply changed"}>
        <span className="work-ico"><Icon name="file-write" size={13} /></span>
        <span className="work-lead">{plural(files.length, "file")} changed</span>
        <span className="chg-stat"><span className="add">+{adds}</span><span className="del">−{dels}</span></span>
        <Icon name="chevron" size={12} className={"step-chev" + (open ? " open" : "")} />
      </button>
      {open && (
        <ul className="changes-list">
          {files.map((f) => {
            const rel = relPath(f.path, root);
            const p = splitPath(rel);
            const isOpen = !!openFiles[f.path];
            return (
              <li key={f.path} className={isOpen ? "open" : ""}>
                <button className="chg-file" onClick={() => setOpenFiles((s) => ({ ...s, [f.path]: !isOpen }))} aria-expanded={isOpen} title={f.path}>
                  <Icon name="chevron" size={11} className={"step-chev" + (isOpen ? " open" : "")} />
                  <span className="step-target path">
                    {p ? <><span className="dir">{"‎" + p.dir + "‎"}</span><span className="base">{p.base}</span></> : <span className="base">{rel}</span>}
                  </span>
                  {f.created && <span className="tag">written</span>}
                  {f.edits.length > 1 && <span className="chg-n">{f.edits.length} edits</span>}
                  <span className="chg-stat"><span className="add">+{f.adds}</span><span className="del">−{f.dels}</span></span>
                </button>
                {isOpen && f.edits.map((e) => (
                  <div key={e.id} className="step-diff"><DiffView editData={e.editData} toolName={e.toolName} /></div>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ─── a subagent's own feed ──────────────────────────────────────────────────

// Loads one subagent's transcript (Claude Code keeps each in its own file)
// and keeps it fresh while the agent runs. `render` draws the turns, so this
// file doesn't need to import the Turn component (which imports this file).
export function AgentPanel({ sessionId, toolUseId, label, running, onClose, children }) {
  const [state, setState] = useState({ loading: true, found: false, messages: [], finished: false, agentType: "", description: "" });
  const linesRef = useRef(0);
  const backRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    backRef.current?.focus();
    // After the covered feed is interactive again (it is inert while we're open).
    return () => { setTimeout(() => { if (opener && document.contains(opener)) opener.focus?.(); }, 0); };
  }, []);
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    let alive = true;
    let timer = null;
    linesRef.current = 0;
    setState({ loading: true, found: false, messages: [], finished: false, agentType: "", description: "" });
    const pull = async () => {
      let finished = false;
      let more = false;
      try {
        const r = await invoke("get_agent_run", { sessionId, toolUseId, since: linesRef.current });
        if (!alive) return;
        if (r?.found) {
          linesRef.current = r.lines || linesRef.current;
          finished = !!r.finished;
          more = !!r.more;
          setState((s) => ({
            loading: false,
            found: true,
            finished,
            agentType: r.agentType || "",
            description: r.description || "",
            messages: r.messages?.length ? [...s.messages, ...r.messages] : s.messages,
          }));
        } else {
          setState((s) => ({ ...s, loading: false }));
        }
      } catch {
        if (alive) setState((s) => ({ ...s, loading: false }));
      }
      // Keep polling while it can still grow: not marked finished, and the
      // parent session hasn't seen it end.
      if (alive && more) timer = setTimeout(pull, 50);
      else if (alive && !finished && runningRef.current !== false) timer = setTimeout(pull, 1500);
    };
    pull();
    return () => { alive = false; clearTimeout(timer); };
  }, [sessionId, toolUseId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const turns = useMemo(() => agentTurns(state.messages), [state.messages]);
  const live = !state.finished && running !== false;
  const times = state.messages.map((m) => m.at).filter(Boolean);
  const dur = times.length > 1 ? fmtDuration(times[times.length - 1] - times[0]) : null;
  const tools = state.messages.filter((m) => m.kind === "toolcall").length;
  return (
    <div className="agent-panel" role="dialog" aria-label="Agent activity">
      <div className="agent-head">
        <button ref={backRef} className="icon-btn" onClick={onClose} title="Back to the conversation (Esc)" aria-label="Back to the conversation">
          <Icon name="chevron" size={14} style={{ transform: "rotate(180deg)" }} />
        </button>
        <span className="agent-ico"><Icon name="subagents" size={14} /></span>
        <span className="agent-title" title={state.description || label}>{state.description || label || "Agent"}</span>
        {state.agentType && <span className="tag">{state.agentType}</span>}
        <span className="spacer" />
        <span className="agent-meta">
          {tools > 0 && <span>{plural(tools, "step")}</span>}
          {dur && <span>{dur}</span>}
        </span>
        {live ? <span className="live-pill"><span className="pulse" />running</span> : <span className="tag ok">finished</span>}
      </div>
      <div className="agent-body feed-uni">
        {state.loading && <div className="reader-empty orb-empty" role="status" aria-live="polite"><Orb mode="searching" size={130} reactive={false} /><span>Loading the agent's work…</span></div>}
        {!state.loading && !state.found && (
          <div className="reader-empty">
            <Icon name="subagents" size={22} />
            <strong>No separate record for this agent</strong>
            <span>Claude Code didn't keep a file for it (older sessions and some agent types don't). Its result is in the main conversation.</span>
          </div>
        )}
        {state.found && children({ turns, live })}
      </div>
    </div>
  );
}

// ─── outline of prompts + pinned turns ──────────────────────────────────────

export function Outline({ turns, pins, onJump, onClose }) {
  const [q, setQ] = useState("");
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const needle = q.trim().toLowerCase();
  const rows = turns.filter((t) => !t.isNotif && t.id !== "__start" && (!needle || (t.prompt || "").toLowerCase().includes(needle)));
  const pinned = rows.filter((t) => pins.includes(t.id));
  const row = (t, pinnedRow) => (
    <button key={(pinnedRow ? "p-" : "") + t.id} role="menuitem" className="outline-row" onClick={() => { onJump(t.id); onClose(); }} title={t.prompt}>
      {pinnedRow ? <Icon name="pin" size={11} /> : <span className="outline-n">{turns.indexOf(t) + 1}</span>}
      <span className={"outline-text" + (t.isCommand ? " meta" : "")}>{t.prompt}</span>
      {t.at && <time>{fmtClock(t.at)}</time>}
    </button>
  );
  return (
    <>
      <div className="ctx-overlay" onClick={onClose} />
      <div
        className="menu-pop outline-pop"
        role="menu"
        aria-label="Prompts in this session"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const items = [...e.currentTarget.querySelectorAll(".outline-row")];
          const i = items.indexOf(document.activeElement);
          (items[i + (e.key === "ArrowDown" ? 1 : -1)] || (e.key === "ArrowUp" ? inputRef.current : items[0]))?.focus();
        }}
      >
        <input ref={inputRef} className="outline-filter" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a prompt…" aria-label="Filter prompts" />
        <div className="outline-list">
          {pinned.length > 0 && (
            <>
              <div className="outline-cap">Pinned</div>
              {pinned.map((t) => row(t, true))}
              <div className="outline-cap">All prompts</div>
            </>
          )}
          {rows.map((t) => row(t, false))}
          {rows.length === 0 && <div className="outline-none">{needle ? "No prompt matches." : "No prompts yet."}</div>}
        </div>
      </div>
    </>
  );
}
