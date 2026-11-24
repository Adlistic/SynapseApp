// The coding agents HyperVoice Code can run in its terminal, and whether each
// one is on this PC. The backend's `agent_status` checks PATH plus the usual
// install folders; "used" means its settings folder exists (it has been run
// here), so the command probably works in a terminal even if we couldn't find
// it — that case stays selectable instead of being greyed out.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export const AGENTS = {
  claude: {
    key: "claude",
    name: "Claude Code",
    short: "Claude",
    maker: "Anthropic",
    installUrl: "https://code.claude.com/docs/en/setup",
    autonomyFlag: "--dangerously-skip-permissions",
  },
  codex: {
    key: "codex",
    name: "Codex",
    short: "Codex",
    maker: "OpenAI",
    installUrl: "https://developers.openai.com/codex/cli",
    autonomyFlag: "--dangerously-bypass-approvals-and-sandbox",
  },
};
export const AGENT_KEYS = ["claude", "codex"];

export function agentOf(x) {
  return x?.agent === "codex" ? "codex" : "claude";
}
export function agentInfo(x) {
  return AGENTS[typeof x === "string" ? (x === "codex" ? "codex" : "claude") : agentOf(x)];
}

/** "installed" | "maybe" (used here, command not found) | "missing" | null (unknown yet). */
export function availability(status, key) {
  const s = status?.[key];
  if (!s) return null;
  if (s.installed) return "installed";
  if (s.used) return "maybe";
  return "missing";
}
export const usable = (a) => a !== "missing";

/** Ask the backend which agents are installed; re-asks whenever `refresh` changes. */
export function useAgentStatus(refresh = 0) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let alive = true;
    invoke("agent_status")
      .then((s) => alive && setStatus(s || {}))
      .catch(() => alive && setStatus({}));
    return () => { alive = false; };
  }, [refresh]);
  return status;
}

/**
 * The agent a new session should start with: the Settings default ("claude",
 * "codex", or "last" = whichever was used last), unless that one isn't on
 * this PC and the other is.
 */
export function defaultAgent(filters, status) {
  const pref = filters?.defaultAgent || "claude";
  let want = pref === "last" ? filters?.lastAgent || "claude" : pref;
  if (!AGENT_KEYS.includes(want)) want = "claude";
  const other = want === "claude" ? "codex" : "claude";
  if (status && availability(status, want) === "missing" && usable(availability(status, other))) return other;
  return want;
}

export function statusText(a) {
  if (a === "installed") return "Installed";
  if (a === "maybe") return "Used on this PC";
  if (a === "missing") return "Not installed";
  return "Checking…";
}
export function statusHint(a, info) {
  if (a === "maybe") return `${info.name} has been used on this PC, but HyperVoice Code couldn't find the "${info.key}" command. If it runs in your terminal, it will run here.`;
  if (a === "missing") return `${info.name} isn't installed on this PC. Install it, then come back — this is checked each time.`;
  if (a === "installed") return `${info.name} is installed`;
  return "";
}

// Permission modes a session can start or resume in. The keys are the only
// ones the backend accepts; it maps each to the agent's own flags.
export const PERM_MODES = {
  claude: [
    { key: "default", label: "Ask", short: "Asks before edits and commands", hint: "Claude asks before editing files or running commands (Claude Code's default)." },
    { key: "acceptEdits", label: "Accept edits", short: "Edits freely, asks before commands", hint: "File edits go ahead without asking; commands still ask. (--permission-mode acceptEdits)" },
    { key: "plan", label: "Plan", short: "Reads and plans, changes nothing yet", hint: "Claude reads and plans but changes nothing until you approve the plan. (--permission-mode plan)" },
    { key: "auto", label: "Auto", short: "Runs what it judges safe, asks the rest", hint: "Claude decides what's safe to run on its own and asks about the rest. (--permission-mode auto)" },
    { key: "bypass", label: "Skip permissions", short: "Never asks. Can run or delete anything", danger: true, hint: "No prompts at all: Claude can run any command and edit or delete any file. (--dangerously-skip-permissions)" },
  ],
  codex: [
    { key: "default", label: "Ask", short: "Asks before going beyond the folder", hint: "Codex's default: it asks when it needs to go beyond the folder." },
    { key: "readOnly", label: "Read-only", short: "Can look, can't change anything", hint: "Codex can read files but not change anything. (--sandbox read-only)" },
    { key: "auto", label: "Auto-review", short: "Approvals reviewed automatically", hint: "Approval requests are reviewed automatically, inside the folder's sandbox. (--approve-for-me)" },
    { key: "bypass", label: "Skip permissions", short: "No prompts, no sandbox", danger: true, hint: "No prompts and no sandbox: Codex can run anything. (--dangerously-bypass-approvals-and-sandbox)" },
  ],
};

/** The mode to preselect for an agent: whichever was used last, else "default". */
export function lastPermMode(filters, agent) {
  const a = agent === "codex" ? "codex" : "claude";
  const k = filters?.lastPermMode?.[a];
  return PERM_MODES[a].some((m) => m.key === k) ? k : "default";
}
