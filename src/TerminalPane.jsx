import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// A real, interactive terminal backed by a ConPTY/PTY shell in the Rust backend.
// Output streams in via the `term-data` event; keystrokes go out via `term_input`.
export default function TerminalPane({ cwd, command, onTermId }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const term = new XTerm({
      fontSize: 12.5,
      fontFamily: '"Cascadia Code", ui-monospace, "Consolas", monospace',
      cursorBlink: true,
      theme: { background: "#090c12", foreground: "#d6e1ff", cursor: "#5ad0c4" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const host = hostRef.current;
    term.open(host);
    try { fit.fit(); } catch {}

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
        id = await invoke("term_open", { rows: term.rows, cols: term.cols, cwd: cwd || null, command: command || null });
        if (disposed) { invoke("term_close", { id }); return; }
        onTermId?.(id);

        unlistenData = await listen("term-data", (e) => {
          if (!e.payload || e.payload.id !== id) return;
          term.write(new Uint8Array(e.payload.bytes));
        });
        unlistenExit = await listen("term-exit", (e) => {
          if (e.payload === id) term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        });

        term.onData((d) => invoke("term_input", { id, data: d }));
        term.onResize(({ rows, cols }) => invoke("term_resize", { id, rows, cols }));
      } catch (err) {
        term.write(`\r\n\x1b[31mFailed to open terminal: ${err}\x1b[0m\r\n`);
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
      onTermId?.(null);
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      if (id) invoke("term_close", { id });
      term.dispose();
    };
  }, []);

  return <div className="xterm-host" ref={hostRef} />;
}
