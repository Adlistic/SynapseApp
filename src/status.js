import { agentInfo } from "./agents.js";

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
  // The terminal's own timer ("esc to interrupt", "(1m 12s") is ticking: it is
  // working, whatever the transcript last said. The transcript can go quiet for
  // minutes mid-turn: long thinking, or a big file being written (that step is
  // only logged once Claude has written all of it).
  if (screen === "running")
    return { key: "working", label: s?.lastKind === "toolcall" ? "running tool" : "working", hint: "Claude is working: its timer is ticking in the terminal" };
  // A subagent mid-run (its Task call has no result yet): the main transcript
  // is quiet, but Claude is working, not waiting on you.
  if (s?.agents?.some((a) => !a.done))
    return { key: "working", label: "agent running", hint: "A subagent is working on part of this turn" };
  // A new Codex session has no file until its first prompt is sent.
  if (agent === "codex" && !ready) return { key: "idle", label: "ready", hint: "Waiting for your first prompt" };
  if (!ready || !s || !s.lastTsMs) return { key: "idle", label: "starting…", hint: "No transcript activity yet" };
  // Codex logs when each turn starts and ends, so its state is known exactly.
  if (s.turnOpen === true) {
    if (now - s.lastTsMs < 30 * 60_000)
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

