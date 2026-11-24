// The reader: each prompt you sent and Claude's reply, laid out for reading.
// The terminal is for typing; this pane is for reading. Each turn shows your
// prompt, the work Claude did (at the chosen level of detail) and the answer.

import { Component, memo, useContext, useMemo, useState } from "react";
import Markdown, { CopyButton } from "../Markdown.jsx";
import DiffView from "../DiffView.jsx";
import Icon from "./icons.jsx";
import { TOOL_CATS, displayColor } from "../filters.js";
import { ReaderActions, AgentName } from "./actions.js";
import { AskCard, WaitCard, ReplyBox, Changes } from "./Panels.jsx";
import {
  DETAIL_LEVELS,
  askFromStep,
  analyzeTurn,
  visibleSteps,
  toolLabel,
  splitPath,
  stripReminders,
  stripAnsi,
  fmtDuration,
  fmtClock,
  plural,
} from "./analyze.js";

const CAT_COLOR = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.color]));
const CAT_LABEL = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.label]));
// Category colour as CSS variables for BOTH themes, so a theme switch restyles
// memoised rows without re-rendering them (reader.css picks --c-d or --c-l).
const catVars = (cat) => {
  const hex = CAT_COLOR[cat] || CAT_COLOR.other;
  return { "--c-d": displayColor(hex, false), "--c-l": displayColor(hex, true) };
};

// ─── detail switch ──────────────────────────────────────────────────────────

