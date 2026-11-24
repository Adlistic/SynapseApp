import "./statusglyph.css";

// StatusGlyph: the small status icon on tabs, Mission Control and the status
// bar. Deliberately only four looks, each answering "do I need to do
// anything?" (styles in statusglyph.css):
//   working   green orb with a comet sweeping round it
//   approve / ask / plan   a full amber disc with a readable "!", "?" or plan
//             mark (the tab itself also turns amber)
//   new       a solid blue dot: finished while you were on another tab
//   idle      a faint dot
// The detail of what a busy session is doing ("thinking", "Bash", "2 agents")
// is a word next to the tab name (tabWord), not another icon to learn.

/** Which glyph a status (from statusFor) shows. */
export function glyphKind(st, { lastKind, isNew = false } = {}) {
  if (!st) return "idle";
  if (st.key === "attention") {
    if (st.label === "asked you" || lastKind === "question") return "ask";
    if (lastKind === "plan") return "plan";
    return "approve";
  }
  if (st.key === "working") return "working";
  if (isNew) return "new";
  return "idle";
}

/** The short word shown next to a tab's name, or "" for none. */
export function tabWord(st, { lastKind, lastActivity, agentsRunning = 0 } = {}) {
  if (!st) return "";
  const kind = glyphKind(st, { lastKind });
  if (kind === "approve") return "approve";
  if (kind === "ask") return "question";
  if (kind === "plan") return "plan";
  if (st.key !== "working") return "";
  if (st.label === "agent running") return agentsRunning > 1 ? `${agentsRunning} agents` : "agent";
  if (st.label === "thinking") return "thinking";
  if (lastKind === "toolcall" && lastActivity) return lastActivity.split(" · ")[0].replace(/^⑂ /, "");
  return ""; // plain "working": the green orb already says it
}

// Marks drawn as strokes, not text, so they stay crisp at 12–14px on a 1x
// screen (a 7px "?" glyph turns into a smudge).
const MARK = {
  approve: <><path d="M8 3.6v5.3" /><circle cx="8" cy="12" r="0.6" /></>,
  ask: <><path d="M5.9 5.9a2.15 2.15 0 1 1 3.1 1.95c-.7.35-1 .8-1 1.5v.25" /><circle cx="8" cy="12" r="0.6" /></>,
  plan: <path d="M4.8 5.2h6.4M4.8 8h6.4M4.8 10.8h4.2" />,
};

export default function StatusGlyph({ kind = "idle", size = 14, title, className = "" }) {
  return (
    <span className={`sg sg-${kind} ${className}`} style={{ "--sg": `${size}px` }} title={title} aria-hidden={title ? undefined : true}>
      <span className="sg-ring" />
      <span className="sg-ring two" />
      <span className="sg-core">{MARK[kind] && <svg viewBox="0 0 16 16" aria-hidden="true">{MARK[kind]}</svg>}</span>
      <span className="sg-sat" />
      <span className="sg-sat two" />
    </span>
  );
}
