import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AgentName } from "./reader/actions.js";

// "Talk to Claude" card: promotes dictating prompts with HyperVoice.
//   - HyperVoice not installed → a rotating reason to try it, one line on what
//     HyperVoice is, "Get HyperVoice, free" (Store) + a link to hypervoice.app.
//   - Installed → a rotating tip for using it here + a link to hypervoice.app.
// Shown at the bottom of the left rail, or from a mic button in the top bar
// (tabs-on-top layout). Detection is a local file check only.
//
// Closing (2026-11-16 rules):
//   - Not installed: the close button never removes the offer. The rail card
//     shrinks to a one-line "Try HyperVoice" strip (the top-bar button stays);
//     the full card returns after 7 days; after the 3rd close it stays a strip.
//   - Installed (tips only): close hides it for 14 days.

const DAY = 24 * 60 * 60 * 1000;
const PITCH_CLOSED_AT = "hvcode.hvpromo.pitchClosedAt.v1"; // not installed
const PITCH_CLOSES = "hvcode.hvpromo.pitchCloses.v1";
const TIPS_CLOSED_AT = "hvcode.hvpromo.dismissedAt.v1"; // installed
const TIP_KEY = "hvcode.hvpromo.tip.v1";
const PITCH_SNOOZE_MS = 7 * DAY;
const PITCH_MAX_CLOSES = 3;
const TIPS_SNOOZE_MS = 14 * DAY;
// open_external refuses "&", so each link carries exactly one query parameter.
const STORE_URL = (src) => `https://hypervoice.app/api/go/ms-store?source=${src}`;
const SITE_URL = (src) => `https://hypervoice.app/?utm_source=${src}`;

// Shown before HyperVoice is installed: why you'd want it here.
const PITCH = [
  { t: "Talk to Claude instead of typing", b: "Press a hotkey, say your prompt, and it's typed straight into this terminal." },
  { t: "Explain it like you would to a colleague", b: "Spoken prompts carry the context typed ones skip: what you tried and what broke." },
  { t: "Answer Claude's questions out loud", b: "Just say your answer. It lands in the terminal, ready to send." },
];

// Shown once HyperVoice is installed: how to get the most from it here.
const TIPS = [
  { t: "Say it, don't type it", b: "Click into the terminal, press your HyperVoice hotkey (Ctrl+Shift+Space by default) and say your prompt. The text lands where the cursor is." },
  { t: "Explain it like you would to a colleague", b: "Spoken prompts tend to carry the context typed ones leave out: what you tried, what you expected, what broke." },
  { t: "Long prompt? Use the composer", b: "Turn on Settings → Workspace → Prompt composer. A box appears under the terminal: dictate into it, tidy it up, then press Enter to send." },
  { t: "Answer Claude's questions out loud", b: "When Claude asks you something in prose, dictate into the reply box under the question." },
  { t: "Teach it your project's words", b: "Add file, library and product names to HyperVoice's Dictionary so they come out spelled right." },
];

function Mic({ size = 13 }) {
  return (
    <svg className="hvp-mic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8" />
    </svg>
  );
}

function readNum(key) {
  try { return parseFloat(localStorage.getItem(key)) || 0; } catch { return 0; }
}
function writeNum(key, v) {
  try { localStorage.setItem(key, String(v)); } catch { /* ignore */ }
}

/** Shared "is HyperVoice installed?" check; re-runs when the window regains focus. */
export function useHvInstalled() {
  const [installed, setInstalled] = useState(null); // null = not checked yet
  useEffect(() => {
    let alive = true;
    const check = () => invoke("hypervoice_installed").then((v) => alive && setInstalled(!!v)).catch(() => alive && setInstalled(false));
    check();
    window.addEventListener("focus", check);
    return () => { alive = false; window.removeEventListener("focus", check); };
  }, []);
  return installed;
}

function pitchCollapsed() {
  return readNum(PITCH_CLOSES) >= PITCH_MAX_CLOSES || Date.now() - readNum(PITCH_CLOSED_AT) < PITCH_SNOOZE_MS;
}

function useHvPromo() {
  const installed = useHvInstalled();
  const [, bump] = useState(0); // re-render after a close
  const [tip, setTip] = useState(() => {
    // Advance one tip per launch so each start shows something new.
    const next = (readNum(TIP_KEY) + 1) % 60; // 60 = divisible by both list lengths
    writeNum(TIP_KEY, next);
    return next;
  });
  const tipsHidden = Date.now() - readNum(TIPS_CLOSED_AT) < TIPS_SNOOZE_MS;
  const collapsed = pitchCollapsed();
  const close = () => {
    if (installed) {
      writeNum(TIPS_CLOSED_AT, Date.now());
    } else {
      writeNum(PITCH_CLOSED_AT, Date.now());
      writeNum(PITCH_CLOSES, readNum(PITCH_CLOSES) + 1);
    }
    bump((n) => n + 1);
  };
  const nextTip = () => setTip((i) => (i + 1) % 60);
  return { installed, tipsHidden, collapsed, close, tip, nextTip };
}

const go = (url) => invoke("open_external", { url }).catch(() => {});

