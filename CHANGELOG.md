# Changelog

All notable changes to Synapse (Claude Code Workspace) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.7] — 2026-09-17

### Fixed
- **Update checks on window focus** — coming back to the app now checks for
  updates (at most once per half hour), instead of waiting for the six-hour
  timer. Previously the "re-check when visible again" never fired on Windows.

## [0.2.6] — 2026-09-17

### Added
- **Version in the top bar** — the running version now shows next to the
  Synapse wordmark, so you can always see which build you're on at a glance.

## [0.2.5] — 2026-09-17

### Changed
- **Cumulative what's new** — the update modal now lists every release
  between the version you're running and the latest one, newest first, so
  skipping a version never means missing its notes.

## [0.2.4] — 2026-09-17

### Changed
- **What's-new modal for updates** — clicking "⬆ Update available" now opens
  a proper centered modal with the release notes (no more hovering to see
  them), with Restart to update, Skip this version, and Later.
- **What's new in Settings** — Settings → About → "What's new" reopens the
  current version's changelog anytime.

## [0.2.3] — 2026-09-17

### Changed
- **Update button** — an available update now shows as a compact
  "⬆ Update available" button at the top right instead of a full-width bar.
  Click it to read what's new for that release, then "Restart to update"
  when it suits you — or "Skip this version". Updates still download
  silently in the background, are signature-verified, and never install
  themselves.
- **Release notes in-app** — the update popover (and the GitHub release
  page) now shows the changelog section for the new version, so you can see
  what you're getting before you restart.

## [0.2.2] — 2026-09-17

### Added
- **Mission Control dashboard** — press Ctrl+Shift+B (or click the fleet chip
  in the topbar) for a live view over every open session: status lights,
  current activity, Claude's own todo plan with progress, running subagents,
  a context-window gauge, token/cost counters, tool-mix bars, and a
  15-minute activity sparkline per session.
- **Fleet chip in the topbar** — sessions · working · need-you · live agents,
  always visible; click it to open Mission Control.
- **Per-tab status indicators** — every tab now shows a status at a glance:
  pulsing green while working, amber ⚠ / ? / ▤ when Claude is waiting for an
  approval, an answer, or a plan review, dim when idle.
- **Project grouping** — sessions in the same folder get stable numbered
  names ("MyApp · 2"), a shared identity color on tabs and dashboard cards,
  grouped dashboard sections with per-project rollups, and grouped headers in
  the left tab rail.
- **Resizable left tab rail** — drag its edge; the width persists. The app
  window's size and position now persist across restarts too.
- **Background auto-updates** — updates now check every 6 hours and download
  silently in the background (signature-verified); a slim bar offers
  "Restart to update" when one is ready. Nothing installs until you say so,
  so a running Claude turn is never interrupted. Skip a version and the next
  release re-offers automatically.

### Fixed
- **Background color swatches** — the Settings chips for the aurora/color
  background were all rendering as near-black dots in dark mode; they now
  show their actual hues.
- **Header chip legibility** — the token and session/week chips use
  full-brightness text in dark mode.
- **Embedded sessions always save transcripts** — terminals now strip
  inherited Claude Code child-session markers, so the conversation pane can
  never come up permanently empty when Synapse itself was launched from a
  Claude Code session.

## [0.2.1] — 2026-06-12

### Added
- **Search highlighting** — in-session search now paints every match in the
  rendered feed (markdown, plain text, tool output alike) via the CSS Custom
  Highlight API, in brand gold.
- **Needs-attention awareness** — an amber dot on any tab whose session looks
  stalled on a tool approval (last activity was a tool call that never
  returned), plus a "⚠ waiting?" hint in the topbar for the active tab.
- **Finish notifications** — a Windows toast when Claude finishes working in a
  background tab (or while the app is unfocused): "Claude finished — N new
  steps." Toggle under Settings → Workspace → Notifications.
- **Usage-limit chips for everyone** — Settings → Workspace → Usage limits can
  now install a silent Claude Code status-line hook that feeds the
  session/weekly chips (one click; never clobbers an existing custom status
  line — those get a copyable snippet instead).
- **"What's new" after updates** — the relevant changelog section appears once
  after each auto-update.
- **First-run welcome** — a three-step intro (sessions & tabs, terminal +
  conversation, hotkeys) for new installs.

