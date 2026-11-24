// One-of-several choice for how much a session may do without asking.
import { PERM_MODES } from "./agents.js";

// variant "chips" (compact, New session) or "cards" (label + one-line summary).
export default function PermModePicker({ agent, value, onChange, label = "Permissions", variant = "chips" }) {
  const modes = PERM_MODES[agent === "codex" ? "codex" : "claude"];
  const cur = modes.find((m) => m.key === value) || modes[0];
  return (
    <div className={"perm-picker " + variant}>
      <div className="perm-modes" role="radiogroup" aria-label={label}>
        {modes.map((m) => (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={m.key === cur.key}
            className={"perm-mode" + (m.key === cur.key ? " on" : "") + (m.danger ? " danger" : "")}
            title={m.hint}
            onClick={() => onChange(m.key)}
          >
            <span className="perm-mode-label">{m.danger ? "⚠ " : ""}{m.label}</span>
            {variant === "cards" && <span className="perm-mode-short">{m.short}</span>}
          </button>
        ))}
      </div>
      <div className={"perm-hint" + (cur.danger ? " danger" : "")}>{cur.hint}</div>
    </div>
  );
}