function Card({ installed, tip, nextTip, onClose, source, inPopover = false }) {
  const list = installed ? TIPS : PITCH;
  // The copy names the session's agent (Claude or Codex).
  const agent = useContext(AgentName);
  const raw = list[tip % list.length];
  const t = { t: raw.t.replace(/Claude/g, agent), b: raw.b.replace(/Claude/g, agent) };
  const closeLabel = installed ? "Hide tips for 14 days" : inPopover ? "Close" : "Show less";
  return (
    <div className="hvp-card">
      <button className="hvp-x" onClick={onClose} title={closeLabel} aria-label={closeLabel}>✕</button>
      <div className="hvp-kicker"><Mic /> {installed ? "HyperVoice tip" : "Try HyperVoice"}</div>
      <div className="hvp-title">{t.t}</div>
      <div className="hvp-body">{t.b}</div>
      {installed ? (
        <div className="hvp-links">
          <button className="hvp-link" onClick={() => go(SITE_URL(source))}>hypervoice.app ↗</button>
          <button className="hvp-link" onClick={nextTip}>Next →</button>
        </div>
      ) : (
        <>
          <div className="hvp-what">
            <b>HyperVoice</b> is our dictation app: talk, and it types for you in any app. Free to start.
          </div>
          <button className="hvp-btn" onClick={() => go(STORE_URL(source))}>Get HyperVoice, free</button>
          <div className="hvp-links">
            <button className="hvp-link" onClick={() => go(SITE_URL(source))}>hypervoice.app ↗</button>
            <button className="hvp-link" onClick={nextTip}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Bottom-of-left-rail card (or, once shrunk, a one-line strip). */
// Height the full card needs; if the tabs plus this won't fit, show the strip.
const CARD_ROOM = 320;
const NARROW_RAIL = 170;

export function HvPromoRail() {
  const agent = useContext(AgentName);
  const p = useHvPromo();
  const [expanded, setExpanded] = useState(false); // strip clicked open this session
  const [tight, setTight] = useState(false);
  const ref = useRef(null);
  // Measure against the tabs' CONTENT height (sum of the scroller's children),
  // which doesn't change with the card's own size, so this can't flip back
  // and forth. (scrollHeight won't do: the scroller stretches to fill.)
  useLayoutEffect(() => {
    const measure = () => {
      const rail = ref.current?.parentElement;
      const tabsEl = rail?.querySelector(".tabbar-scroll");
      if (!rail || !tabsEl) return;
      const content = Array.from(tabsEl.children).reduce((h, c) => h + c.offsetHeight + 3, 0);
      const t = content + CARD_ROOM > rail.clientHeight || rail.clientWidth < NARROW_RAIL;
      setTight((prev) => (prev === t ? prev : t));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  if (p.installed === null) return null;
  if (p.installed && p.tipsHidden) return null;
  if ((tight || (!p.installed && p.collapsed)) && !expanded) {
    return (
      <div className="hvp-rail" ref={ref}>
        <button
          className="hvp-strip"
          onClick={() => setExpanded(true)}
          title={p.installed ? "Show a HyperVoice tip" : `Talk to ${agent} instead of typing`}
        >
          <Mic /> {p.installed ? "HyperVoice tip" : "Try HyperVoice"}
        </button>
      </div>
    );
  }
  return (
    <div className="hvp-rail" ref={ref}>
      <Card
        installed={p.installed}
        tip={p.tip}
        nextTip={p.nextTip}
        onClose={() => { p.close(); setExpanded(false); }}
        source="hvcode_rail"
      />
    </div>
  );
}

/** Top-bar mic button (tabs-on-top layout) that opens the same card. */
export function HvPromoChip() {
  const agent = useContext(AgentName);
  const p = useHvPromo();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const chipRef = useRef(null);
  const popRef = useRef(null);
  const closePop = () => { setOpen(false); chipRef.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    // Move focus into the popover so keyboard users land on its controls.
    popRef.current?.querySelector("button")?.focus();
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") closePop(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  if (p.installed === null) return null;
  if (p.installed && p.tipsHidden) return null; // the pitch's button never goes away
  return (
    <div className="hvp-chip-wrap" ref={ref}>
      <button
        ref={chipRef}
        className={"filters-btn hvp-chip" + (p.installed ? "" : " pitch")}
        onClick={() => setOpen((o) => !o)}
        title={p.installed ? "HyperVoice tips" : `Talk to ${agent} instead of typing`}
        aria-label={p.installed ? "HyperVoice tips" : undefined}
        aria-haspopup="dialog"
        aria-controls="hvp-pop"
        aria-expanded={open}
      >
        <Mic size={14} />
        {!p.installed && <span className="hvp-chip-label">Try HyperVoice</span>}
      </button>
      {open && (
        <div className="hvp-pop" id="hvp-pop" role="dialog" aria-label="HyperVoice" ref={popRef}>
          <Card installed={p.installed} tip={p.tip} nextTip={p.nextTip} onClose={() => { p.close(); closePop(); }} source="hvcode_chip" inPopover />
        </div>
      )}
    </div>
  );
}

/** One line under "Nothing to read yet" in a new session. Not dismissible. */
export function HvEmptyHint() {
  const installed = useHvInstalled();
  if (installed === null) return null;
  if (installed) {
    return <span className="hvp-empty">Tip: click into the terminal and press your HyperVoice hotkey to say your prompt.</span>;
  }
  return (
    <span className="hvp-empty">
      Tip: talk instead of typing with{" "}
      <button className="hvp-link" onClick={() => go(STORE_URL("hvcode_empty"))}>HyperVoice, free ↗</button>
    </span>
  );
}
