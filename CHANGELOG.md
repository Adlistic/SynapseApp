# Changelog

All notable changes to Synapse (Claude Code Workspace) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
