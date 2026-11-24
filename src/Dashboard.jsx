import { useEffect, useMemo, useState } from "react";
import { TOOL_CATS, baseNameOf, normRoot, projectColor, tabDisplayName } from "./filters.js";
import { agentInfo, agentOf } from "./agents.js";
import StatusGlyph, { glyphKind } from "./StatusGlyph.jsx";

// Mission Control — a live fleet view over every open session. Everything here
// renders from the backend's `get_dashboard` snapshot (tailer cache, no file
// I/O) plus the same busy/attention signals the tab bar already uses.

const CAT_LABEL = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.label]));

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n || 0);
}

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

// "just now", "42s ago", "3m ago", "1h 12m ago"
function relTime(ms, now) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function fmtDur(ms) {
  if (!ms || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Published per-MTok pricing; cache reads bill at 0.1× input, writes at 1.25×.
// Unknown models are excluded and flagged so the estimate never lies silently.
const PRICES = [
  { key: "opus", inTok: 15, outTok: 75 },
  { key: "sonnet", inTok: 3, outTok: 15 },
  { key: "haiku", inTok: 1, outTok: 5 },
];
export function estCost(models) {
  let usd = 0;
  let unknown = false;
  for (const [id, u] of Object.entries(models || {})) {
    const p = PRICES.find((p) => id.includes(p.key));
    if (!p) {
      if ((u.input || 0) + (u.output || 0) > 0) unknown = true;
      continue;
    }
    usd +=
      ((u.input || 0) * p.inTok +
        (u.output || 0) * p.outTok +
        (u.cacheRead || 0) * p.inTok * 0.1 +
        (u.cacheCreation || 0) * p.inTok * 1.25) /
      1e6;
  }
  return { usd, unknown };
}
export function fmtCost({ usd, unknown }) {
  if (usd <= 0) return unknown ? "?" : "$0";
  const s = usd >= 10 ? `$${usd.toFixed(0)}` : usd >= 0.1 ? `$${usd.toFixed(2)}` : "<$0.10";
  return `~${s}${unknown ? "+" : ""}`;
}

// Transcripts don't say which window a session runs with; a context already
// past 200k can only be the 1M one.
export function ctxWindowFor(model, used = 0, known = 0) {
  if (known > 0) return known; // Codex reports its window
  return (model && model.includes("[1m]")) || used > 200_000 ? 1_000_000 : 200_000;
}
function shortModel(m) {
  return (m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
}


/** Sessions launched with --dangerously-skip-permissions can never be waiting
 *  on an approval prompt — there aren't any. */
export function sessionFullAutonomy(t) {
  return !!t?.command && (t.command.includes("--dangerously-skip-permissions") || t.command.includes("--dangerously-bypass-approvals-and-sandbox"));
}

// Status derivation, shared by the tab bar, the fleet chip and Mission
// Control so they can never disagree. Streaming = working — but a QUIET
// stream is not automatically "needs you":
//   - last entry a thinking block → mid-response, still working;
//   - last entry a tool call with no result → the tool is most likely still
//     RUNNING. It only degrades to "waiting?" after a grace window — and in a
//     full-autonomy session never does (no approval prompts exist), though a
//     very stale one falls back to idle (an interrupted run, most likely).
// What the bottom of a session's terminal says Claude Code is doing:
// "prompt" (a permission prompt is showing), "running" (its timer/spinner is
// ticking, so a step is in flight), or null when it can't tell.
export function readScreen(text) {
  if (!text) return null;
  if (/Do you want to\b[^\n]*\?/i.test(text) && /(^|\n)[\s│❯>]*1\.\s+Yes\b/.test(text)) return "prompt";
  // Codex's approval questions (codex-rs/tui approval_overlay).
  if (/Would you like to (run the following command|make the following edits|grant these permissions)\?|Do you want to approve network access/i.test(text)) return "prompt";
  if (/esc to interrupt|ctrl\+b to run in background|…\s*\(\d+(m \d+)?s\b/i.test(text)) return "running";
  return null;
}

export function statusFor(s, busy, ready, opts = {}) {
  // Hints name the session's own agent.
  const name = agentInfo(opts.agent || "claude").short;
  const r = statusCore(s, busy, ready, opts);
  return name === "Claude" ? r : { ...r, hint: r.hint.replace(/Claude/g, name) };
}

function statusCore(s, busy, ready, opts) {
  const { fullAutonomy = false, now = Date.now(), background = 0, screen = null, agent = "claude" } = opts;
  // A permission prompt on screen is certain, whatever the transcript says.
  if (screen === "prompt")
    return { key: "attention", label: "needs approval", hint: "The terminal is showing a permission prompt — Claude is waiting for your answer" };
  if (busy) return { key: "working", label: "working", hint: "Streaming new activity right now" };
  // A subagent mid-run (its Task call has no result yet): the main transcript
  // is quiet, but Claude is working, not waiting on you.
  if (s?.agents?.some((a) => !a.done))
    return { key: "working", label: "agent running", hint: "A subagent is working on part of this turn" };
  // A new Codex session has no file until its first prompt is sent.
  if (agent === "codex" && !ready) return { key: "idle", label: "ready", hint: "Waiting for your first prompt" };
  if (!ready || !s || !s.lastTsMs) return { key: "idle", label: "starting…", hint: "No transcript activity yet" };
  // Codex logs when each turn starts and ends, so its state is known exactly.
  if (s.turnOpen === true) {
    if (screen === "running" || now - s.lastTsMs < 30 * 60_000)
      return { key: "working", label: s.lastKind === "toolcall" ? "running tool" : "working", hint: "Codex is working on this turn" };
    return { key: "idle", label: "idle", hint: "A turn never finished — the session may have been interrupted" };
  }
  if (s.turnOpen === false) {
    if (s.lastKind === "question") return { key: "attention", label: "asked you", hint: "Codex's last message is a question for you" };
    return { key: "idle", label: "idle", hint: "Waiting for your next prompt" };
  }
  const quiet = now - s.lastTsMs;
  if (s.lastKind === "thinking" && quiet < 120_000)
    return { key: "working", label: "thinking", hint: "Mid-response — the last transcript entry is a thinking block" };
  // Between a tool result (or a fresh prompt) and the next assistant entry the
  // model is computing — the transcript is quiet but the session is mid-turn,
  // not idle. Generous window: extended thinking stretches these gaps.
  if ((s.lastKind === "toolresult" || s.lastKind === "user") && quiet < 180_000)
    return { key: "working", label: "working", hint: "Mid-turn — Claude is composing its next step" };
  if (s.lastKind === "toolcall") {
    // A multiple-choice question is waiting on you from the moment it is asked
    // (in every mode: full autonomy skips approvals, not questions).
    if ((s.lastActivity || "").replace(/^⑂ /, "").startsWith("AskUserQuestion"))
      return { key: "attention", label: "asked you", hint: "Claude asked you a question and is waiting for your answer" };
    // The terminal shows the step's timer still running: it is working, however
    // long it takes. (A slow build is not a question.)
    if (screen === "running")
      return { key: "working", label: "running tool", hint: "A step is still running — its timer is ticking in the terminal" };
    if (fullAutonomy) {
      if (quiet < 30 * 60_000)
        return { key: "working", label: "running tool", hint: "A tool call is in flight — this session runs with full autonomy, so nothing can be waiting on an approval" };
      return { key: "idle", label: "idle", hint: "A tool call never returned — the session may have been interrupted" };
    }
    if (quiet < 45_000)
      return { key: "working", label: "running tool", hint: "A tool call is in flight — if it stays quiet much longer it may be waiting for your approval" };
    return { key: "attention", label: "waiting?", hint: "A tool call has had no result for a while — Claude may be waiting for an approval in the terminal" };
  }
  if (s.lastKind === "question")
    return { key: "attention", label: "asked you", hint: "Claude's last message is a question for you" };
  if (s.lastKind === "plan")
    return { key: "attention", label: "plan ready", hint: "A plan is awaiting your approval" };
  if (background > 0)
    return { key: "working", label: background === 1 ? "1 in background" : `${background} in background`, hint: "Agents or commands Claude started are still running in the background" };
  return { key: "idle", label: "idle", hint: "Waiting for your next prompt" };
}

const KIND_GLYPH = {
  user: "❯",
  message: "◆",
  question: "?",
  thinking: "…",
  toolcall: "▸",
  toolresult: "✓",
  error: "✗",
  plan: "▤",
};

// Events-per-minute sparkline over the last 15 minutes; newest bar highlighted.
function Spark({ events, now }) {
  const BINS = 15;
  const bins = new Array(BINS).fill(0);
  for (const ts of events || []) {
    const age = Math.floor((now - ts) / 60000);
    if (age >= 0 && age < BINS) bins[BINS - 1 - age]++;
  }
  const max = Math.max(1, ...bins);
  return (
    <svg className="dash-spark" viewBox={`0 0 ${BINS * 5} 20`} preserveAspectRatio="none" aria-hidden>
      {bins.map((v, i) => {
        const h = v === 0 ? 1.5 : 3 + (v / max) * 16;
        const cls = v === 0 ? "z" : i === BINS - 1 ? "hot" : "";
        return <rect key={i} x={i * 5 + 0.75} y={20 - h} width={3.5} height={h} rx={1} className={cls} />;
      })}
    </svg>
  );
}

// Horizontal gauge with a green→gold→red tier by percentage.
function Gauge({ pct, label, sub, title }) {
  const p = Math.min(100, Math.max(0, pct || 0));
  const tier = p >= 90 ? "red" : p >= 70 ? "orange" : p >= 50 ? "gold" : "";
  return (
    <div className="dash-gauge" title={title}>
      <div className="dash-gauge-top">
        <span>{label}</span>
        <span className="dash-gauge-sub">{sub}</span>
      </div>
      <div className={"dash-bar " + tier}>
        <span style={{ width: p + "%" }} />
      </div>
    </div>
  );
}

// The plan, compressed to what you'd act on: one progress line, the step in
// flight, and at most two queued steps. The full list lives in the session.
function PlanRow({ todos }) {
  if (!todos || todos.length === 0) return null;
  const done = todos.filter((x) => x.status === "completed").length;
  const active = todos.find((x) => x.status === "in_progress");
  const pending = todos.filter((x) => x.status === "pending");
  return (
    <div className="dash-plan">
      <div className="dash-plan-head">
        <span className="dash-sec-label">PLAN</span>
        <div className="dash-bar slim dash-plan-bar">
          <span style={{ width: (done / todos.length) * 100 + "%" }} />
        </div>
        <span className="dash-plan-count">{done}/{todos.length}</span>
      </div>
      {active && (
        <div className="dash-plan-item doing">
          <span className="dash-todo-ico">►</span>
          <span className="dash-todo-text">{active.activeForm || active.content}</span>
        </div>
      )}
      {pending.slice(0, 2).map((x, i) => (
        <div key={i} className="dash-plan-item">
          <span className="dash-todo-ico">○</span>
          <span className="dash-todo-text">{x.content}</span>
        </div>
      ))}
      {pending.length > 2 && <div className="dash-plan-more">＋{pending.length - 2} queued</div>}
    </div>
  );
}

/**
 * Session card, redesigned around one idea per zone, top to bottom:
 * identity → what it's doing right now → the plan → live agents →
 * labelled vitals → a quiet footer. Everything secondary moved into
 * tooltips (cwd on the name, category mix on the tools count, cost detail
 * on the tokens stat) so the card reads in one pass.
 */
function SessionCard({ t, sess, busy, now, color, onJump, screenFor }) {
  const s = sess?.stats;
  const usage = sess?.usage;
  const st = statusFor(s, busy, sess?.ready, { fullAutonomy: sessionFullAutonomy(t), now, screen: screenFor?.(t.id), agent: agentOf(t) });
  // Codex runs on a ChatGPT plan; there's no per-token price to estimate.
  const cost = agentOf(t) === "codex" ? { usd: 0, unknown: (usage?.input || 0) + (usage?.output || 0) > 0 } : estCost(s?.models);
  const ctx = s?.contextTokens || 0;
  const win = ctxWindowFor(s?.lastModel, ctx, s?.contextWindow);
  const ctxPct = Math.min(100, Math.round((ctx / win) * 100));
  const ctxTier = ctxPct >= 90 ? "red" : ctxPct >= 70 ? "orange" : ctxPct >= 50 ? "gold" : "";
  const inTok = (usage?.input || 0) + (usage?.cacheCreation || 0);
  const outTok = usage?.output || 0;
  const activeAgents = (s?.agents || []).filter((a) => !a.done);
  const catTip = Object.entries(s?.byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${CAT_LABEL[k] || k}: ${n}`)
    .join("\n");
  return (
    <div
      className={"dash-card " + st.key}
      style={color ? { borderLeft: `3px solid ${color}` } : undefined}
      onClick={() => onJump(t.id)}
      title="Open this session"
    >
      <div className="dash-card-head">
        <span className="dash-card-name" title={t.cwd}>{tabDisplayName(t)}</span>
        {t.branch && <span className="dash-chip branch" title={`Worktree branch ${t.branch}`}>⌥ {t.branch.replace(/^(hvcode|synapse2)\//, "")}</span>}
        {s?.lastModel && <span className="dash-chip model">{shortModel(s.lastModel)}</span>}
        <span className={"dash-status-pill " + st.key + " k-" + glyphKind(st, { lastKind: s?.lastKind })} title={st.hint}>
          <StatusGlyph kind={glyphKind(st, { lastKind: s?.lastKind })} size={13} />
          {st.label}
        </span>
      </div>

      <div className="dash-now" title={s?.lastActivity || ""}>
        <span className="dash-now-glyph">{KIND_GLYPH[s?.lastKind] || "·"}</span>
        <span className="dash-now-text">{s?.lastActivity || "no activity yet — type a prompt in its terminal"}</span>
        <span className="dash-now-when">{relTime(s?.lastTsMs, now)}</span>
      </div>

      <PlanRow todos={s?.todos} />

      {activeAgents.length > 0 && (
        <div className="dash-agents">
          <span className="dash-sec-label">AGENTS</span>
          {activeAgents.map((a) => (
            <span key={a.id} className="dash-agent live" title={`${a.agentType || "subagent"} — running ${fmtDur(now - a.startedMs)}`}>
              <span className="dash-agent-dot" />{a.name}
            </span>
          ))}
        </div>
      )}

      <div className="dash-vitals">
        <div className="dash-vital" title="How full the context window is (last response's input + cache tokens)">
          <span className="dash-sec-label">CONTEXT</span>
          <div className={"dash-bar " + ctxTier}>
            <span style={{ width: ctxPct + "%" }} />
          </div>
          <span className="dash-vital-num">{ctx ? `${ctxPct}%` : "—"}</span>
        </div>
        <div className="dash-vital" title={`Input ${fmtTokens(inTok)} · Output ${fmtTokens(outTok)}\nCost is an estimate from published per-model pricing`}>
          <span className="dash-sec-label">TOKENS</span>
          <span className="dash-vital-num">⇣ {fmtTokens(inTok)} · ⇡ {fmtTokens(outTok)}</span>
          <span className="dash-vital-cost">{fmtCost(cost)}</span>
        </div>
      </div>

      <div className="dash-foot">
        <span title="Prompts you've sent">{s?.turns || 0} turns</span>
        <span title={catTip ? `Tool calls by kind:\n${catTip}` : "Tool calls"}>
          {s?.toolCalls || 0}{s?.sidechainCalls ? `+${s.sidechainCalls}` : ""} tools
        </span>
        {(s?.files?.length || 0) > 0 && (
          <span title={"Files touched:\n" + s.files.slice(0, 14).join("\n") + (s.files.length > 14 ? "\n…" : "")}>
            {s.files.length} files
          </span>
        )}
        {(s?.toolErrors || 0) > 0 && <span className="err" title="Failed tool calls">{s.toolErrors} errors</span>}
        <Spark events={s?.recentEvents} now={now} />
      </div>
    </div>
  );
}

function LimitTile({ icon, label, win }) {
  if (!win || win.used_percentage == null) {
    return (
      <div className="dash-tile">
        <div className="dash-tile-num muted">—</div>
        <div className="dash-tile-label">{icon} {label}</div>
      </div>
    );
  }
  const pct = Math.min(100, Math.round(win.used_percentage));
  return (
    <div className="dash-tile" title={`Resets ${new Date((win.resets_at || 0) * 1000).toLocaleString()}`}>
      <div className="dash-tile-num">{pct}%</div>
      <div className="dash-tile-label">{icon} {label} · resets {fmtReset(win.resets_at)}</div>
      <Gauge pct={pct} label="" sub="" />
    </div>
  );
}

export default function Dashboard({ tabs, dash, busyById, rateLimits, onJump, onClose, screenFor }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sessions = dash?.sessions || {};
  const rows = useMemo(
    () => tabs.map((t) => ({ t, sess: sessions[t.sessionId], busy: !!busyById[t.id] })),
    [tabs, sessions, busyById]
  );
  // Cluster sessions by project root (first-appearance order) so same-folder
  // sessions render together under one header.
  const groups = useMemo(() => {
    const by = new Map();
    for (const r of rows) {
      const key = normRoot(r.t.root || r.t.cwd);
      if (!by.has(key)) by.set(key, { key, root: r.t.root || r.t.cwd, rows: [] });
      by.get(key).rows.push(r);
    }
    return [...by.values()];
  }, [rows]);
  const working = rows.filter((r) => statusFor(r.sess?.stats, r.busy, r.sess?.ready, { fullAutonomy: sessionFullAutonomy(r.t), now, screen: screenFor?.(r.t.id), agent: agentOf(r.t) }).key === "working");
  const attention = rows.filter((r) => statusFor(r.sess?.stats, r.busy, r.sess?.ready, { fullAutonomy: sessionFullAutonomy(r.t), now, screen: screenFor?.(r.t.id), agent: agentOf(r.t) }).key === "attention");
  const agentsLive = rows.reduce((a, r) => a + (r.sess?.stats?.agents || []).filter((x) => !x.done).length, 0);
  const totals = rows.reduce(
    (acc, r) => {
      const u = r.sess?.usage || {};
      acc.inTok += (u.input || 0) + (u.cacheCreation || 0);
      acc.outTok += u.output || 0;
      const c = agentOf(r.t) === "codex" ? { usd: 0, unknown: (u.input || 0) + (u.output || 0) > 0 } : estCost(r.sess?.stats?.models);
      acc.usd += c.usd;
      acc.unknown = acc.unknown || c.unknown;
      return acc;
    },
    { inTok: 0, outTok: 0, usd: 0, unknown: false }
  );

  return (
    <div className="dash-overlay" onClick={onClose}>
      <div className="dash" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="dash-head">
          <div className="dash-title"><span className="logo-mark">◆</span> Mission Control</div>
          <div className="dash-sub">{tabs.length} session{tabs.length === 1 ? "" : "s"} · live</div>
          <button className="tab-x" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="dash-strip">
          <div className="dash-tile">
            <div className="dash-tile-num">{tabs.length}</div>
            <div className="dash-tile-label">sessions</div>
          </div>
          <div className="dash-tile">
            <div className={"dash-tile-num" + (working.length ? " ok" : " muted")}>{working.length}</div>
            <div className="dash-tile-label">working</div>
          </div>
          <div className="dash-tile">
            <div className={"dash-tile-num" + (attention.length ? " warn" : " muted")}>{attention.length}</div>
            <div className="dash-tile-label">need you</div>
          </div>
          <div className="dash-tile">
            <div className={"dash-tile-num" + (agentsLive ? " ok" : " muted")}>{agentsLive}</div>
            <div className="dash-tile-label">agents live</div>
          </div>
          <div className="dash-tile" title="Sum across open sessions (input incl. cache writes / output)">
            <div className="dash-tile-num">{fmtTokens(totals.inTok)}<span className="dash-tile-dim"> in</span> {fmtTokens(totals.outTok)}<span className="dash-tile-dim"> out</span></div>
            <div className="dash-tile-label">tokens · {fmtCost(totals)}</div>
          </div>
          <LimitTile icon="⏱" label="5h window" win={rateLimits?.rateLimits?.five_hour} />
          <LimitTile icon="📅" label="week" win={rateLimits?.rateLimits?.seven_day} />
        </div>

        {attention.length > 0 && (
          <div className="dash-attn">
            {attention.map(({ t, sess, busy }) => {
              const st = statusFor(sess?.stats, busy, sess?.ready, { fullAutonomy: sessionFullAutonomy(t), now, screen: screenFor?.(t.id), agent: agentOf(t) });
              return (
                <button key={t.id} className="dash-attn-row" onClick={() => onJump(t.id)}>
                  <StatusGlyph kind={glyphKind(st, { lastKind: sess?.stats?.lastKind })} size={13} />
                  <b>{tabDisplayName(t)}</b>
                  <span className="dash-attn-why">{st.hint}</span>
                  <span className="dash-attn-go">go →</span>
                </button>
              );
            })}
          </div>
        )}

        {tabs.length === 0 ? (
          <div className="dash-empty">No sessions running — start one and the fleet appears here.</div>
        ) : (
          groups.map((g) => {
            const color = projectColor(g.root);
            const gWork = g.rows.filter((r) => statusFor(r.sess?.stats, r.busy, r.sess?.ready, { fullAutonomy: sessionFullAutonomy(r.t), now, screen: screenFor?.(r.t.id), agent: agentOf(r.t) }).key === "working").length;
            const gNeed = g.rows.filter((r) => statusFor(r.sess?.stats, r.busy, r.sess?.ready, { fullAutonomy: sessionFullAutonomy(r.t), now, screen: screenFor?.(r.t.id), agent: agentOf(r.t) }).key === "attention").length;
            const gTot = g.rows.reduce(
              (acc, r) => {
                const u = r.sess?.usage || {};
                acc.inTok += (u.input || 0) + (u.cacheCreation || 0);
                acc.outTok += u.output || 0;
                const c = agentOf(r.t) === "codex" ? { usd: 0, unknown: (u.input || 0) + (u.output || 0) > 0 } : estCost(r.sess?.stats?.models);
                acc.usd += c.usd;
                acc.unknown = acc.unknown || c.unknown;
                return acc;
              },
              { inTok: 0, outTok: 0, usd: 0, unknown: false }
            );
            return (
              <div key={g.key} className="dash-group">
                {tabs.length > 1 && (
                  <div className="dash-group-head" title={g.root}>
                    <span className="proj-dot" style={{ background: color }} />
                    <b>{baseNameOf(g.root)}</b>
                    <span className="dash-group-stats">
                      {g.rows.length} session{g.rows.length === 1 ? "" : "s"}
                      {gWork > 0 ? ` · ${gWork} working` : ""}
                      {gNeed > 0 ? ` · ${gNeed} need you` : ""}
                      {` · ${fmtTokens(gTot.inTok)} in ${fmtTokens(gTot.outTok)} out · ${fmtCost(gTot)}`}
                    </span>
                  </div>
                )}
                <div className="dash-grid">
                  {g.rows.map(({ t, sess, busy }) => (
                    <SessionCard key={t.id} t={t} sess={sess} busy={busy} now={now} color={color} onJump={onJump} screenFor={screenFor} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
