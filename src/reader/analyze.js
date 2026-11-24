// Turn analysis for the reader: splits one prompt's responses into the WORK
// (narration, tool calls + their results, thinking) and the ANSWER (the run of
// prose Claude wrote after its last tool call), plus the facts the turn header
// shows (duration, step count, files changed).

import { diffLines } from "diff";
import { messageDisplay, resolveCategory } from "../filters.js";

export const stripReminders = (s) =>
  (s || "").replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, "").trim();
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s) => (s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const TEXT_KINDS = new Set(["message", "question", "plan"]);
const WORK_KINDS = new Set(["toolcall", "toolresult"]);

// How Claude Code hands the model a prompt typed mid-turn. Only the middle is
// the user's; the rest is an instruction to the model.
const MIDTURN_RE = /^\s*The user sent a new message while you were working:\r?\n([\s\S]*?)(?:\r?\n\s*This is how Claude Code surfaces messages[\s\S]*)?$/;
export function unwrapMidTurn(text) {
  const m = MIDTURN_RE.exec(text || "");
  return m ? { text: m[1].trim(), midTurn: true } : { text: text || "", midTurn: false };
}

const CMD_RE = /^\s*<command-name>([^<]*)<\/command-name>/;
const LOCAL_RE = /^\s*<local-command-(stdout|caveat)>/;

// Group a flat parsed transcript into turns keyed by the user's prompts.
// Claude Code's slash-command bookkeeping (<command-name>…, <local-command-stdout>…)
// is cleaned up: commands become "/name" turns, stdout/caveat blobs fold into
// the current turn instead of starting noise turns of their own.
export function groupTurns(messages) {
  const turns = [];
  let cur = null;
  for (const m of messages) {
    if (m.kind === "user") {
      const un = unwrapMidTurn(m.text || "");
      const midTurn = !!m.midTurn || un.midTurn;
      const text = un.midTurn ? un.text : m.text || "";
      if (LOCAL_RE.test(text)) {
        const body = stripAnsi(text.replace(/<\/?local-command-[a-z-]+>/g, "")).trim();
        if (cur && body) cur.responses.push({ ...m, kind: "toolresult", toolName: "output", text: body });
        continue;
      }
      const cmd = CMD_RE.exec(text);
      const isNotif = /^\s*<task-notification>|^\s*\[SYSTEM NOTIFICATION/i.test(text);
      const cleaned = cmd ? cmd[1].trim() : isNotif ? "" : stripReminders(stripAnsi(text));
      if (!cmd && !isNotif && !cleaned) continue; // pure injection — not a real turn
      if (/^\[Request interrupted by user/.test(cleaned) && cur) {
        cur.interrupted = true;
        continue;
      }
      cur = {
        id: m.id,
        prompt: cmd ? cleaned : isNotif ? notifSummary(text) : cleaned,
        isCommand: !!cmd,
        isNotif,
        midTurn: midTurn && !cmd && !isNotif,
        at: m.at || null,
        responses: [],
      };
      turns.push(cur);
    } else {
      if (!cur) { cur = { id: "__start", prompt: "(session start)", at: m.at || null, responses: [] }; turns.push(cur); }
      cur.responses.push(m);
    }
  }
  return turns;
}

/**
 * Turns of a subagent's own transcript. Claude Code records the brief twice
 * (once bare, once with its context attached) and adds a system "Environment"
 * note; neither is something the agent's reader needs to see twice.
 */
export function agentTurns(messages) {
  const turns = groupTurns(messages.filter((m) => m.role !== "system"));
  return turns.filter((t, i) => !(t.responses.length === 0 && turns[i + 1] && turns[i + 1].prompt === t.prompt));
}

// "<task-notification>…<summary>Agent "Security review" finished</summary>…"
// → 'Agent "Security review" finished'.
function notifSummary(text) {
  const sum = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
  if (!sum) return "Background task finished";
  return sum.length > 160 ? sum.slice(0, 157).replace(/\s+\S*$/, "") + "…" : sum;
}

const BG_LAUNCH = /^(Async agent launched|Command running in background with ID|Monitor started|.*running in the background)/i;

/**
 * Work Claude started in the background: async subagents, background shell
 * commands, monitors. Each launch returns at once ("Async agent launched…"),
 * so the transcript goes quiet while they run; a <task-notification> naming
 * the same tool-use id arrives when one ends. Returns every launch with its
 * state, newest last.
 */
// A launch with no completion after this long is treated as gone: tasks from
// an earlier Claude process (closed terminal, crash) never report back.
export const BG_STALE_MS = 4 * 60 * 60 * 1000;

export function backgroundTasks(messages, now = Date.now()) {
  const calls = {};
  const tasks = new Map();
  const byTaskId = new Map();
  for (const m of messages) {
    if (m.kind === "toolcall" && m.toolUseId) calls[m.toolUseId] = m;
    else if (m.kind === "toolresult" && m.toolUseId && BG_LAUNCH.test((m.text || "").trim())) {
      const call = calls[m.toolUseId];
      tasks.set(m.toolUseId, {
        toolUseId: m.toolUseId,
        kind: call?.toolCategory === "subagents" ? "agent" : "task",
        label: (call?.desc || call?.text || call?.toolName || "Background task").replace(/\s+/g, " ").trim(),
        tool: call?.toolName || "",
        startedAt: m.at || call?.at || null,
        done: false,
        status: "running",
      });
      const tid = /(?:with ID|agentId|task id)[:\s]+([\w-]+)/i.exec(m.text || "")?.[1];
      if (tid) byTaskId.set(tid, m.toolUseId);
    } else if (m.kind === "toolresult" && /stopped task|killed shell|Shell \S+ (?:was )?killed/i.test(m.text || "")) {
      // TaskStop / KillShell: "Successfully stopped task: <id>"
      for (const [tid, useId] of byTaskId) {
        if ((m.text || "").includes(tid)) { const t = tasks.get(useId); if (t) { t.done = true; t.status = "stopped"; } }
      }
    } else if (m.kind === "user" && /<task-notification>/.test(m.text || "")) {
      const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(m.text)?.[1]?.trim();
      const taskId = /<task-id>([^<]+)<\/task-id>/.exec(m.text)?.[1]?.trim();
      const status = /<status>([^<]+)<\/status>/.exec(m.text)?.[1]?.trim() || "completed";
      const t = (id && tasks.get(id)) || (taskId && tasks.get(byTaskId.get(taskId)));
      if (t) { t.done = true; t.status = status; t.endedAt = m.at || null; }
    }
  }
  for (const t of tasks.values()) {
    if (!t.done && t.startedAt && now - t.startedAt > BG_STALE_MS) { t.done = true; t.status = "lost"; }
  }
  return [...tasks.values()];
}

/** Detail levels, least to most. */
export const DETAIL_LEVELS = [
  { key: "answer", label: "Answer", hint: "Just Claude's reply — the work folds into one line" },
  { key: "steps", label: "Steps", hint: "The reply plus every step Claude took, one line each" },
  { key: "all", label: "Everything", hint: "Steps with their output, and Claude's reasoning" },
];

export function analyzeTurn(t) {
  const rs = t.responses;
  // Tool results (and errored results) attach to their call.
  const resultsByUse = {};
  for (const m of rs) {
    if ((m.kind === "toolresult" || m.kind === "error") && m.toolUseId) {
      (resultsByUse[m.toolUseId] = resultsByUse[m.toolUseId] || []).push(m);
    }
  }
  let lastWork = -1;
  rs.forEach((m, i) => {
    if (WORK_KINDS.has(m.kind) || (m.kind === "error" && m.toolUseId)) lastWork = i;
  });

  const steps = [];
  const answer = [];
  const files = new Set();
  let toolCount = 0;
  let errorCount = 0;
  let thinkingCount = 0;
  const paired = new Set();

  rs.forEach((m, i) => {
    if (m.kind === "toolcall") {
      toolCount++;
      const results = (m.toolUseId && resultsByUse[m.toolUseId]) || [];
      results.forEach((r) => paired.add(r.id));
      const failed = results.some((r) => r.isError || r.kind === "error");
      if (failed) errorCount++;
      const fp = m.editData?.file_path || m.editData?.path || m.editData?.notebook_path;
      if (fp) files.add(fp);
      steps.push({ type: "tool", id: m.id, call: m, results, failed });
    } else if (m.kind === "toolresult" || (m.kind === "error" && m.toolUseId)) {
      if (paired.has(m.id)) return;
      steps.push({ type: "tool", id: m.id, call: null, results: [m], failed: m.isError || m.kind === "error" });
    } else if (m.kind === "thinking") {
      thinkingCount++;
      steps.push({ type: "thinking", id: m.id, m });
    } else if (m.kind === "error") {
      errorCount++;
      // A turn-level error is something the reader must always see.
      if (i > lastWork) answer.push(m);
      else steps.push({ type: "error", id: m.id, m });
    } else if (TEXT_KINDS.has(m.kind) || m.kind === "user") {
      if (i > lastWork) answer.push(m);
      else steps.push({ type: "narration", id: m.id, m });
    }
  });

  // The question Claude is waiting on: an AskUserQuestion call that is the
  // turn's newest work and has no result yet.
  const lastStep = steps[steps.length - 1];
  const tail = rs[rs.length - 1];
  const pendingAsk =
    lastStep?.type === "tool" && lastStep.call?.toolName === "AskUserQuestion" && !lastStep.results.length &&
    tail && (tail.id === lastStep.call.id || tail.kind === "thinking")
      ? askFromStep(lastStep)
      : null;
  // Tool calls still waiting for a result. With more than one open, the
  // terminal may be showing a prompt for a different call than the reader's
  // newest one — so no one-key answers then.
  const unresolved = steps.filter((s) => s.type === "tool" && s.call && !s.results.length).length;
  if (pendingAsk && unresolved !== 1) pendingAsk.quick = false;

  const times = rs.map((m) => m.at).filter(Boolean);
  const startAt = t.at || times[0] || null;
  const endAt = times.length ? times[times.length - 1] : null;
  const durationMs = startAt && endAt && endAt > startAt ? endAt - startAt : null;

  return {
    steps,
    answer,
    pendingAsk,
    unresolved,
    files: [...files],
    toolCount,
    errorCount,
    thinkingCount,
    stepCount: steps.filter((s) => s.type !== "thinking").length,
    startAt,
    endAt,
    durationMs,
  };
}

/**
 * An AskUserQuestion step as the reader shows it: each question with its
 * options, plus the user's answers once the result has landed.
 * `quick` = one single-choice question — the only shape that can be answered
 * with one keypress in the terminal.
 */
export function askFromStep(step) {
  // The input is whatever the model wrote; take nothing about its shape on trust.
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const raw = step?.call?.input?.questions;
  const qs = Array.isArray(raw) ? raw.filter(isObj) : [];
  if (!qs.length) return null;
  const resultText = (step.results || []).map((r) => r.text || "").join("\n");
  const questions = qs.map((q) => {
    const question = String(q.question || "");
    let answer = null;
    const key = `"${question}"="`;
    const i = resultText.indexOf(key);
    if (i >= 0) {
      const from = i + key.length;
      const ends = [resultText.indexOf('", "', from), resultText.indexOf('". ', from), resultText.lastIndexOf('"')].filter((e) => e >= from);
      answer = resultText.slice(from, ends.length ? Math.min(...ends) : undefined);
    }
    return {
      question,
      header: String(q.header || ""),
      multiSelect: !!q.multiSelect,
      options: (Array.isArray(q.options) ? q.options : []).filter(isObj).map((o) => ({ label: String(o.label || ""), description: String(o.description || "") })),
      answer,
    };
  });
  return {
    toolUseId: step.call.toolUseId,
    at: step.call.at || null,
    questions,
    answered: (step.results || []).length > 0,
    declined: (step.results || []).some((r) => r.isError || r.kind === "error"),
    quick: questions.length === 1 && !questions[0].multiSelect && questions[0].options.length > 0 && questions[0].options.length <= 9,
  };
}

const lineCount = (v) => {
  if (v == null || v === "") return 0;
  const parts = String(v).split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.length;
};

/**
 * Every file a turn changed, in first-touched order, with all of its edits
 * and how many lines went in and out. Only edits that actually ran count: a
 * failed one, or one still waiting for approval, changed nothing.
 */
export function turnChanges(steps) {
  const byPath = new Map();
  for (const s of steps) {
    const call = s.type === "tool" ? s.call : null;
    const ed = call?.editData;
    if (!ed || s.failed || !s.results.length) continue;
    const path = ed.file_path || ed.path || ed.notebook_path;
    if (!path) continue;
    let f = byPath.get(path);
    if (!f) byPath.set(path, (f = { path, edits: [], adds: 0, dels: 0, created: false }));
    f.edits.push({ id: s.id, toolName: call.toolName, editData: ed });
    if (call.toolName === "Write") {
      f.adds += lineCount(ed.content);
      if (f.edits.length === 1) f.created = true; // may also be an overwrite; the transcript can't tell
    } else {
      const pairs = Array.isArray(ed.edits) ? ed.edits : [ed];
      for (const e of pairs) {
        const oldS = e.old_string ?? "";
        const newS = e.new_string ?? e.new_source ?? "";
        for (const c of diffLines(String(oldS), String(newS))) {
          if (c.added) f.adds += c.count ?? lineCount(c.value);
          else if (c.removed) f.dels += c.count ?? lineCount(c.value);
        }
      }
    }
  }
  return [...byPath.values()];
}

/**
 * The steps to render at a detail level. Settings' per-kind / per-category
 * filters still apply here: filtered tools collapse into a compact group chip
 * (or disappear when the display mode is "hidden").
 */
export function visibleSteps(steps, detail, filters, catById) {
  const out = [];
  let group = null;
  const flushGroup = () => { if (group) { out.push(group); group = null; } };
  for (const s of steps) {
    if (s.type === "thinking") {
      if (detail === "all") { flushGroup(); out.push(s); }
      continue;
    }
    if (s.type === "narration") {
      if (filters.text === false) continue;
      flushGroup(); out.push(s); continue;
    }
    if (s.type === "error") { flushGroup(); out.push(s); continue; }
    // tool
    const m = s.call || s.results[0];
    const disp = s.failed ? "full" : messageDisplay(m, filters, catById);
    if (disp === "hidden") continue;
    if (disp === "full") {
      flushGroup();
      // Fold repeats of the same tool on the same target (five Edits to one
      // file in a row) into one row with a ×N count.
      const prev = out[out.length - 1];
      if (prev && prev.type === "tool" && sameAction(prev, s)) {
        out[out.length - 1] = { ...prev, repeats: [...(prev.repeats || [prev]), s] };
      } else out.push(s);
      continue;
    }
    const cat = resolveCategory(m, catById) || "other";
    if (!group) group = { type: "group", id: "g-" + s.id, items: [] };
    group.items.push({ ...s, cat });
  }
  flushGroup();
  return out;
}

function sameAction(a, b) {
  if (!a.call || !b.call || a.failed || b.failed) return false;
  if (a.call.toolName !== b.call.toolName) return false;
  const ta = (a.call.text || "").trim();
  return ta.length > 0 && ta === (b.call.text || "").trim() && !!a.call.editData === !!b.call.editData;
}

// ─── display helpers ────────────────────────────────────────────────────────

/** "mcp__Claude_Browser__navigate" → { name: "navigate", ns: "Claude Browser" }. */
export function toolLabel(toolName) {
  const n = toolName || "tool";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(n);
  if (mcp) return { name: mcp[2].replace(/_/g, " "), ns: mcp[1].replace(/^plugin_[^_]+_/, "").replace(/_/g, " ") };
  return { name: n, ns: null };
}

/** Split a path-ish target into a dim directory and a bright basename. */
export function splitPath(s) {
  const text = (s || "").trim();
  if (!/^([A-Za-z]:)?[\\/]|^\.{0,2}[\\/]|^[\w.-]+[\\/][\w./\\-]+$/.test(text) || /\s/.test(text)) return null;
  const i = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (i < 0) return null;
  return { dir: text.slice(0, i + 1), base: text.slice(i + 1) };
}

export function fmtDuration(ms) {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(m / 60)}h`;
}

export function fmtClock(at, now = Date.now()) {
  if (!at) return null;
  const d = new Date(at);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hm;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${hm}`;
}

export function plural(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}
