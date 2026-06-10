# Synapse — Claude Code Workspace

A desktop workspace for [Claude Code](https://claude.com/claude-code). Run the
real `claude` CLI in an **embedded terminal** and watch the conversation unfold
beside it as a **navigable, filterable transcript** — click any of your messages
to see Claude's associated replies, thinking, tool calls, results, and diffs.

Synapse is part of the **HyperVoice Suite** and replaces ClaudeConnect as the
Claude Code companion. It signs in with your HyperVoice account (Pro / Lifetime)
and auto-updates.

## Features

- **Embedded terminal** (xterm.js + ConPTY) running a fully real, interactive
  `claude` session — type into it exactly as you would in any terminal.
- **Transcript panel** built by tailing Claude Code's session JSONL on disk and
  parsing it with `synapse-core` — turns grouped by your prompts, never scraped
  from the TUI.
- **ClaudeConnect-level filtering** — per-kind toggles + 14 tool categories,
  with filtered tools shown as inline dots / pills / hidden.
- **Multi-session tabs** (top or left) — each keeps its terminal + Claude alive
  in the background, with an unseen-activity dot.
- **Diff view** for file-write tool calls, with a 90% × 90% fullscreen modal.
- **Markdown rendering**, researched calm color palette, and aurora / color
  backgrounds with configurable speed.
- **Git worktree isolation** and full-autonomy launch options.

## HyperVoice Suite membership

Synapse gates on a HyperVoice account with Suite access:

1. On first launch, **Sign in with HyperVoice** opens
   `hypervoice.app/auth/desktop?app=synapse` in your browser.
2. The page bounces back to `synapse://claim?token=…`; the token is stored in
   the OS credential manager.
3. The app calls `/api/desktop/entitlements` and unlocks when `suite_access` is
   true. A recent verified result is cached for offline grace.

## Develop

```powershell
npm install
npm run tauri:dev      # hot-reloading dev (Vite on :1421)
```

`synapse-core` (transcript parser, worktree manager, redactor) is consumed as a
git dependency from the public [`Adlistic/Synapse`](https://github.com/Adlistic/Synapse)
repo, so the app builds on a clean machine with no local checkout.

## Build & release

```powershell
npm run tauri:build    # local NSIS installer
```

Releases are built, signed, and published by CI: push a `v*` tag and
[`.github/workflows/release.yml`](.github/workflows/release.yml) produces the
signed `.exe` + `latest.json` updater manifest on the GitHub release. The app's
updater polls `releases/latest/download/latest.json`.

CI requires two secrets: `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the updater signing keypair; the matching
public key is in `src-tauri/tauri.conf.json`).

See [CHANGELOG.md](CHANGELOG.md) for release notes.
