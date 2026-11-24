import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pulseInput } from "./visuals/Orb.jsx";

// What reached the terminal, for the orb: a paste/dictation counts its text,
// a key counts one; focus reports, arrows and other escape codes don't count.
function orbInput(d) {
  // (a pasted newline doesn't send the prompt, so a paste is never "enter")
  if (d.startsWith("\x1b[200~")) return pulseInput(Math.max(1, d.length - 12));
  if (d.startsWith("\x1b")) return;
  pulseInput(d.length, d.includes("\r"));
}

// A real, interactive terminal backed by a ConPTY/PTY shell in the Rust backend.
// Output streams in via the `term-data` event; keystrokes go out via `term_input`.
// Extras: a restart overlay when the process exits, and an optional composer —
// a plain <input> that forwards a line to the PTY. The composer is a normal
// editable field, so dictation tools (HyperVoice) can target it even though the
// terminal itself is a canvas they can't type into.
// A full 16-colour ANSI palette tuned to Synapse's navy background, so Claude
// Code's own colours (diffs, prompts, spinners, links) read clearly.
const TERM_THEME = {
  background: "#0a0f1d",
  foreground: "#d9e4ff",
  cursor: "#27b8fd",
  cursorAccent: "#0a0f1d",
  selectionBackground: "rgba(39, 184, 253, 0.28)",
  black: "#1b2335",
  red: "#f0786e",
  green: "#7fd88f",
  yellow: "#f2c879",
  blue: "#6fa8f5",
  magenta: "#c49bf2",
  cyan: "#5ad0c4",
  white: "#c3cde2",
  brightBlack: "#5f6a82",
  brightRed: "#ff9a91",
  brightGreen: "#a3ecb0",
  brightYellow: "#ffdc9a",
  brightBlue: "#9cc4ff",
  brightMagenta: "#dcbcff",
  brightCyan: "#8fe7dd",
  brightWhite: "#f4f7fd",
};