### Changed
- Session-browser project folders are collapsed by default.

### Fixed
- Startup no longer re-finalizes the account claim on every launch (which
  logged a misleading "token expired" warning) — it now only runs when the
  server actually reports an unclaimed token, then retries.

## [0.2.0] — 2026-06-11

### Added
- **Session browser + resume** — "⧉ …or resume a previous session" on the launch
  screen (and a ⧉ tab-bar button): lists every Claude Code session on this
  machine (scanned from `~/.claude/projects`, grouped by project, titled from
  the transcript), with **cross-transcript search**, **rename** (✎, stored
  locally), and one click to resume a session in a new tab (`claude --resume`)
  with its full history preloaded in the turn panel.
- **Prompt composer** under the terminal — a normal input field that sends a
  line to the PTY. Because it's a real `<input>`, HyperVoice dictation can
  target it (the terminal canvas itself can't receive dictated text).
- **Worktree lifecycle on close** — closing a worktree-isolated session now asks
  what to do with its changes: merge into the main folder (commits leftover
  work first), keep, or discard. The launch screen also offers one-click
  cleanup of old session worktrees left in a folder.
- **Token usage chip** in the topbar (input/output, cache details on hover),
  summed from the transcript's per-message usage.
- **Export conversation** as Markdown or JSON (⤓ buttons in the turn panel).
- **Restart button** when the terminal's process exits; **"Check for updates"**
  in Settings with visible feedback (the boot-time check stays silent).
- Session-start watchdog: if no transcript appears within ~12s, a banner says so
  instead of an empty panel forever.
- **Unified conversation feed** — the split "Your messages / Claude's response"
  scrollboxes are gone. One feed: each prompt is a collapsible card with the
  responses nested under it; old turns auto-collapse, the latest stays expanded
  and auto-follows, with a floating "↓ latest" button when you scroll up.
  Slash-command bookkeeping (`/model` etc.) renders as quiet ⌘ rows instead of
  raw `<command-name>` tags, and ANSI escape codes are stripped.
- **In-session search** — filter the feed to matching turns (prompt + responses)
  with per-turn match counts; searches the whole session past the display cap.
- **Rate-limit chips** — session (5-hour) and weekly usage next to the token
  chip, each with percentage, a thin progress bar, and a live "resets in 2h 14m"
  countdown. Colors climb gold → orange → red at 50/70/90%. (Data is cached by
  the status-line script on each Claude refresh; requires statusline
  integration, hidden otherwise.)
- **Keyboard shortcuts** — left-hand-first so the mouse never leaves your right
  hand: Ctrl+Shift+T/R/W/F/E/G/S/D (new, resume, close, search, export, latest,
  settings, cheat-sheet), Ctrl+Tab cycling, Ctrl+1–5 tab jumps. A ⌨ topbar
  button (or Ctrl+Shift+D) shows the list in a modal. Click a turn card and
  ↑/↓/Enter/Esc drive the feed without touching the mouse.
- **Tabs** — drag to reorder, double-click to rename (syncs to the session
  browser), right-click context menu (rename / copy path / close), and an
  accent-colored active-tab indicator.
- **Settings, redesigned** — modern two-pane panel: searchable left rail,
  grouped setting cards with descriptions, visual Dark/Light/System theme
  previews, accent swatches, and live "changes save instantly" footer.
- **Theme: light mode + accent colors** — full light theme (terminal stays a
  dark console by design) with a comprehensive contrast pass (diffs, markdown,
  banners, gate, pills), plus customizable accent color.
- **HyperVoice brand palette** — sky blue + orange on near-black navy across
  the app; the ◆ wordmark mirrors the Hyper/Voice two-tone.
- Delete a transcript from the session browser (two-step confirm); project
  folders in the browser are collapsed by default.

### Changed
- **Transcript reading is incremental** — a per-session tailer thread stat-polls
  the JSONL, reads only appended bytes, parses only complete lines, and pushes a
  `syn2:changed` event; `get_conversation` is now a pure in-memory delta read
  (was: full file re-read + re-parse of every line, every second, per tab).
- React rendering: memoized response bubbles/turn cards/pills, memoized turn
  grouping, turn list tail-capped at 120 with "show earlier", parallel tab
  fetches. Old turns no longer re-render (or re-parse markdown/diffs) on poll.
- Aurora background ported to ClaudeConnect's blend-mode technique (`screen` in
  dark, `multiply` in light) with theme-aware bases; chosen background colors
  are brightened in dark / rendered as pale tints in light so they actually
  show through the (now properly translucent) panels, and the Settings swatches
  preview what you'll really get per theme.