export function DetailSwitch({ value, onChange }) {
  // A real radio group: one Tab stop, arrow keys move and select.
  const onKeyDown = (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = DETAIL_LEVELS.findIndex((d) => d.key === value);
    const next = DETAIL_LEVELS[(i + step + DETAIL_LEVELS.length) % DETAIL_LEVELS.length];
    onChange(next.key);
    e.currentTarget.querySelector(`[data-key="${next.key}"]`)?.focus();
  };
  return (
    <div className="detail-switch" role="radiogroup" aria-label="Level of detail" onKeyDown={onKeyDown}>
      {DETAIL_LEVELS.map((d) => (
        <button
          key={d.key}
          data-key={d.key}
          role="radio"
          aria-checked={value === d.key}
          tabIndex={value === d.key ? 0 : -1}
          className={value === d.key ? "on" : ""}
          title={d.hint}
          onClick={() => onChange(d.key)}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}

// ─── steps ──────────────────────────────────────────────────────────────────

const OUTPUT_CLAMP = 14;

// Make a path relative to the session folder: "D:\dev\app\src\a.js" → "src\a.js".
function relativeTo(t, root) {
  if (!root || t.length <= root.length) return t;
  const r = root.replace(/[\\/]+$/, "");
  const head = t.slice(0, r.length);
  if (head.replace(/\//g, "\\").toLowerCase() === r.replace(/\//g, "\\").toLowerCase() && /[\\/]/.test(t[r.length] || "")) {
    return t.slice(r.length + 1);
  }
  return t;
}

function Target({ text, shell, root }) {
  let t = relativeTo((text || "").replace(/\s+/g, " ").trim(), root);
  // "cd /some/project && npm test" → "npm test": the cd is noise in a log.
  if (shell) t = t.replace(/^(cd|Set-Location|pushd)\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)\s*/i, "");
  if (!t) return null;
  const p = splitPath(t);
  if (p) {
    return (
      <span className="step-target path" title={t}>
        {/* LRMs keep the trailing separator on the right inside the rtl
            (left-ellipsis) box */}
        <span className="dir">{"‎" + p.dir + "‎"}</span>
        <span className="base">{p.base}</span>
      </span>
    );
  }
  if (/^[\w.-]+\.\w{1,8}$/.test(t)) {
    return <span className="step-target path" title={t}><span className="base">{t}</span></span>;
  }
  return <span className="step-target" title={t}>{t}</span>;
}

function Output({ text }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > OUTPUT_CLAMP;
  return (
    <div className={"step-output" + (long && !all ? " clamped" : "")}>
      <pre>{all || !long ? text : lines.slice(0, OUTPUT_CLAMP).join("\n")}</pre>
      {long && (
        <button className="output-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

// One-line result summary; JSON status blobs read as their message.
function oneLine(out) {
  if (out.startsWith("{")) {
    try {
      const j = JSON.parse(out);
      return typeof j.message === "string" ? j.message : "done";
    } catch { /* not JSON */ }
  }
  return out;
}

const ToolStep = memo(function ToolStep({ s, detail, root, bgTask }) {
  const call = s.call;
  const m = call || s.results[0];
  const cat = m.toolCategory || "other";
  const { name, ns } = toolLabel(call ? call.toolName : m.toolName || "output");
  const out = stripAnsi(stripReminders(s.results.map((r) => r.text || "").join("\n"))).replace(/\s+$/, "");
  const lines = out ? out.split("\n").length : 0;
  const hasDiff = !!call?.editData;
  const actions = useContext(ReaderActions);
  const ask = call?.toolName === "AskUserQuestion" ? askFromStep(s) : null;
  const isAgent = cat === "subagents" && (call?.toolName === "Agent" || call?.toolName === "Task") && !!call?.toolUseId;
  const canOpen = hasDiff || lines > 0 || !!ask;
  const [open, setOpen] = useState(s.failed);
  const showPreview = detail === "all" && !open && lines > 0 && !hasDiff;
  const summary = bgTask
    ? bgTask.done
      ? bgTask.status === "completed" ? "finished in background" : `background: ${bgTask.status}`
      : "running in background"
    : s.failed
    ? "failed"
    : ask
    ? ask.answered ? (ask.questions.map((q) => q.answer).filter(Boolean).join(" · ").slice(0, 48) || "answered") : "waiting for you"
    : hasDiff
    ? call.toolName === "Write" ? "new file" : "edited"
    : lines > 1
    ? plural(lines, "line")
    : lines === 1
    ? oneLine(out).slice(0, 48)
    : s.results.length ? "done" : "running…";
  return (
    <li data-cat={cat} className={"step tool catc" + (s.failed ? " failed" : "") + (open ? " open" : "")} style={catVars(cat)}>
      <span className="step-node">
        <Icon name={s.failed ? "error" : cat} size={12} />
      </span>
      <div className="step-main">
        <button className="step-line" onClick={() => canOpen && setOpen((v) => !v)} disabled={!canOpen} aria-expanded={canOpen ? open : undefined}>
          <span className="step-tool">{name}</span>
          {ns && <span className="step-ns">{ns}</span>}
          {call?.desc
            ? <span className="step-target desc" title={call.desc}>{call.desc}</span>
            : <Target text={call?.text} shell={cat === "shell"} root={root} />}
          {s.repeats && <span className="step-times">×{s.repeats.length}</span>}
          <span className={"step-sum" + (!s.results.length || (bgTask && !bgTask.done) ? " pending" : "")}>
            {bgTask && !bgTask.done && <span className="pulse sm" />}
            {summary}
          </span>
          {canOpen && <Icon name="chevron" size={12} className={"step-chev" + (open ? " open" : "")} />}
        </button>
        {call?.desc && call.text && (
          <div className="step-cmd"><Target text={call.text} shell={cat === "shell"} root={root} /></div>
        )}
        {isAgent && actions.openAgent && (
          <button className="step-open" onClick={() => actions.openAgent(call.toolUseId, call.text)} title="See what this agent did, step by step">
            Open <Icon name="chevron" size={11} />
          </button>
        )}
        {open && ask && <AskCard ask={ask} />}
        {open && hasDiff && (s.repeats || [s]).map((r) => (
          <div key={r.id} className="step-diff"><DiffView editData={r.call.editData} toolName={r.call.toolName} /></div>
        ))}
        {open && !hasDiff && !ask && lines > 0 && <Output text={out} />}
        {showPreview && !ask && (
          <button className="step-preview" onClick={() => setOpen(true)}>
            <pre>{out.split("\n").slice(0, 4).join("\n")}</pre>
          </button>
        )}
      </div>
    </li>
  );
});

function Narration({ m }) {
  return (
    <li className="step narration">
      <span className="step-node quiet"><Icon name="narration" size={11} /></span>
      <div className="step-main"><Markdown className="narr-md">{m.text}</Markdown></div>
    </li>
  );
}

function Thinking({ m }) {
  const [open, setOpen] = useState(false);
  const text = (m.text || "").trim();
  const first = text.split("\n").find((l) => l.trim()) || "";
  return (
    <li className={"step thinking" + (open ? " open" : "")}>
      <span className="step-node quiet"><Icon name="thinking" size={12} /></span>
      <div className="step-main">
        <button className="step-line" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="step-tool think">Reasoning</span>
          {!open && <span className="step-target think">{first}</span>}
          <Icon name="chevron" size={12} className={"step-chev" + (open ? " open" : "")} />
        </button>
        {open && <div className="think-text">{text}</div>}
      </div>
    </li>
  );
}

function Group({ g }) {
  const counts = {};
  for (const it of g.items) counts[it.cat] = (counts[it.cat] || 0) + 1;
  return (
    <li className="step group">
      <span className="step-node quiet dots"><span /><span /><span /></span>
      <div className="step-main group-chips">
        {Object.entries(counts).map(([cat, n]) => (
          <span key={cat} className="group-chip catc" style={catVars(cat)} title={g.items.filter((i) => i.cat === cat).map((i) => (i.call?.toolName || "") + " " + (i.call?.text || "")).join("\n")}>
            <Icon name={cat} size={11} />
            {CAT_LABEL[cat] || cat}{n > 1 ? ` ×${n}` : ""}
          </span>
        ))}
      </div>
    </li>
  );
}

function StepList({ steps, detail, filters, catById, live, root, bgMap }) {
  const shown = useMemo(() => visibleSteps(steps, detail, filters, catById), [steps, detail, filters, catById]);
  if (!shown.length && !live) return null;
  return (
    <ol className="steps">
      {shown.map((s) => {
        switch (s.type) {
          case "tool": return <ToolStep key={s.id} s={s} detail={detail} root={root} bgTask={bgMap?.[s.call?.toolUseId]} />;
          case "narration": return <Narration key={s.id} m={s.m} />;
          case "thinking": return <Thinking key={s.id} m={s.m} />;
          case "group": return <Group key={s.id} g={s} />;
          case "error": return (
            <li key={s.id} className="step tool failed">
              <span className="step-node"><Icon name="error" size={12} /></span>
              <div className="step-main"><div className="step-error">{s.m.text}</div></div>
            </li>
          );
          default: return null;
        }
      })}
      {live && (
        <li className="step live">
          <span className="step-node live"><span className="pulse" /></span>
          <div className="step-main"><span className="shimmer">Working…</span></div>
        </li>
      )}
    </ol>
  );
}

// ─── the work summary (answer mode) ────────────────────────────────────────

// What Claude is doing right now, from the turn's newest step:
// "Editing TerminalPane.jsx", "Running npm test", "Reasoning".
// First non-empty line of some markdown-ish text, de-formatted and trimmed.
function firstLine(text, max) {
  const l = (text || "").split("\n").map((s) => s.trim()).find(Boolean) || "";
  const t = l.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").replace(/:$/, "");
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

function currentActivity(a) {
  const last = a.steps[a.steps.length - 1];
  if (!last) return null;
  if (last.type === "thinking") return "Reasoning";
  // Claude's own words first: the line it wrote between steps, or the
  // description it gave the command, not the raw command.
  if (last.type === "narration") return firstLine(last.m?.text, 90) || null;
  if (last.type !== "tool" || !last.call) return null;
  if (last.call.desc) return firstLine(last.call.desc, 90);
  const { name } = toolLabel(last.call.toolName);
  let target = (last.call.text || "").replace(/\s+/g, " ").trim();
  target = target.replace(/^(cd|Set-Location|pushd)\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)\s*/i, "");
  const p = splitPath(target);
  if (p) target = p.base;
  return target ? `${name} · ${target.slice(0, 64)}` : name;
}

function WorkSummary({ a, live, open, onToggle, activity: fallback }) {
  if (!a.steps.length && !live) return null;
  const activity = live ? currentActivity(a) || fallback : null;
  const parts = [];
  if (a.stepCount) parts.push(plural(a.stepCount, "step"));
  if (a.errorCount) parts.push(plural(a.errorCount, "error"));
  const dur = fmtDuration(a.durationMs);
  return (
    <button className={"work-sum" + (open ? " open" : "") + (live ? " live" : "")} onClick={onToggle} aria-expanded={open} title={(activity ? activity + "\n" : "") + (open ? "Hide the steps" : "Show every step")}>
      <span className="work-ico">{live ? <span className="pulse" /> : <Icon name="layers" size={13} />}</span>
      {live ? (
        <span className="shimmer">{activity ? `Working · ${activity}` : "Working…"}</span>
      ) : (
        <span className="work-lead">{dur ? `Worked for ${dur}` : "Worked"}</span>
      )}
      {parts.length > 0 && <span className="work-meta">{parts.join(" · ")}</span>}
      <Icon name="chevron" size={12} className={"step-chev" + (open ? " open" : "")} />
    </button>
  );
}

// ─── answer ─────────────────────────────────────────────────────────────────

function Answer({ msgs, live, interrupted }) {
  const agent = useContext(AgentName);
  if (!msgs.length) {
    if (live) return null;
    return (
      <div className="answer-empty">
        {interrupted ? `Interrupted before ${agent} replied.` : `No written reply — ${agent} finished after its last step.`}
      </div>
    );
  }
  const asks = msgs[msgs.length - 1]?.kind === "question";
  return (
    <div className={"answer" + (asks ? " asks" : "")}>
      {asks && <div className="answer-flag"><Icon name="ask-user" size={13} /> {agent} is asking you</div>}
      {msgs.map((m) =>
        m.kind === "error" ? (
          <div key={m.id} className="answer-error"><Icon name="error" size={14} /> {m.text}</div>
        ) : m.kind === "plan" ? (
          <div key={m.id} className="answer-plan">
            <div className="answer-plan-cap"><Icon name="plan" size={13} /> Plan</div>
            <Markdown className="answer-md">{m.text}</Markdown>
          </div>
        ) : (
          <Markdown key={m.id} className="answer-md">{m.text}</Markdown>
        )
      )}
    </div>
  );
}

// ─── a turn ─────────────────────────────────────────────────────────────────

const PROMPT_CLAMP = 360;

function Prompt({ t }) {
  const [full, setFull] = useState(false);
  const long = (t.prompt || "").length > PROMPT_CLAMP;
  const text = long && !full ? t.prompt.slice(0, PROMPT_CLAMP).replace(/\s+\S*$/, "") + "…" : t.prompt;
  return (
    <div className={"prompt" + (t.isCommand ? " cmd" : "") + (t.isNotif ? " notif" : "")}>
      {text}
      {long && (
        <button className="prompt-more" onClick={(e) => { e.stopPropagation(); setFull((v) => !v); }}>
          {full ? "Show less" : "Show full prompt"}
        </button>
      )}
    </div>
  );
}

// One malformed transcript entry shouldn't blank the app: contain it to its turn.
class TurnBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <article className="turn closed">
        <div className="turn-row"><span className="turn-row-prompt meta">This turn couldn't be displayed.</span></div>
      </article>
    );
  }
}

export const Turn = memo(function Turn(props) {
  return <TurnBoundary><TurnView {...props} /></TurnBoundary>;
});

const TurnView = memo(function TurnView({ t, expanded, live, detail, filters, catById, onToggle, matchCount = 0, activity, root, bgMap, latest = false, waiting = false, waitingSure = false, pinned = false, whoLabel }) {
  const agentName = useContext(AgentName);
  const a = useMemo(() => analyzeTurn(t), [t, t.responses.length]);
  const actions = useContext(ReaderActions);
  // Questions already answered in this turn: in Answer mode the steps are
  // folded away, so the reader still shows what was asked and what you said.
  const answeredAsks = useMemo(
    () => a.steps.filter((s) => s.type === "tool" && s.call?.toolName === "AskUserQuestion" && s.results.length).map(askFromStep).filter(Boolean),
    [a.steps]
  );
  const lastStep = a.steps[a.steps.length - 1];
  const stuckStep = latest && waiting && !a.pendingAsk && lastStep?.type === "tool" && lastStep.call && !lastStep.results.length ? lastStep : null;
  const lastAnswer = a.answer[a.answer.length - 1];
  const asksInProse = latest && !live && lastAnswer?.kind === "question";
  const planWaiting = latest && !live && lastAnswer?.kind === "plan";
  const [stepsOpen, setStepsOpen] = useState(null); // per-turn override in Answer mode
  const showSteps = detail !== "answer" || (stepsOpen ?? false);
  const clock = fmtClock(t.at);
  const dur = fmtDuration(a.durationMs);
  const who = whoLabel || (t.isNotif ? "Background task" : t.isCommand ? "Command" : "You");
  const replyText = a.answer.filter((m) => m.kind !== "error").map((m) => m.text).join("\n\n");

  if (!expanded) {
    return (
      <article data-turn={t.id} className={"turn closed" + (live ? " live" : "")}>
        <button className="turn-row turn-toggle" onClick={() => onToggle(t.id)} title={t.prompt} aria-expanded="false">
          <Icon name="chevron" size={12} className="turn-chev" />
          {pinned && <Icon name="pin" size={11} className="turn-pin-mark" />}
          <span className={"turn-row-prompt" + (t.isCommand || t.isNotif ? " meta" : "")}>{t.prompt}</span>
          {matchCount > 0 && <span className="match-pill">{plural(matchCount, "match", "matches")}</span>}
          {live ? <span className="live-pill"><span className="pulse" />live</span> : (
            <span className="turn-row-meta">
              {a.stepCount > 0 && <span>{plural(a.stepCount, "step")}</span>}
              {dur && <span>{dur}</span>}
              {clock && <time>{clock}</time>}
            </span>
          )}
        </button>
      </article>
    );
  }

  return (
    <article data-turn={t.id} className={"turn open" + (live ? " live" : "")}>
      {/* The whole header collapses on click (unless you're selecting text);
          the chevron is the real, keyboard-reachable button. */}
      <header className="turn-head" onClick={() => { if (!window.getSelection()?.toString()) onToggle(t.id); }}>
        <div className="turn-eyebrow">
          <span className="who"><Icon name={t.isNotif ? "bolt" : t.isCommand ? "shell" : "user"} size={12} />{who}</span>
          {t.midTurn && <span className="who-tag" title={`You sent this while ${agentName} was still working. ${agentName} picked it up inside the same run.`}>sent while {agentName} was working</span>}
          {clock && <time>{clock}</time>}
          {t.interrupted && <span className="tag warn">interrupted</span>}
          {matchCount > 0 && <span className="match-pill">{plural(matchCount, "match", "matches")}</span>}
          <span className="spacer" />
          {live && <span className="live-pill"><span className="pulse" />live</span>}
          {!live && replyText && <CopyButton getText={() => replyText} label="Copy reply" className="eyebrow-copy" />}
          {actions.togglePin && !t.isNotif && t.id !== "__start" && (
            <button
              className={"turn-pin" + (pinned ? " on" : "")}
              aria-pressed={pinned}
              aria-label={pinned ? "Unpin this turn" : "Pin this turn"}
              title={pinned ? "Unpin" : "Pin — find it again from the outline"}
              onClick={(e) => { e.stopPropagation(); actions.togglePin(t); }}
            >
              <Icon name="pin" size={12} />
            </button>
          )}
          <button
            className="turn-collapse turn-toggle"
            aria-expanded="true"
            aria-label="Collapse turn"
            title="Collapse"
            onClick={(e) => { e.stopPropagation(); onToggle(t.id); }}
          >
            <Icon name="chevron" size={12} className="turn-chev open" />
          </button>
        </div>
        {!t.isNotif && <Prompt t={t} />}
      </header>
      <div className="turn-body">
        {detail === "answer" && (
          <WorkSummary a={a} live={live && !a.answer.length && !a.pendingAsk} open={showSteps} activity={activity} onToggle={() => setStepsOpen(!showSteps)} />
        )}
        {showSteps && (
          <StepList steps={a.steps} detail={detail === "answer" ? "steps" : detail} filters={filters} catById={catById} live={live && detail !== "answer"} root={root} bgMap={bgMap} />
        )}
        {detail === "answer" && !showSteps && answeredAsks.map((k) => <AskCard key={k.toolUseId} ask={k} compact />)}
        {a.pendingAsk ? (
          <AskCard ask={a.pendingAsk} canAct={latest} />
        ) : (
          <Answer msgs={a.answer} live={live || !!stuckStep} interrupted={t.interrupted} />
        )}
        {stuckStep && <WaitCard key={stuckStep.id} step={stuckStep} sure={waitingSure} />}
        {planWaiting && actions.focusTerminal && (
          <div className="ask-foot plan-foot">
            <span className="ask-note">Approve this plan, or ask for changes, in the terminal.</span>
            <button className="mini-btn" onClick={() => actions.focusTerminal()}><Icon name="shell" size={12} /> Go to terminal</button>
          </div>
        )}
        {asksInProse && <ReplyBox />}
        <Changes steps={a.steps} root={root} />
      </div>
    </article>
  );
});

// ─── background work ────────────────────────────────────────────────────────

// Sticks to the bottom of the reader while agents / background commands that
// Claude started are still running: the transcript is quiet then, but the
// session isn't idle. Click a chip to jump to the step that launched it.
export function BackgroundStrip({ tasks, onJump }) {
  if (!tasks.length) return null;
  const agents = tasks.filter((t) => t.kind === "agent").length;
  const other = tasks.length - agents;
  const parts = [];
  if (agents) parts.push(`${agents} ${agents === 1 ? "agent" : "agents"}`);
  if (other) parts.push(`${other} background ${other === 1 ? "task" : "tasks"}`);
  return (
    <div className="bg-strip" role="status">
      <span className="bg-lead">
        <span className="pulse" />
        <span className="shimmer">{parts.join(" and ")} running</span>
      </span>
      <span className="bg-chips">
        {tasks.slice(-3).map((t) => (
          <button key={t.toolUseId} className="bg-chip" title={`${t.tool}: ${t.label}`} onClick={() => onJump?.(t.toolUseId)}>
            <Icon name={t.kind === "agent" ? "subagents" : "shell"} size={11} />
            <span>{t.label}</span>
          </button>
        ))}
        {tasks.length > 3 && <span className="bg-more">+{tasks.length - 3}</span>}
      </span>
    </div>
  );
}

// ─── a subagent's feed (inside the agent panel) ─────────────────────────────

const NO_ACTIONS = {};

// The agent's own transcript, drawn with the same turns as the main reader.
// Read-only: no pinning or replying to a subagent.
export function AgentFeed({ turns, live, detail, filters, root }) {
  const [over, setOver] = useState({});
  const catById = useMemo(() => {
    const map = {};
    for (const t of turns) for (const m of t.responses) if (m.kind === "toolcall" && m.toolUseId) map[m.toolUseId] = m.toolCategory || "other";
    return map;
  }, [turns]);
  return (
    <ReaderActions.Provider value={NO_ACTIONS}>
      {turns.map((t, i) => (
        <Turn
          key={t.id}
          t={t}
          expanded={over[t.id] ?? true}
          live={live && i === turns.length - 1}
          detail={detail}
          filters={filters}
          catById={catById}
          root={root}
          whoLabel={i === 0 ? "Claude's brief to the agent" : "Follow-up"}
          onToggle={(id) => setOver((o) => ({ ...o, [id]: !(o[id] ?? true) }))}
        />
      ))}
    </ReaderActions.Provider>
  );
}