export default function TerminalPane({ cwd, command, resumeCommand = null, onTermId, onApi, composer = false, fontSize = 13 }) {
  const hostRef = useRef(null);
  const termIdRef = useRef(null);
  const exitedRef = useRef(false);
  const [exited, setExited] = useState(false);
  const [runSeq, setRunSeq] = useState(0); // bump to relaunch the PTY
  const [draft, setDraft] = useState("");
  const composerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    setExited(false);
    exitedRef.current = false;
    const term = new XTerm({
      fontSize,
      fontFamily: '"Cascadia Code", "JetBrains Mono Variable", ui-monospace, "Consolas", monospace',
      cursorBlink: true,
      theme: TERM_THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const host = hostRef.current;
    term.open(host);
    // FitAddon can round up a row on fractional display scaling (125%/150%),
    // so the last terminal line ends up under the composer / below the panel.
    // After fitting, drop rows until the rendered screen fits its box.
    const fitSafe = () => {
      try { fit.fit(); } catch { return; }
      const screen = term.element?.querySelector(".xterm-screen");
      if (!screen || !term.rows || screen.offsetHeight <= host.clientHeight) return;
      const cellH = screen.offsetHeight / term.rows;
      const rows = Math.max(2, Math.floor(host.clientHeight / cellH));
      if (rows < term.rows) term.resize(term.cols, rows);
    };
    fitSafe();
    termRef.current = term;
    fitRef.current = fitSafe;

    // Dictation tools (HyperVoice) only deliver text to controls UI-automation
    // reports as editable. xterm's focused helper textarea is marked
    // aria-hidden, so they skip it and the terminal looks un-typeable. Unhide
    // it, and forward any automation-inserted text to the PTY as a paste —
    // xterm itself ignores non-IME textarea input, so without this the text
    // would vanish. (Normal typing never lands in the textarea: xterm handles
    // it on keydown, so this listener only fires for automation/dictation.)
    const ta = term.textarea;
    // Keyboard keystrokes reach the PTY through xterm's own pipeline, but some
    // (space, notably) also leave their character behind in the textarea —
    // forwarding that residue sent the space TWICE. A real keystroke always
    // fires keydown immediately before the input event; automation/dictation
    // inserts text with no keydown at all. That's the discriminator.
    let lastKeyDownAt = 0;
    const onTaKeyDown = () => { lastKeyDownAt = Date.now(); };
    const onTaInput = (e) => {
      if (e.isComposing) return; // IME composition is xterm's to handle
      const v = ta.value;
      if (!v) return;
      ta.value = ""; // always drain, so stale residue never rides a later paste
      if (Date.now() - lastKeyDownAt < 100) return; // typing residue — xterm already sent it
      term.paste(v);
    };
    if (ta) {
      ta.removeAttribute("aria-hidden");
      ta.setAttribute("aria-label", "Terminal input");
      ta.addEventListener("keydown", onTaKeyDown);
      ta.addEventListener("input", onTaInput);
    }

    // Clipboard: read the OS clipboard via Rust (the WebView2 clipboard doesn't
    // reliably deliver paste into xterm) and inject it through xterm's paste
    // (which honors bracketed-paste and routes to the PTY via onData).
    const doPaste = async () => {
      try { const txt = await invoke("clip_get"); if (txt) term.paste(txt); } catch {}
    };
    // Copy/paste keybindings, Windows-Terminal style:
    //   Ctrl+Shift+C, or Ctrl+C with a selection → copy (else Ctrl+C = SIGINT)
    //   Ctrl+V / Ctrl+Shift+V → paste from the OS clipboard
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+Enter / Shift+Enter → newline in Claude Code's input, not submit.
      // xterm sends plain \r for both (it lacks the enhanced key encoding
      // Windows Terminal uses), so claude can't tell them apart from Enter.
      // ESC+CR is claude's Alt/Option+Enter newline sequence — send that.
      if (e.type === "keydown" && e.key === "Enter" && (e.ctrlKey || e.shiftKey) && !e.altKey) {
        if (termIdRef.current != null) {
          invoke("term_input", { id: termIdRef.current, data: "\x1b\r" }).catch(() => {});
        }
        return false;
      }
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      if (e.code === "KeyC") {
        const sel = term.getSelection();
        if (e.shiftKey || sel) {
          if (sel) invoke("clip_set", { text: sel }).catch(() => {});
          term.clearSelection();
          return false; // handled — don't also send ^C
        }
        return true; // no selection → let ^C through as interrupt
      }
      if (e.code === "KeyV") {
        // Let xterm's NATIVE paste handle Ctrl+V. The native paste reads
        // clipboardData *synchronously* during the browser paste event, which is
        // essential for tools like HyperVoice that put text on the clipboard only
        // briefly and then restore the previous contents. An async clip_get here
        // would read the clipboard too late (after the restore) and miss it.
        // Returning false suppresses the literal ^V without cancelling the paste.
        return false;
      }
      return true;
    });
    // Right-click to paste.
    const onCtx = (e) => { e.preventDefault(); doPaste(); };
    host.addEventListener("contextmenu", onCtx);

    let unlistenData = null;
    let unlistenExit = null;
    let id = null;
    let disposed = false;

    (async () => {
      try {
        // A restarted pane must RESUME the session — re-running `--session-id`
        // fails once the session exists on disk.
        // (Codex can't be told an id up front, so its resume line is handed in
        // once the session exists; until then a restart starts it afresh.)
        const cmd = runSeq > 0 && command ? resumeCommand || command.replace("--session-id", "--resume") : command;
        id = await invoke("term_open", { rows: term.rows, cols: term.cols, cwd: cwd || null, command: cmd || null });
        if (disposed) { invoke("term_close", { id }); return; }
        termIdRef.current = id;
        onTermId?.(id);
        // What the reader may do with this terminal. Deliberately narrow:
        // it can look at what is on screen, press a key, or put text in the
        // input for you to send — it never presses Enter on text.
        onApi?.({
          openedAt: Date.now(),
          alive: () => !exitedRef.current,
          focus: () => term.focus(),
          send: (data) => invoke("term_input", { id, data }).catch(() => {}),
          // The visible screen as text, so a shortcut can check the prompt it
          // is about to answer is really the one showing.
          // The last rows of output wherever the view is scrolled to: what
          // Claude Code is showing right now (a prompt, or a running step).
          bottom: (n = 16) => {
            const b = term.buffer.active;
            const rows = [];
            for (let y = b.baseY; y < b.baseY + term.rows; y++) {
              const line = b.getLine(y)?.translateToString(true) || "";
              if (line.trim()) rows.push(line);
            }
            return rows.slice(-n).join("\n");
          },
          screen: () => {
            const b = term.buffer.active;
            const rows = [];
            for (let y = b.viewportY; y < b.viewportY + term.rows; y++) rows.push(b.getLine(y)?.translateToString(true) || "");
            return rows.join("\n");
          },
          // Put text in the terminal's input as a paste. Control characters
          // are dropped (an escape sequence in pasted text could otherwise end
          // the paste early and act as keystrokes). If the program running
          // doesn't take pastes as a block, newlines become spaces so no line
          // can run on its own.
          // Add text to the composer box (if it is showing) and put the cursor
          // there. Never sends. Returns false when there is no composer.
          compose: (text) => {
            const el = composerRef.current;
            if (!el) return false;
            const t = String(text).replace(/\s*\r?\n+\s*/g, " ").trim();
            if (!t) return true;
            setDraft((d) => (d && !/\s$/.test(d) ? d + " " + t : d + t));
            requestAnimationFrame(() => {
              el.focus();
              const end = el.value.length;
              try { el.setSelectionRange(end, end); } catch { /* ignore */ }
            });
            return true;
          },
          paste: (text) => {
            // eslint-disable-next-line no-control-regex
            let t = String(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
            if (!term.modes.bracketedPasteMode) t = t.replace(/\s*\n+\s*/g, " ");
            term.paste(t);
            term.focus();
          },
        });

        unlistenData = await listen("term-data", (e) => {
          if (!e.payload || e.payload.id !== id) return;
          term.write(new Uint8Array(e.payload.bytes));
        });
        unlistenExit = await listen("term-exit", (e) => {
          if (e.payload === id) {
            term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
            exitedRef.current = true;
            if (!disposed) setExited(true);
          }
        });

        term.onData((d) => { invoke("term_input", { id, data: d }); orbInput(d); });
        term.onResize(({ rows, cols }) => invoke("term_resize", { id, rows, cols }));
      } catch (err) {
        term.write(`\r\n\x1b[31mFailed to open terminal: ${err}\x1b[0m\r\n`);
        if (!disposed) setExited(true);
      }
    })();

    // Refit whenever the pane itself changes size — not just the window. The
    // terminal ran off the bottom when the header grew after first fit (web
    // fonts loading, a banner appearing, the split being dragged).
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // A background tab is display:none (0×0). Fitting then shrinks the
        // terminal to a sliver and tells Claude to re-wrap at ~10 columns —
        // the garbled view you saw on switching back. Skip until visible; the
        // observer fires again the moment the tab is shown.
        if (!host.offsetWidth || !host.offsetHeight) return;
        fitSafe();
      });
    };
    window.addEventListener("resize", onResize);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    ro?.observe(host);
    document.fonts?.ready?.then(onResize).catch(() => {});
    // Fit again shortly after mount, once the drawer has its final size.
    const t = setTimeout(onResize, 60);

    return () => {
      disposed = true;
      clearTimeout(t);
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", onResize);
      host?.removeEventListener("contextmenu", onCtx);
      if (ta) {
        ta.removeEventListener("keydown", onTaKeyDown);
        ta.removeEventListener("input", onTaInput);
      }
      termIdRef.current = null;
      onTermId?.(null);
      onApi?.(null);
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      if (id) invoke("term_close", { id });
      term.dispose();
    };
  }, [runSeq]);

  // Text size changes (Settings, or Ctrl+scroll over the terminal): resize the
  // font in place and refit, which tells Claude Code the new rows/columns.
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    requestAnimationFrame(() => fitRef.current?.());
  }, [fontSize]);

  // Composer: forward a full line (plus Enter) to the PTY.
  //
  // The text and the Enter go as two separate writes. Sent as one ("text\r"),
  // Claude Code and Codex see a burst of input ending in Enter, take it for a
  // paste, and turn that Enter into a new line instead of sending. So the text
  // goes first, marked as a paste when the program asked for that (bracketed
  // paste), and Enter follows a moment later as its own keypress.
  //
  // The text is read from the field itself, not from React state: dictation
  // ("…send it") fills the box and presses Enter almost at once, before React
  // has re-rendered, so the state can still hold the old (or empty) text.
  function sendDraft() {
    const id = termIdRef.current;
    // eslint-disable-next-line no-control-regex
    const text = String(composerRef.current?.value ?? draft).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
    if (!text.trim() || id == null) return;
    setDraft("");
    pulseInput(text.length, true);
    const bracketed = !!termRef.current?.modes?.bracketedPasteMode;
    invoke("term_input", { id, data: bracketed ? `\x1b[200~${text}\x1b[201~` : text })
      .then(() => new Promise((r) => setTimeout(r, 120)))
      .then(() => invoke("term_input", { id, data: "\r" }))
      .catch(() => {});
  }

  return (
    <div className="term-wrap">
      <div className="xterm-host" ref={hostRef} />
      {exited && (
        <div className="term-exited">
          <span>process exited</span>
          <button onClick={() => setRunSeq((n) => n + 1)}>↻ Restart</button>
        </div>
      )}
      {composer && (
        <form
          className="term-composer"
          onSubmit={(e) => { e.preventDefault(); sendDraft(); }}
          title="Typed (or dictated) text is sent to the terminal as if you typed it there"
        >
          <input
            ref={composerRef}
            type="text"
            value={draft}
            onChange={(e) => { const grew = e.target.value.length - draft.length; setDraft(e.target.value); if (grew > 0) pulseInput(grew); }}
            placeholder="Type or dictate a prompt — Enter sends it to the terminal"
          />
          <button type="submit" disabled={!draft.trim()}>⏎</button>
        </form>
      )}
    </div>
  );
}
