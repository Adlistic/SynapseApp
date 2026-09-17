import { useEffect, useMemo, useState } from "react";
import { TOOL_CATS, baseNameOf, normRoot, projectColor, tabDisplayName } from "./filters.js";

// Mission Control — a live fleet view over every open session. Everything here
// renders from the backend's `get_dashboard` snapshot (tailer cache, no file
// I/O) plus the same busy/attention signals the tab bar already uses.

const CAT_COLOR = Object.fromEntries(TOOL_CATS.map((c) => [c.key, c.color]));
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
function estCost(models) {
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
function fmtCost({ usd, unknown }) {
  if (usd <= 0) return unknown ? "?" : "$0";
  const s = usd >= 10 ? `$${usd.toFixed(0)}` : usd >= 0.1 ? `$${usd.toFixed(2)}` : "<$0.10";
  return `~${s}${unknown ? "+" : ""}`;
}

export function ctxWindowFor(model) {
  return model && model.includes("[1m]") ? 1_000_000 : 200_000;
}
function shortModel(m) {
  return (m || "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
}


// Status derivation — same heuristic family as the tab-bar dot: streaming =
// working; a quiet stream whose last activity is a tool call / question / plan
// = probably needs the human. Exported so the tab bar shows the same truth.
export function statusFor(s, busy, ready) {
  if (busy) return { key: "working", label: "working", hint: "Streaming new activity right now" };
  if (!ready || !s || !s.lastTsMs) return { key: "idle", label: "starting…", hint: "No transcript activity yet" };
  if (s.lastKind === "toolcall")
    return { key: "attention", label: "waiting?", hint: "Last activity is a tool call with no result — Claude may be waiting for an approval in the terminal" };
  if (s.lastKind === "question")
    return { key: "attention", label: "asked you", hint: "Claude's last message is a question for you" };
  if (s.lastKind === "plan")
    return { key: "attention", label: "plan ready", hint: "A plan is awaiting your approval" };
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

// Stacked tool-category mix bar (main-chain tool calls).
function CatMix({ byCategory }) {
  const entries = Object.entries(byCategory || {}).filter(([, n]) => n > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  if (!total) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return (
    <div className="dash-catmix" title={entries.map(([k, n]) => `${CAT_LABEL[k] || k}: ${n}`).join("\n")}>
      {entries.map(([k, n]) => (
        <span key={k} style={{ width: (n / total) * 100 + "%", background: CAT_COLOR[k] || "#666" }} />
      ))}
    </div>
  );
}

function Todos({ todos }) {
  if (!todos || todos.length === 0) return null;
  const done = todos.filter((x) => x.status === "completed").length;
  const active = todos.filter((x) => x.status === "in_progress");
  const pending = todos.filter((x) => x.status === "pending");
  const shown = [...active, ...pending].slice(0, 4);
  return (
    <div className="dash-todos">
      <div className="dash-todos-head">
        <span className="dash-sec-label">PLAN</span>
        <span className="dash-todos-count">{done}/{todos.length}</span>
      </div>
      <div className="dash-bar slim">
        <span style={{ width: (done / todos.length) * 100 + "%" }} />
      </div>
      <ul>
        {shown.map((x, i) => (
          <li key={i} className={x.status}>
            <span className="dash-todo-ico">{x.status === "in_progress" ? "►" : "○"}</span>
            <span className="dash-todo-text">{x.status === "in_progress" ? (x.activeForm || x.content) : x.content}</span>
          </li>
        ))}
        {active.length + pending.length > 4 && (
          <li className="more">＋{active.length + pending.length - 4} more</li>
        )}
      </ul>
    </div>
  );
}

function Agents({ agents, now }) {
  if (!agents || agents.length === 0) return null;
  const active = agents.filter((a) => !a.done);
  const done = agents.length - active.length;
  return (
    <div className="dash-agents">
      <span className="dash-sec-label">AGENTS</span>
      {active.map((a) => (
        <span key={a.id} className="dash-agent live" title={`${a.agentType || "subagent"} — running ${fmtDur(now - a.startedMs)}`}>
          <span className="dash-agent-dot" />{a.name}
        </span>
      ))}
      {active.length === 0 && <span className="dash-agent-none">none running</span>}
      {done > 0 && <span className="dash-agent-done">{done} finished</span>}
    </div>
  );
}

function SessionCard({ t, sess, busy, now, color, onJump }) {
  const s = sess?.stats;
  const usage = sess?.usage;
  const st = statusFor(s, busy, sess?.ready);
  const cost = estCost(s?.models);
  const ctx = s?.contextTokens || 0;
  const win = ctxWindowFor(s?.lastModel);
  const inTok = (usage?.input || 0) + (usage?.cacheCreation || 0);
  const outTok = usage?.output || 0;
  const activeAgents = (s?.agents || []).filter((a) => !a.done).length;
  const elapsed = s?.firstTsMs ? fmtDur((s.lastTsMs || now) - s.firstTsMs) : "";
  return (
    <div
      className={"dash-card " + st.key}
      style={color ? { borderLeft: `3px solid ${color}` } : undefined}
      onClick={() => onJump(t.id)}
      title="Open this session"
    >
      <div className="dash-card-head">
        <span className={"dash-dot " + st.key} title={st.hint} />
        <span className="dash-card-name">{tabDisplayName(t)}</span>
        {t.branch && <span className="dash-chip branch" title={`Worktree branch ${t.branch}`}>⌥ {t.branch.replace(/^synapse2\//, "")}</span>}
        {s?.lastModel && <span className="dash-chip model">{shortModel(s.lastModel)}</span>}
        <span className={"dash-status " + st.key}>{st.label}</span>
      </div>
      <div className="dash-cwd" title={t.cwd}>{t.cwd}</div>

      <div className="dash-now" title={s?.lastActivity || ""}>
        <span className="dash-now-glyph">{KIND_GLYPH[s?.lastKind] || "·"}</span>
        <span className="dash-now-text">{s?.lastActivity || "no activity yet — type a prompt in its terminal"}</span>
        <span className="dash-now-when">{relTime(s?.lastTsMs, now)}</span>
      </div>

      <Todos todos={s?.todos} />
      <Agents agents={s?.agents} now={now} />

      <div className="dash-meters">
        <Gauge
          pct={(ctx / win) * 100}
          label="context"
          sub={ctx ? `${fmtTokens(ctx)} / ${fmtTokens(win)}` : "—"}
          title="How full the context window is (last response's input + cache tokens)"
        />
        <div className="dash-gauge">
          <div className="dash-gauge-top">
            <span>tokens</span>
            <span className="dash-gauge-sub">{fmtCost(cost)}</span>
          </div>
          <div className="dash-tokens" title={`Input ${fmtTokens(inTok)} · Output ${fmtTokens(outTok)}\nCost is an estimate from published per-model pricing`}>
            <span>⇣ {fmtTokens(inTok)}</span>
            <span>⇡ {fmtTokens(outTok)}</span>
          </div>
        </div>
      </div>

      <CatMix byCategory={s?.byCategory} />

      <div className="dash-foot">
        <span title="Prompts you've sent">{s?.turns || 0} turns</span>
        <span title={`Tool calls${s?.sidechainCalls ? ` (+${s.sidechainCalls} by subagents)` : ""}`}>
          {s?.toolCalls || 0}{s?.sidechainCalls ? `+${s.sidechainCalls}` : ""} tools
        </span>
        {(s?.toolErrors || 0) > 0 && <span className="err" title="Failed tool calls">{s.toolErrors} errors</span>}
        {(s?.files?.length || 0) > 0 && (
          <span title={"Files touched:\n" + s.files.slice(0, 14).join("\n") + (s.files.length > 14 ? "\n…" : "")}>
            {s.files.length} files
          </span>
        )}
        {activeAgents > 0 && <span className="live">{activeAgents} agent{activeAgents > 1 ? "s" : ""} live</span>}
        {elapsed && <span title="From first to latest transcript activity">{elapsed}</span>}
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

export default function Dashboard({ tabs, dash, busyById, rateLimits, onJump, onClose }) {
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
  const working = rows.filter((r) => r.busy);
  const attention = rows.filter((r) => statusFor(r.sess?.stats, r.busy, r.sess?.ready).key === "attention");
  const agentsLive = rows.reduce((a, r) => a + (r.sess?.stats?.agents || []).filter((x) => !x.done).length, 0);
  const totals = rows.reduce(
    (acc, r) => {
      const u = r.sess?.usage || {};
      acc.inTok += (u.input || 0) + (u.cacheCreation || 0);
      acc.outTok += u.output || 0;
      const c = estCost(r.sess?.stats?.models);
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
              const st = statusFor(sess?.stats, busy, sess?.ready);
              return (
                <button key={t.id} className="dash-attn-row" onClick={() => onJump(t.id)}>
                  <span className="dash-dot attention" />
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
            const gWork = g.rows.filter((r) => r.busy).length;
            const gNeed = g.rows.filter((r) => statusFor(r.sess?.stats, r.busy, r.sess?.ready).key === "attention").length;
            const gTot = g.rows.reduce(
              (acc, r) => {
                const u = r.sess?.usage || {};
                acc.inTok += (u.input || 0) + (u.cacheCreation || 0);
                acc.outTok += u.output || 0;
                const c = estCost(r.sess?.stats?.models);
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
                    <SessionCard key={t.id} t={t} sess={sess} busy={busy} now={now} color={color} onJump={onJump} />
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
