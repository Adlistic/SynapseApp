// Choosing between Claude Code and Codex: the cards on the new-session screen,
// the one-time "which agent do you use?" screen, and the Settings row.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS, AGENT_KEYS, availability, defaultAgent, statusHint, statusText, usable, useAgentStatus } from "./agents.js";

function openUrl(url) {
  invoke("open_external", { url }).catch(() => {});
}

function GetIt({ info }) {
  return (
    <button
      type="button"
      className="agent-get"
      onClick={(e) => { e.stopPropagation(); openUrl(info.installUrl); }}
      title={`How to install ${info.name} (opens ${info.maker}'s page in your browser)`}
    >
      Get it ↗
    </button>
  );
}

/**
 * One card per agent. A missing agent is greyed out and can't be picked
 * (unless `allowMissing`, used where the choice is only a preference).
 */
export function AgentCards({ value, onChange, status, allowMissing = false, size = "md", label = "Coding agent", labelledBy }) {
  return (
    <div
      className={"agent-cards " + size}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
    >
      {AGENT_KEYS.map((k) => {
        const info = AGENTS[k];
        const a = availability(status, k);
        const off = !allowMissing && a === "missing";
        const on = value === k && !off;
        // The card is the visual box; the radio inside it and the "Get it"
        // link are siblings (no button nested inside a radio).
        return (
          <div
            key={k}
            className={"agent-card" + (on ? " on" : "") + (off ? " off" : "") + (a === "missing" ? " missing" : "")}
            title={statusHint(a, info)}
            onClick={() => !off && onChange(k)}
          >
            <div
              role="radio"
              className="agent-pick"
              aria-checked={on}
              aria-disabled={off || undefined}
              tabIndex={on || (!value && k === "claude") || (off && value === k) ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!off) onChange(k); }
                if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const other = k === "claude" ? "codex" : "claude";
                  if (allowMissing || availability(status, other) !== "missing") {
                    onChange(other);
                    e.currentTarget.closest(".agent-cards")?.querySelector(`[data-agent="${other}"]`)?.focus();
                  }
                }
              }}
              data-agent={k}
            >
              <span className="agent-radio" aria-hidden="true" />
              <span className="agent-text">
                <span className="agent-name">{info.name} <span className="agent-maker">by {info.maker}</span></span>
                <span className={"agent-status " + (a || "unknown")}>
                  {a === "installed" ? "✓ " : ""}
                  {statusText(a)}
                </span>
              </span>
            </div>
            {a === "missing" && <GetIt info={info} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Shown once: on first run (before the tour), and once to people who already
 * used the app before Codex support, so everyone picks a default knowingly.
 */
export function AgentSetup({ filters, onDone }) {
  const status = useAgentStatus();
  const [pick, setPick] = useState(null);
  const value = pick || (status ? defaultAgent(filters, status) : null);
  const none = status && !AGENT_KEYS.some((k) => usable(availability(status, k)));
  return (
    <div className="modal-backdrop">
      <div className="wn-modal welcome agent-setup" role="dialog" aria-modal="true" aria-labelledby="agent-setup-title">
        <div className="tour-icon">❯</div>
        <h3 className="tour-title" id="agent-setup-title">Which coding agent do you use?</h3>
        <p className="tour-body">
          HyperVoice Code runs Claude Code or Codex in its terminal and lays the conversation out beside it.
          Pick the one new sessions start with. You can switch for any single session, and change this later in Settings → Workspace.
        </p>
        <div className="agent-setup-cards">
          <AgentCards value={value} onChange={setPick} status={status} allowMissing size="lg" label="Default coding agent" />
        </div>
        {none && (
          <p className="agent-setup-note">
            Neither is installed on this PC yet. Install one with its “Get it” link, then start a session — the app checks again each time.
          </p>
        )}
        <div className="wn-foot">
          <span />
          <button className="sm-btn primary" disabled={!value} onClick={() => onDone(value)}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

/** Settings → Workspace: which agent new sessions start with. */
export function DefaultAgentSetting({ filters, setFlag }) {
  const status = useAgentStatus();
  const pref = filters.defaultAgent || "claude";
  const opts = [
    { v: "claude", l: "Claude Code" },
    { v: "codex", l: "Codex" },
    { v: "last", l: "Last used" },
  ];
  return (
    <div className="agent-setting">
      <div className="agent-setting-row">
        <div className="agent-setting-info">
          <div className="sm-item-label">New sessions start with</div>
          <div className="sm-item-hint">The new-session screen still lets you pick the other one for a single session.</div>
        </div>
        <div className="sm-seg" role="radiogroup" aria-label="Default coding agent">
          {opts.map((o) => (
            <button
              key={o.v}
              role="radio"
              aria-checked={pref === o.v}
              className={"sm-seg-btn" + (pref === o.v ? " on" : "")}
              onClick={() => setFlag("defaultAgent", o.v)}
            >
              {o.l}
            </button>
          ))}
        </div>
      </div>
      <div className="agent-setting-status">
        {AGENT_KEYS.map((k) => {
          const info = AGENTS[k];
          const a = availability(status, k);
          return (
            <span key={k} className="agent-setting-pill" title={statusHint(a, info)}>
              <b>{info.name}</b>
              <span className={"agent-status " + (a || "unknown")}>{a === "installed" ? "✓ " : ""}{statusText(a)}</span>
              {a === "missing" && <GetIt info={info} />}
            </span>
          );
        })}
      </div>
    </div>
  );
}
