// Design gallery for StatusGlyph: every kind at tab / status-bar / large size,
// in a fake tab row, dark and light. http://localhost:<port>/preview/glyphs/
import { Fragment } from "react";
import { createRoot } from "react-dom/client";
import StatusGlyph from "../../src/StatusGlyph.jsx";
const KINDS = [["working", "Working"], ["thinking", "Thinking"], ["tool", "Running tool"], ["agents", "Agent running"], ["approve", "Needs approval"], ["ask", "Asked you"], ["plan", "Plan to approve"], ["new", "New activity"], ["starting", "Starting"], ["idle", "Idle"]];
const theme = new URLSearchParams(location.search).get("theme") || "dark";
document.documentElement.dataset.theme = theme;
function App() {
  return (
    <div style={{ padding: 24, background: "var(--bg)", color: "var(--text)", minHeight: "100vh", fontFamily: "var(--font-ui)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "160px 60px 60px 80px", gap: "14px 10px", alignItems: "center", marginBottom: 28 }}>
        {KINDS.map(([k, l]) => (
          <Fragment key={k}>
            <span style={{ fontSize: 13 }}>{l}</span>
            <StatusGlyph kind={k} size={12} />
            <StatusGlyph kind={k} size={14} />
            <StatusGlyph kind={k} size={40} />
          </Fragment>
        ))}
      </div>
      <div className="tabs-rail" style={{ width: 240, display: "flex", flexDirection: "column", gap: 4 }}>
        {KINDS.map(([k, l]) => (
          <div key={k} className="tab" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="tab-proj" style={{ background: "#e8590c" }} />
            <StatusGlyph kind={k} size={14} className="tab-glyph" />
            <span className="tab-name">{l.toLowerCase()} session</span>
          </div>
        ))}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
