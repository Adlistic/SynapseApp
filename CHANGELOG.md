# Changelog

All notable changes to HyperVoice Code (formerly Synapse) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.4] — 2026-11-25

### Changed
- **Your answer stays in view when a background task replies.** If a background job reports back after Claude has answered you, the conversation no longer scrolls your answer away to show Claude's reply to the job. It stops where you are and shows a "New reply below" button; scroll down or click it when you're ready. Your next message follows the live end again.

### Fixed
- A background job that reported back while Claude was still answering split the answer in two, with the rest of it under a "Background task" heading. It now stays one answer, with the job's report as a step inside it.
- A session could show a grey "idle" dot while Claude was still working: during long thinking, or while it wrote a large file (that step only appears in the transcript once it is fully written). If the terminal shows Claude's working timer, the session now shows as working, whatever the transcript says.
- Messages could occasionally show twice in the conversation when updates arrived very close together.

## [0.3.3] — 2026-11-24

**Coming from Synapse 0.2.x?** Synapse is now **HyperVoice Code**, and it's **free**: no sign-in and no HyperVoice plan needed. Your settings, open tabs and pins carry over. Since 0.2.12 it has also gained Codex support, zoom and text size (Ctrl+scroll), a "talk instead of typing" card for HyperVoice dictation, and the changes below. (0.3.1 and 0.3.2 went out through the Microsoft Store only.)

