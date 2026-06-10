import { useEffect, useState } from "react";
import { TOOL_CATS, BG_PRESETS, KIND_COLOR } from "./filters.js";

// HSL <-> hex for the native color input (we store background color as HSL to
// match the presets; the <input type=color> works in hex).
function hslToHex({ h, s, l }) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { h: 222, s: 47, l: 11 };
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      className={"sw" + (checked ? " on" : "")}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      role="switch"
      aria-checked={checked}
    >
      <span className="sw-knob" />
    </button>
  );
}

function Row({ color, label, hint, checked, onChange }) {
  return (
    <div className="srow" onClick={() => onChange(!checked)}>
      <span className="srow-dot" style={{ background: color }} />
      <span className="srow-main">
        <span className="srow-label">{label}</span>
        {hint && <span className="srow-hint">{hint}</span>}
      </span>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function Segmented({ label, hint, value, options, onChange }) {
  return (
    <div className="seg-row">
      <span className="seg-info">
        <span className="srow-label">{label}</span>
        {hint && <span className="srow-hint">{hint}</span>}
      </span>
      <div className="seg">
        {options.map((o) => (
          <button key={String(o.v)} className={"seg-btn" + (value === o.v ? " on" : "")} onClick={() => onChange(o.v)}>
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

const CONVO = [
  { key: "user", label: "User prompts", hint: "Your messages", color: KIND_COLOR.user },
  { key: "text", label: "Messages", hint: "Claude's text replies", color: KIND_COLOR.message },
  { key: "question", label: "Questions", hint: "Replies ending in a question mark", color: KIND_COLOR.question },
  { key: "thinking", label: "Thinking", hint: "Internal reasoning blocks", color: KIND_COLOR.thinking },
];
const RESULTS = [
  { key: "plan", label: "Plans", hint: "Proposed step lists from plan mode", color: KIND_COLOR.plan },
  { key: "tool_result", label: "Tool results", hint: "Output returned by tool calls", color: KIND_COLOR.toolresult },
  { key: "error", label: "Errors", hint: "Failed tool invocations", color: KIND_COLOR.error },
];

const TABS = [
  { key: "appearance", label: "Appearance", icon: "🎨" },
  { key: "filters", label: "Filters", icon: "▦" },
  { key: "launch", label: "Launch", icon: "⌂" },
];

export default function SettingsModal({ open, onClose, filters, setFlag, setCat, setAllCats, reset, initialTab = "appearance" }) {
  const [tab, setTab] = useState(initialTab);
  const [catsOpen, setCatsOpen] = useState(false);

  // Land on the requested tab each time the modal opens (Filters button → Filters).
  useEffect(() => { if (open) setTab(initialTab || "appearance"); }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const onCount = Object.values(filters.toolCategories).filter(Boolean).length;
  const bgMode = filters.backgroundMode || "none";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <header className="modal-head">
          <div className="modal-title">⚙ Settings</div>
          <button className="modal-x" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="modal-cols">
          <nav className="modal-rail">
            {TABS.map((t) => (
              <button key={t.key} className={"rail-tab" + (tab === t.key ? " on" : "")} onClick={() => setTab(t.key)}>
                <span className="rail-ic">{t.icon}</span>{t.label}
              </button>
            ))}
          </nav>

          <div className="modal-body">
            {tab === "appearance" && (
              <>
                <div className="sec-head">Background</div>
                <Segmented
                  label="Mode" hint="What sits behind the app"
                  value={bgMode}
                  options={[{ v: "none", l: "None" }, { v: "color", l: "Color" }, { v: "aurora", l: "Aurora" }]}
                  onChange={(v) => setFlag("backgroundMode", v)}
                />
                {bgMode !== "none" && (
                  <div className="bg-pickers">
                    <div className="bg-presets">
                      {BG_PRESETS.map((p) => {
                        const c = filters.backgroundColor || {};
                        const active = c.h === p.h && c.s === p.s && c.l === p.l;
                        return (
                          <button
                            key={p.name}
                            className={"bg-swatch" + (active ? " on" : "")}
                            title={p.name}
                            style={{ background: `hsl(${p.h} ${p.s}% ${p.l}%)` }}
                            onClick={() => setFlag("backgroundColor", { h: p.h, s: p.s, l: p.l })}
                          />
                        );
                      })}
                    </div>
                    <label className="bg-custom">
                      <span>Custom</span>
                      <input
                        type="color"
                        value={hslToHex(filters.backgroundColor || { h: 222, s: 47, l: 11 })}
                        onChange={(e) => setFlag("backgroundColor", hexToHsl(e.target.value))}
                      />
                    </label>
                  </div>
                )}
                {bgMode === "aurora" && (
                  <Segmented
                    label="Aurora speed" hint="Drift speed of the blobs"
                    value={filters.warpSpeed ?? 1}
                    options={[{ v: 0, l: "Off" }, { v: 0.5, l: "Slow" }, { v: 1, l: "Normal" }, { v: 2, l: "Fast" }, { v: 4, l: "Warp" }]}
                    onChange={(v) => setFlag("warpSpeed", v)}
                  />
                )}
              </>
            )}

            {tab === "filters" && (
              <>
                <div className="sec-head">Conversation</div>
                {CONVO.map((r) => (
                  <Row key={r.key} color={r.color} label={r.label} hint={r.hint} checked={!!filters[r.key]} onChange={(v) => setFlag(r.key, v)} />
                ))}

                <div className="sec-head">Plans &amp; results</div>
                {RESULTS.map((r) => (
                  <Row key={r.key} color={r.color} label={r.label} hint={r.hint} checked={!!filters[r.key]} onChange={(v) => setFlag(r.key, v)} />
                ))}

                <div className="sec-head">Tool calls <span className="sec-badge">{onCount}/{TOOL_CATS.length}</span></div>
                <Row color={KIND_COLOR.toolcall} label="Show tool calls" hint="Master toggle" checked={!!filters.tool_use} onChange={(v) => setFlag("tool_use", v)} />
                <Segmented
                  label="Filtered tool display" hint="How filtered-out tool calls render"
                  value={filters.filteredToolDisplay}
                  options={[{ v: "dot", l: "Dot" }, { v: "pill", l: "Pill" }, { v: "hidden", l: "Hidden" }]}
                  onChange={(v) => setFlag("filteredToolDisplay", v)}
                />
                <button className={"cats-toggle" + (filters.tool_use ? "" : " dim")} onClick={() => setCatsOpen((v) => !v)} aria-expanded={catsOpen}>
                  <span className="cats-caret">{catsOpen ? "▾" : "▸"}</span>
                  {catsOpen ? "Hide categories" : "Show 14 categories"}
                  <span className="cats-count">{onCount}/{TOOL_CATS.length}</span>
                </button>
                {catsOpen && (
                  <div className={"cats" + (filters.tool_use ? "" : " dim")}>
                    <div className="cats-bulk">
                      <button className="bulk-btn" onClick={() => setAllCats(true)}>Show all</button>
                      <button className="bulk-btn" onClick={() => setAllCats(false)}>Hide all</button>
                    </div>
                    {TOOL_CATS.map((c) => (
                      <Row key={c.key} color={c.color} label={c.label} hint={c.key} checked={!!filters.toolCategories[c.key]} onChange={(v) => setCat(c.key, v)} />
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === "launch" && (
              <>
                <div className="sec-head">New-session screen</div>
                <Segmented
                  label="Recent folders to show" hint="On the launch screen"
                  value={filters.recentFoldersLimit ?? 5}
                  options={[{ v: 0, l: "Off" }, { v: 3, l: "3" }, { v: 5, l: "5" }, { v: 10, l: "10" }, { v: 15, l: "15" }]}
                  onChange={(v) => setFlag("recentFoldersLimit", v)}
                />
                <div className="sec-head">Tabs</div>
                <Segmented
                  label="Tab position" hint="Where session tabs appear"
                  value={filters.tabPosition || "top"}
                  options={[{ v: "top", l: "Top" }, { v: "left", l: "Left" }]}
                  onChange={(v) => setFlag("tabPosition", v)}
                />
              </>
            )}
          </div>
        </div>

        <footer className="modal-foot">
          <span className="foot-note">Saved locally · changes apply instantly</span>
          <div className="foot-btns">
            <button className="btn-ghost" onClick={reset}>↺ Reset</button>
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
