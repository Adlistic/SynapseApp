import { createContext } from "react";

// Things the reader can do beyond showing text. Provided by App for the
// active session; every entry is optional so the reader also renders
// read-only (the agent panel, tests, the preview harness).
//   key(data)        send raw keys to the session's terminal
//   send(text)       type a reply into the terminal and press Enter
//   focusTerminal()  put the keyboard in the terminal
//   openAgent(id)    open a subagent's own feed (id = its tool-use id)
//   togglePin(turn)  pin / unpin a turn
export const ReaderActions = createContext({});

// The short name of the agent the session runs ("Claude" or "Codex"), for
// the reader's own words about it.
export const AgentName = createContext("Claude");