### Changed
- **The last traces of the old name are gone.** The program is now `hypervoice-code.exe` (it was `synapse2-desktop.exe`), and it shows as HyperVoice Code in Task Manager, the Start menu and Windows' app list. Your settings, open tabs, pins and window position carry over on first start.
- **The orb comes to HyperVoice Code.** A new session's empty conversation pane now shows a living energy orb, a sibling of the one in HyperVoice. It lights up as you type or dictate into the terminal, ripples when a whole sentence lands, and turns to a violet sweep ("Over to Claude") once you send a prompt, until the first reply appears. Resume shows a scanning orb while it looks for sessions or searches transcripts, and so does a subagent's panel while it loads. It pauses when the window is hidden or the orb is out of view, and slows right down if Windows is set to reduce animations.
- **Status you can read at a glance.** Tabs now show just four looks: a green spinning orb while a session works (with a word beside the name saying what: "thinking", the command it's running, or "2 agents"), an amber tab with a big "!" or "?" when it needs you, a bold name and blue dot when it finished while you were on another tab, and a faint dot when idle. When another session needs you, a bar at the top of the conversation says which and takes you there. The same icons are in Mission Control and the status bar.
- **Slimmer tab list.** In the left-hand list, sessions no longer each carry a coloured bar: the folder heading already shows the project. That heading (and the folder in the status bar) now uses a small coloured folder instead of a dot, so it isn't mistaken for a status light. Tabs along the top keep their bar.
- **Heads-ups are a card you can close.** "Another session is in this folder" (and the worktree warning) now appears as a small card at the bottom of that session's conversation with a ✕, instead of red text. It steps aside while the background-work bar is showing, so the two never sit on top of each other, and comes back when that work finishes.
- **Commands read as what Claude is doing, not as code.** While Claude works, the live line says "Working · Checking whether orders already carry a tracking link" (the description Claude gives each command) instead of `sed -n 85,120p …`. When the latest step is a short note Claude wrote between commands, that note shows. In Steps, each command is titled with its description, with the command itself in small text underneath; Mission Control and the approval card show it too. Codex gives no descriptions, so Codex sessions show commands as before.
- The app's own folder in your home is now `.hypervoice-code` (logs, and the usage-limit hook if you installed it). The hook is moved there for you, and usage data written to the old `.synapse` folder is still read.
- New session worktrees go in `.hvcode/` with `hvcode/…` branches, and merges are committed as "HyperVoice Code". Worktrees made before (`.synapse2/`, `synapse2/…`) still resume, merge and clean up as before.

### Added
- **Choose how much a session may do on its own.** Starting or resuming a session now offers permission modes instead of one "full autonomy" checkbox. Claude Code: Ask, Accept edits, Plan, Auto, or Skip permissions. Codex: Ask, Read-only, Auto-review, or Skip permissions. Each says in one line what it allows, and Skip permissions is shown in red. Whatever you used last is picked for you next time (separately for Claude Code and Codex). Sessions reopened at start-up come back in the mode they were in.
- **Drag with a live preview.** Dragging a session tab now shows where it will land: the others slide out of the way as you drag. Esc cancels.
- **Reorder and pin projects.** In the left rail, drag a project by its name to move it with all its sessions. Pin a project to the top with the pin on its heading, or right-click it or any of its sessions. The order and pins are remembered.
- **A roomier Resume window**, with the permission modes as cards.
- **Codex support.** HyperVoice Code now runs OpenAI's Codex as well as Claude Code. Pick which one when you start a session; the conversation on the right is laid out the same way for both (your prompts, the commands it ran, file edits as diffs, web searches, its answers).
- **Choose your default agent.** On first start (and once for existing users) a short screen asks which agent you use. Change it any time in Settings → Workspace → Coding agent: Claude Code, Codex, or whichever you used last.
- **Installed or not, at a glance.** The new-session screen checks which agents are on your PC each time it opens. One that isn't installed is greyed out, with a link to install it.
- **Resume either kind.** The Resume list shows Claude Code and Codex sessions together, with a label on each and All / Claude Code / Codex filters. Each reopens in the tool it was made with. Search covers both.
- **A session whose tool isn't installed is never opened blind.** In Resume it's greyed out with "Can't reopen: Codex isn't installed on this PC" and a Get it link. Tabs from last time that need a missing tool aren't reopened; a note says why, and they come back once it's installed.
- **Fixed: Enter in the prompt composer sometimes added a new line instead of sending** (most often when dictating "…send it"). The text and the Enter now reach the terminal separately, so the Enter always sends.
- **Fixed: a finished background task folded away the answer you were waiting for.** When a background job reported back right after Claude answered you, only the background note stayed open on the right and your answer collapsed to one line. The answer to the last thing you asked now stays open, with background notes below it.
- For Codex sessions, the top bar shows Codex's own usage limits, and the status ("working", "idle", "asked you") comes straight from Codex.

### Fixed
- With many sessions open, the New and Resume buttons scrolled off the bottom of the left rail. They now stay pinned at the top.
- Resuming a session (or starting one) left its window open on top of the new tab.
- Settings opened from the New session screen appeared behind it, and Esc closed both. Settings now opens on top, and Esc closes only Settings.
- **Updating from Synapse leaves one app, not two.** The installer now removes the old Synapse install (keeping your settings, which carry over) and puts HyperVoice Code shortcuts where Synapse's were.
- Looking for leftover session worktrees no longer runs git inside a folder unless it is provably one of the project's own worktrees.
- If merging a session's worktree failed, that worktree could be offered for clean-up while its tab was still open. It now stays protected.

## [0.3.2] — 2026-11-18

### Changed
- Session tabs now sit in the left rail by default (Settings → Workspace still offers tabs on top). Existing setups may keep their current layout.
- When a usage limit is nearly used up (90%+), its chip in the top bar now uses your accent colour and stands out, instead of hard-to-read red.

## [0.3.1] — 2026-11-17

### Changed
- **Synapse is now HyperVoice Code**, and it's **free**: no sign-in and no
  HyperVoice plan needed. It's also coming to the Microsoft Store.

### Added
- **Talk instead of typing** — a small card at the bottom of the left rail (or a
  "Try HyperVoice" button in the top bar) shows how to dictate prompts with
  HyperVoice, with tips once you have it. The close button shrinks it to one line.
- A HyperVoice tip on the empty conversation screen and in the welcome tour.
- **Dictation lands even when nothing is selected** — if you paste or dictate while no text box has the cursor (say, after clicking in the conversation), the text goes into the prompt composer, or into the terminal when the composer is off. It is never sent until you press Enter.
- **Zoom and text size** — Ctrl+scroll (or Ctrl+= / Ctrl+-) makes everything bigger or smaller; Ctrl+0 resets. Settings → Appearance → Text size can also size the terminal and the conversation on their own. All are remembered.
- Text across the app now uses one consistent set of sizes (it had grown to 18), so panels line up better.

### Fixed
- With display scaling above 100%, the terminal's last line could sit underneath the prompt composer.

### Added
- **Reopen my sessions on launch** — Synapse remembers which sessions were open and resumes
  them, with their tab names and order, the next time it starts (Settings → Start-up; on by default).
- Renaming a tab or a saved session selects the whole name, so you can type straight over it.
- **Status bar** — working / waiting, turn count, folder, tokens and how full the
  conversation is now sit in fixed slots along the bottom, so the header no longer shifts.
- **Messages you send mid-run read as yours** — a prompt typed while Claude is working shows
  as your own words, tagged "sent while Claude was working", not the wrapper Claude Code adds.
- **Fewer false "waiting for approval" alarms** — the status reads the terminal: a step whose
  timer is still ticking counts as running, and a real permission prompt is flagged at once.
- Fixed: newer Claude Code versions log raw API requests in the transcript; these were shown
  as duplicate steps and as system notes written in Claude's voice.
- **A reader, not a log** — the conversation pane is rebuilt for reading.
  Each turn shows your prompt, then the work, then Claude's reply set in a
  comfortable reading column with proper headings, lists and tables.
- **Level of detail switch** — *Answer*, *Steps* or *Everything*, right on the
  conversation header. Answer folds the work into one line ("Worked for 3m 38s
  · 17 steps · 7 files changed") that opens with a click; Steps lists every
  step on one line each, with Claude's notes in between; Everything adds tool
  output and Claude's reasoning.
- **The answer is set apart from the working** — the remarks Claude makes
  while it works ("Let me check the config…") now sit with the steps, so the
  reply you actually read stands on its own.
- **Code blocks** get syntax colouring, a language label and a Copy button;
  each reply has **Copy reply** in its header.
- **Times and durations** — every turn shows when you sent it and how long
  Claude worked on it.
- Repeated steps (five edits to one file in a row) fold into one row with a
  ×5 count; `cd … &&` prefixes are trimmed from shell steps.

- **Claude's questions show in the reader.** A multiple-choice question
  appears as a card with its options. For a single question you can click an
  answer; Synapse presses that option's number in the terminal, but only after
  checking the same option is on the terminal's screen. Answered questions
  stay in the conversation with what you chose.
- **Reply box** under a question Claude asks in prose: write (or dictate) the
  reply, press Enter, and it is placed in the terminal for you to send.
- **Open an agent** — any agent step, and each chip in the new background
  strip, opens that agent's own work: its brief, every step, and its result,
  updating live while it runs.
- **Background work is visible** — while agents or background commands are
  still running, a strip at the bottom of the reader says so and the tab
  shows as working rather than idle.
- **"Files changed" on every reply** — one block listing each file the reply
  touched with lines added and removed; open a file to see all of its edits
  from that reply together.
- **Outline and pins** — the list button on the reader header jumps to any
  prompt in the session; pin a turn to keep it at the top of that list.
- **Next session that needs you** — Ctrl+Shift+A (or the "Next waiting"
  button) goes to the next tab waiting on you. A question from Claude now
  counts as waiting straight away.
- **Context gauge** in the top bar: how full the conversation is.
- **Reading colours** — bold, headings and inline code in replies are
  colour-coded (Settings → Reader to turn off).
- The terminal has a full colour palette.

### Changed
- New type: Inter for the interface and reading text, JetBrains Mono for
  code, both bundled with the app.
- Settings → Conversation is now **Settings → Reader** (level of detail and
  Claude's notes). Hidden tool categories show as one compact line of chips.

### Fixed
- **Cleaning up old worktrees can no longer delete work unasked.** The
  clean-up is now a review list showing what each old session copy still
  holds: unsaved files, commits that were never merged, and files git
  ignores (such as `.env`). Only empty ones are pre-selected; one that holds
  work must be ticked by hand and is named in the warning. A resumed worktree
  session is protected while open and offers merge / keep / discard on close.
- Switching tabs no longer squashes a terminal's text into a narrow column,
  and the terminal no longer runs off the bottom of the window.
- The "working" animation is a smooth left-to-right shine.
- **Session worktrees no longer show up in your repo.** With worktree
  isolation on, the `.synapse2/` folder is now listed in the repository's
  local git exclude, so `git status` stays clean and `git add -A` in the main
  folder can't pick up the session copies.


## [0.2.12] — 2026-09-21

### Added
- **Tab status icons** — a real spinner while a session works, pulsing amber
  glyphs when it needs you (⚠ approval, ? question, ▤ plan review), and a
  flashing chip naming the tool in flight (Bash, Edit, …), flush against the
  tab's right edge.

### Changed
- **Status logic understands the whole turn** — thinking, a tool running,
  and the gap while Claude composes its next step all count as working;
  "waiting for approval?" only appears after a quiet grace period, and never
  in full-autonomy sessions (they have no approval prompts to wait on).

### Fixed
- **Double space in the terminal** — pressing space typed two; the dictation
  forwarder was re-sending keyboard residue.
- **Ctrl+Enter / Shift+Enter insert a newline** in Claude's prompt inside the
  embedded terminal instead of submitting.
- **Tab rename box** now stretches the full width of the rail, and the
  hover-only ✕ no longer reserves dead space at the tab's right edge.

## [0.2.11] — 2026-09-18

### Changed
- **Mission Control cards, decluttered** — each card now reads top-to-bottom
  as one idea per zone: name + status pill, the "now" line, the plan (current
  step plus the next two), live agents, then two labelled vitals (context and
  tokens) above a quiet footer. The unlabelled tool-mix rainbow bar and the
  full folder path are gone from the card face — the path lives on the name's
  tooltip, the tool breakdown on the tools count's tooltip.

## [0.2.10] — 2026-09-17

### Added
- **Clickable version** — the version number in the top bar now opens the
  What's New screen for the release you're on.
- **Labeled sidebar buttons** — the left tab rail's ＋ / ⧉ icons are now two
  proper side-by-side buttons: "＋ New" and "⧉ Resume".

## [0.2.9] — 2026-09-17

### Fixed
- **What's-new dialog no longer clipped** — with a background enabled, the
  update dialog could get trapped and cut off inside the top bar; it now
  always overlays the whole app, centered, and is a little roomier.

## [0.2.8] — 2026-09-17

### Fixed
- **Window position sticks** — geometry is now saved whenever the app loses
  focus and right before an update installs, so the window reopens on the
  monitor you left it on even if the process didn't get a graceful shutdown.

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
