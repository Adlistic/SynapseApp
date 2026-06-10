import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { TOOL_CATS, BG_PRESETS, ACCENT_PRESETS, KIND_COLOR } from "./filters.js";
import { checkForUpdatesManual } from "./updater.js";

// ─── helpers ────────────────────────────────────────────────────────────────

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

// ─── primitives ─────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      className={"sm-sw" + (checked ? " on" : "")}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      role="switch"
      aria-checked={checked}
    >
      <span className="sm-sw-knob" />
    </button>
  );
}

// One setting row: label + description on the left, the control on the right.
function Item({ label, hint, color, control, onClick, children }) {
  return (
    <div className={"sm-item" + (onClick ? " clickable" : "")} onClick={onClick}>
      <div className="sm-item-info">
        <div className="sm-item-label">
          {color && <span className="sm-dot" style={{ background: color }} />}
          {label}
        </div>
        {hint && <div className="sm-item-hint">{hint}</div>}
      </div>
      <div className="sm-item-control">{control || children}</div>
    </div>
  );
}

function ToggleItem({ label, hint, color, checked, onChange }) {
  return (
    <Item
      label={label}
      hint={hint}
      color={color}
      onClick={() => onChange(!checked)}
      control={<Toggle checked={checked} onChange={onChange} />}
    />
  );
}