- Tool pills are tinted badges with theme-computed colors (hue-preserving —
  no more muddy browns in light mode).
- Terminal dictation: the terminal's input helper is now exposed to UI
  automation and forwards inserted text to the PTY, so HyperVoice can dictate
  straight into the console. The composer is hidden by default (re-enable in
  Settings → Workspace).

### Fixed
- **Blank screen when resuming a session** — a React hooks-ordering crash on
  the launch → first-tab transition; plus an error boundary so any future
  render error shows a readable message instead of a white window.
- Restarting an exited terminal now resumes the session (`--resume`) instead of
  failing on a duplicate `--session-id`.
- Auth: JSON parse failures in claim/entitlement responses are now logged
  instead of silently swallowed; when hypervoice.app is unreachable the sign-in
  screen says so (with a retry) instead of implying you were never signed in.
- Worktree creation no longer has a panic path on a rootless folder.

## [0.1.2] — 2026-06-10

### Fixed
- **"Your plan doesn't include Suite access" for valid Pro/Lifetime accounts.**
  The deep-link token was received but never *finalized* — the app didn't call
  `POST /api/claim`, so `claimed_at` stayed null and `/api/desktop/entitlements`
  returned 409 (read as "no access"). `get_entitlement` now finalizes the claim
  (binds a persistent device id, stamps `claimed_at`) before checking
  entitlement. Idempotent and self-healing for already-stored tokens.

## [0.1.1] — 2026-06-10

### Fixed
- **Sign-in did nothing / account never linked.** `keyring` was declared with no
  backend feature, so on Windows it silently no-op'd — the deep-link token was
  never persisted and the gate stayed shut. Enabled `keyring`'s `windows-native`
  backend and stopped swallowing the store error.
- The auto-updater now runs on launch regardless of auth state, so a build that
  can't pass the gate can still self-heal via update.

## [0.1.0] — 2026-06-10

Initial release. Synapse is the Claude Code workspace for the HyperVoice Suite,
replacing ClaudeConnect.

### Added — the workspace
- Embedded interactive terminal (xterm.js + ConPTY) running the real `claude` CLI.
- Transcript panel that tails the session JSONL on disk and parses it with
  `synapse-core` into navigable, per-prompt turns.
- ClaudeConnect-level filtering: per-kind toggles + 14 tool categories, with
  filtered tools rendered inline as dots / pills / hidden.
- Multi-session tabs (top or left) that keep background sessions alive, with an
  unseen-activity indicator.
- Diff view for file-write tool calls, with a 90% × 90% fullscreen modal.
- Markdown rendering, a researched calm color palette, and aurora / color
  backgrounds with configurable drift speed.
- Resizable, persisted terminal ↔ transcript split.
- Git worktree isolation and full-autonomy launch options.
- OS-clipboard copy/paste wired through `arboard` (terminal copy/paste fixes).
- Claude Code status line hidden inside Synapse (via `SYNAPSE_TERMINAL`), kept in
  standalone terminals.

### Added — HyperVoice Suite membership
- HyperVoice account sign-in via the `synapse://claim` deep link (single-instance
  + deep-link plugins), token stored in the OS credential manager.
- Entitlement gating against `/api/desktop/entitlements` (`suite_access`), with a
  free-tier upsell screen and a 14-day offline grace cache.
- Tauri auto-updater against the signed GitHub release feed, with a CI workflow
  that builds, signs, and publishes the installer + `latest.json` on tag.
- App identity finalized: productName **Synapse**, identifier
  `com.adlistic.synapse`, deep-link scheme `synapse://`.
- `synapse-core` consumed as a git dependency (public `Adlistic/Synapse`) so the
  app builds on clean machines.

### Notes
- Synapse is a **desktop** workspace; unlike ClaudeConnect it does not stream
  sessions to a browser. The `synapse-core` redactor remains available if browser
  streaming is added later.
