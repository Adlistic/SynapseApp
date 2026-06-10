import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// A real, interactive terminal backed by a ConPTY/PTY shell in the Rust backend.
// Output streams in via the `term-data` event; keystrokes go out via `term_input`.
// Extras: a restart overlay when the process exits, and an optional composer —
// a plain <input> that forwards a line to the PTY. The composer is a normal
// editable field, so dictation tools (HyperVoice) can target it even though the
// terminal itself is a canvas they can't type into.
export default function TerminalPane({ cwd, command, onTermId, composer = false }) {
  const hostRef = useRef(null);
  const termIdRef = useRef(null);
  const [exited, setExited] = useState(false);
  const [runSeq, setRunSeq] = useState(0); // bump to relaunch the PTY
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setExited(false);
    const term = new XTerm({
      fontSize: 12.5,
      fontFamily: '"Cascadia Code", ui-monospace, "Consolas", monospace',
      cursorBlink: true,
      theme: { background: "#0a0f1d", foreground: "#d9e4ff", cursor: "#27b8fd" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const host = hostRef.current;
    term.open(host);
    try { fit.fit(); } catch {}

    // Dictation tools (HyperVoice) only deliver text to controls UI-automation
    // reports as editable. xterm's focused helper textarea is marked
    // aria-hidden, so they skip it and the terminal looks un-typeable. Unhide
    // it, and forward any automation-inserted text to the PTY as a paste —
    // xterm itself ignores non-IME textarea input, so without this the text
    // would vanish. (Normal typing never lands in the textarea: xterm handles
    // it on keydown, so this listener only fires for automation/dictation.)
    const ta = term.textarea;
    const onTaInput = (e) => {
      if (e.isComposing) return; // IME composition is xterm's to handle
      const v = ta.value;
      if (v) {
        ta.value = "";
        term.paste(v);
      }
    };
    if (ta) {
      ta.removeAttribute("aria-hidden");
      ta.setAttribute("aria-label", "Terminal input");
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
        const cmd = runSeq > 0 && command ? command.replace("--session-id", "--resume") : command;
        id = await invoke("term_open", { rows: term.rows, cols: term.cols, cwd: cwd || null, command: cmd || null });
        if (disposed) { invoke("term_close", { id }); return; }
        termIdRef.current = id;
        onTermId?.(id);

        unlistenData = await listen("term-data", (e) => {
          if (!e.payload || e.payload.id !== id) return;
          term.write(new Uint8Array(e.payload.bytes));
        });
        unlistenExit = await listen("term-exit", (e) => {
          if (e.payload === id) {
            term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
            if (!disposed) setExited(true);
          }
        });

        term.onData((d) => invoke("term_input", { id, data: d }));
        term.onResize(({ rows, cols }) => invoke("term_resize", { id, rows, cols }));
      } catch (err) {
        term.write(`\r\n\x1b[31mFailed to open terminal: ${err}\x1b[0m\r\n`);
        if (!disposed) setExited(true);
      }
    })();

    const onResize = () => { try { fit.fit(); } catch {} };
    window.addEventListener("resize", onResize);
    // Fit again shortly after mount, once the drawer has its final size.
    const t = setTimeout(onResize, 60);

    return () => {
      disposed = true;
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
      host?.removeEventListener("contextmenu", onCtx);
      if (ta) ta.removeEventListener("input", onTaInput);
      termIdRef.current = null;
      onTermId?.(null);
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      if (id) invoke("term_close", { id });
      term.dispose();
    };
  }, [runSeq]);

  // Composer: forward a full line (plus Enter) to the PTY.
  function sendDraft() {
    const text = draft;
    if (!text.trim() || termIdRef.current == null) return;
    setDraft("");
    invoke("term_input", { id: termIdRef.current, data: text + "\r" }).catch(() => {});
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
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type or dictate a prompt — Enter sends it to the terminal"
          />
          <button type="submit" disabled={!draft.trim()}>⏎</button>
        </form>
      )}
    </div>
  );
}