function Seg({ value, options, onChange }) {
  return (
    <div className="sm-seg">
      {options.map((o) => (
        <button
          key={String(o.v)}
          className={"sm-seg-btn" + (value === o.v ? " on" : "")}
          onClick={() => onChange(o.v)}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

// A card grouping related settings, with a heading outside the card.
function Group({ title, desc, actions, children, visible = true }) {
  if (!visible) return null;
  return (
    <section className="sm-group">
      <div className="sm-group-head">
        <div>
          <h4 className="sm-group-title">{title}</h4>
          {desc && <div className="sm-group-desc">{desc}</div>}
        </div>
        {actions && <div className="sm-group-actions">{actions}</div>}
      </div>
      <div className="sm-card">{children}</div>
    </section>
  );
}

// Visual theme picker — mini window previews, Linear/GitHub style.
function ThemeCards({ value, onChange }) {
  const themes = [
    { v: "dark", l: "Dark", bg: "#0b1120", panel: "#19233c", line: "#33425f", text: "#d9e4ff" },
    { v: "light", l: "Light", bg: "#f2f5fb", panel: "#ffffff", line: "#c6d3e8", text: "#101a2e" },
    { v: "system", l: "System", split: true },
  ];
  const mini = (t, half) => (
    <div className="sm-mini" style={{ background: t.bg, borderColor: t.line, ...(half ? { width: "50%" } : {}) }}>
      <div className="sm-mini-bar" style={{ background: t.panel, borderColor: t.line }}>
        <span style={{ background: "#f97316" }} />
        <span style={{ background: "#ffc700" }} />
        <span style={{ background: "#22c55e" }} />
      </div>
      <div className="sm-mini-body">
        <div className="sm-mini-line" style={{ background: "#27b8fd", width: "55%" }} />
        <div className="sm-mini-line" style={{ background: t.line, width: "85%" }} />
        <div className="sm-mini-line" style={{ background: t.line, width: "70%" }} />
      </div>
    </div>
  );
  return (
    <div className="sm-themes">
      {themes.map((t) => (
        <button
          key={t.v}
          className={"sm-theme" + (value === t.v ? " on" : "")}
          onClick={() => onChange(t.v)}
        >
          <div className="sm-theme-preview">
            {t.split ? (
              <div className="sm-mini-split">
                {mini(themes[0], true)}
                {mini(themes[1], true)}
              </div>
            ) : (
              mini(t)
            )}
          </div>
          <div className="sm-theme-name">
            <span className={"sm-radio" + (value === t.v ? " on" : "")} />
            {t.l}
          </div>
        </button>
      ))}
    </div>
  );
}

function Swatches({ items, isOn, onPick, custom }) {
  return (
    <div className="sm-swatches">
      {items.map((it) => (
        <button
          key={it.key}
          className={"sm-swatch" + (isOn(it) ? " on" : "")}
          title={it.title}
          style={{ background: it.css }}
          onClick={() => onPick(it)}
        >
          {isOn(it) && <span className="sm-swatch-check">✓</span>}
        </button>
      ))}
      {custom}
    </div>
  );
}

// ─── data ───────────────────────────────────────────────────────────────────

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

const NAV = [
  { key: "appearance", label: "Appearance", icon: "◐", desc: "Theme, accent, background" },
  { key: "conversation", label: "Conversation", icon: "❯", desc: "Which messages appear" },
  { key: "tools", label: "Tool calls", icon: "⚒", desc: "Category visibility" },
  { key: "workspace", label: "Workspace", icon: "⌂", desc: "Launch, tabs, terminal" },
  { key: "about", label: "About", icon: "ⓘ", desc: "Version & updates" },
];
// Old keys still arrive from callers.
const LEGACY = { filters: "conversation", launch: "workspace" };

// ─── about / updates ────────────────────────────────────────────────────────

function About() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState(null);
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  async function run() {
    setState("checking");
    setState(await checkForUpdatesManual());
  }
  return (
    <>
      <Item
        label="Version"
        hint="Synapse — Claude Code Workspace"
        control={<span className="sm-version">{version ? `v${version}` : "—"}</span>}
      />
      <Item
        label="Updates"
        hint={
          state && state !== "checking"
            ? state.status === "uptodate"
              ? "✓ You're on the latest version"
              : state.status === "installing"
              ? `Updating to ${state.version}…`
              : `Couldn't check: ${state.message}`
            : "Installed updates apply on relaunch"
        }
        control={
          <button className="sm-btn" onClick={run} disabled={state === "checking"}>
            {state === "checking" ? "Checking…" : "Check for updates"}
          </button>
        }
      />
      <Item
        label="Data"
        hint="Settings live in this app only; transcripts stay in ~/.claude"
        control={<span className="sm-muted-note">Local only</span>}
      />
    </>
  );
}

// ─── the modal ──────────────────────────────────────────────────────────────

export default function SettingsModal({ open, onClose, filters, setFlag, setCat, setAllCats, reset, initialTab = "appearance" }) {
  const [tab, setTab] = useState(LEGACY[initialTab] || initialTab);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) {
      setTab(LEGACY[initialTab] || initialTab || "appearance");
      setQuery("");
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const q = query.trim().toLowerCase();
  const searching = q.length >= 2;
  const hit = (...texts) => !searching || texts.join(" ").toLowerCase().includes(q);

  // Which nav sections contain a match (used to filter the rail while searching).
  const sectionHits = useMemo(() => ({
    appearance: hit("theme dark light system accent color background aurora speed"),
    conversation: hit(CONVO.concat(RESULTS).map((r) => r.label + " " + r.hint).join(" ")),
    tools: hit("tool calls categories filtered display dot pill hidden " + TOOL_CATS.map((c) => c.label).join(" ")),
    workspace: hit("recent folders launch tabs position composer terminal dictation prompt"),
    about: hit("version updates check data local"),
  }), [q]);

  if (!open) return null;

  const onCount = Object.values(filters.toolCategories).filter(Boolean).length;
  const bgMode = filters.backgroundMode || "none";
  const showSection = (key) => (searching ? sectionHits[key] : tab === key);
  // Background hues render as pale tints in light mode (see Background.jsx) —
  // preview the swatches the same way so they show what you'll actually get.
  const isLight =
    (filters.theme || "dark") === "light" ||
    ((filters.theme || "dark") === "system" &&
      window.matchMedia("(prefers-color-scheme: light)").matches);
  const swatchCss = (p) =>
    isLight ? `hsl(${p.h} ${Math.min(p.s, 45)}% 91%)` : `hsl(${p.h} ${p.s}% ${p.l}%)`;

  return (
    <div className="modal-backdrop sm-backdrop" onClick={onClose}>
      <div className="sm-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <aside className="sm-rail">
          <div className="sm-rail-brand">
            <span className="logo-mark">◆</span> Synapse
            <span className="sm-rail-sub">Settings</span>
          </div>
          <div className="sm-search">
            <span className="sm-search-ic">⌕</span>
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings…"
            />
            {query && <button className="sm-search-x" onClick={() => setQuery("")}>✕</button>}
          </div>
          <nav className="sm-nav">
            {NAV.filter((n) => !searching || sectionHits[n.key]).map((n) => (
              <button
                key={n.key}
                className={"sm-nav-item" + (!searching && tab === n.key ? " on" : "")}
                onClick={() => { setTab(n.key); setQuery(""); }}
              >
                <span className="sm-nav-ic">{n.icon}</span>
                <span className="sm-nav-text">
                  <span className="sm-nav-label">{n.label}</span>
                  <span className="sm-nav-desc">{n.desc}</span>
                </span>
              </button>
            ))}
            {searching && !Object.values(sectionHits).some(Boolean) && (
              <div className="sm-nav-none">No settings match “{query.trim()}”.</div>
            )}
          </nav>
          <div className="sm-rail-foot">
            <span className="sm-saved">● All changes save instantly</span>
          </div>
        </aside>

        <main className="sm-body">
          <header className="sm-head">
            <h3>{searching ? `Results for “${query.trim()}”` : NAV.find((n) => n.key === tab)?.label}</h3>
            <button className="sm-x" onClick={onClose} aria-label="Close settings">✕</button>
          </header>

          <div className="sm-scroll">
            {showSection("appearance") && (
              <>
                <Group title="Theme" desc="Panels and text — the terminal stays dark either way." visible={hit("theme dark light system")}>
                  <ThemeCards value={filters.theme || "dark"} onChange={(v) => setFlag("theme", v)} />
                </Group>
                <Group title="Accent" desc="Buttons, highlights, the active tab and the logo." visible={hit("accent color brand")}>
                  <div className="sm-pad">
                    <Swatches
                      items={ACCENT_PRESETS.map((hex) => ({ key: hex, css: hex, title: hex }))}
                      isOn={(it) => (filters.accent || ACCENT_PRESETS[0]) === it.key}
                      onPick={(it) => setFlag("accent", it.key === ACCENT_PRESETS[0] ? null : it.key)}
                      custom={
                        <label className="sm-swatch custom" title="Custom accent">
                          <input
                            type="color"
                            value={filters.accent || ACCENT_PRESETS[0]}
                            onChange={(e) => setFlag("accent", e.target.value)}
                          />
                          <span>＋</span>
                        </label>
                      }
                    />
                  </div>
                </Group>
                <Group title="Background" desc="What sits behind the app's panels." visible={hit("background aurora color speed")}>
                  <Item label="Mode" hint="None keeps it flat; Aurora drifts slowly" control={
                    <Seg
                      value={bgMode}
                      options={[{ v: "none", l: "None" }, { v: "color", l: "Color" }, { v: "aurora", l: "Aurora" }]}
                      onChange={(v) => setFlag("backgroundMode", v)}
                    />
                  } />
                  {bgMode !== "none" && (
                    <Item
                      label="Color"
                      hint={isLight ? "Hues render as pale tints in light mode" : "Preset tones, or pick your own"}
                      control={
                      <Swatches
                        items={BG_PRESETS.map((p) => ({ key: p.name, css: swatchCss(p), title: p.name, p }))}
                        isOn={(it) => {
                          const c = filters.backgroundColor || {};
                          return c.h === it.p.h && c.s === it.p.s && c.l === it.p.l;
                        }}
                        onPick={(it) => setFlag("backgroundColor", { h: it.p.h, s: it.p.s, l: it.p.l })}
                        custom={
                          <label className="sm-swatch custom" title="Custom color">
                            <input
                              type="color"
                              value={hslToHex(filters.backgroundColor || { h: 222, s: 47, l: 11 })}
                              onChange={(e) => setFlag("backgroundColor", hexToHsl(e.target.value))}
                            />
                            <span>＋</span>
                          </label>
                        }
                      />
                    } />
                  )}
                  {bgMode === "aurora" && (
                    <Item label="Aurora speed" hint="Drift speed of the blobs" control={
                      <Seg
                        value={filters.warpSpeed ?? 1}
                        options={[{ v: 0, l: "Off" }, { v: 0.5, l: "Slow" }, { v: 1, l: "Normal" }, { v: 2, l: "Fast" }, { v: 4, l: "Warp" }]}
                        onChange={(v) => setFlag("warpSpeed", v)}
                      />
                    } />
                  )}
                </Group>
              </>
            )}

            {showSection("conversation") && (
              <>
                <Group title="Conversation" desc="Which message types appear in the feed.">
                  {CONVO.filter((r) => hit(r.label, r.hint)).map((r) => (
                    <ToggleItem key={r.key} color={r.color} label={r.label} hint={r.hint} checked={!!filters[r.key]} onChange={(v) => setFlag(r.key, v)} />
                  ))}
                </Group>
                <Group title="Plans & results" desc="Claude's working artifacts.">
                  {RESULTS.filter((r) => hit(r.label, r.hint)).map((r) => (
                    <ToggleItem key={r.key} color={r.color} label={r.label} hint={r.hint} checked={!!filters[r.key]} onChange={(v) => setFlag(r.key, v)} />
                  ))}
                </Group>
              </>
            )}

            {showSection("tools") && (
              <>
                <Group title="Tool calls" desc="How tool activity renders in the feed." visible={hit("tool calls master filtered display dot pill hidden")}>
                  <ToggleItem color={KIND_COLOR.toolcall} label="Show tool calls" hint="Master toggle for all categories" checked={!!filters.tool_use} onChange={(v) => setFlag("tool_use", v)} />
                  <Item label="Filtered tool display" hint="How filtered-out tool calls render" control={
                    <Seg
                      value={filters.filteredToolDisplay}
                      options={[{ v: "dot", l: "Dot" }, { v: "pill", l: "Pill" }, { v: "hidden", l: "Hidden" }]}
                      onChange={(v) => setFlag("filteredToolDisplay", v)}
                    />
                  } />
                </Group>
                <Group
                  title={`Categories`}
                  desc={`${onCount} of ${TOOL_CATS.length} categories visible.`}
                  actions={
                    <>
                      <button className="sm-btn small" onClick={() => setAllCats(true)}>Show all</button>
                      <button className="sm-btn small" onClick={() => setAllCats(false)}>Hide all</button>
                    </>
                  }
                >
                  <div className={"sm-grid" + (filters.tool_use ? "" : " dim")}>
                    {TOOL_CATS.filter((c) => hit(c.label, c.key)).map((c) => (
                      <ToggleItem key={c.key} color={c.color} label={c.label} hint={c.key} checked={!!filters.toolCategories[c.key]} onChange={(v) => setCat(c.key, v)} />
                    ))}
                  </div>
                </Group>
              </>
            )}

            {showSection("workspace") && (
              <>
                <Group title="Launch" desc="The new-session screen." visible={hit("recent folders launch")}>
                  <Item label="Recent folders" hint="How many to list on the launch screen" control={
                    <Seg
                      value={filters.recentFoldersLimit ?? 5}
                      options={[{ v: 0, l: "Off" }, { v: 3, l: "3" }, { v: 5, l: "5" }, { v: 10, l: "10" }, { v: 15, l: "15" }]}
                      onChange={(v) => setFlag("recentFoldersLimit", v)}
                    />
                  } />
                </Group>
                <Group title="Tabs" desc="Session tab placement." visible={hit("tabs position top left")}>
                  <Item label="Tab position" hint="Top bar, or a left rail" control={
                    <Seg
                      value={filters.tabPosition || "top"}
                      options={[{ v: "top", l: "Top" }, { v: "left", l: "Left" }]}
                      onChange={(v) => setFlag("tabPosition", v)}
                    />
                  } />
                </Group>
                <Group title="Terminal" desc="The embedded console." visible={hit("composer terminal dictation prompt input")}>
                  <ToggleItem
                    color="#27B8FD"
                    label="Prompt composer"
                    hint="An input box under the terminal (dictation-friendly); off = type straight into the console"
                    checked={!!filters.showComposer}
                    onChange={(v) => setFlag("showComposer", v)}
                  />
                </Group>
              </>
            )}

            {showSection("about") && (
              <Group title="About" desc="App version and updates.">
                <About />
              </Group>
            )}
          </div>

          <footer className="sm-foot">
            <button className="sm-btn ghost" onClick={reset} title="Restore every setting to its default">↺ Reset to defaults</button>
            <button className="sm-btn primary" onClick={onClose}>Done</button>
          </footer>
        </main>
      </div>
    </div>
  );
}
