# HyperVoice Code — Microsoft Store listing (draft)

## Product name
HyperVoice Code

## Short description (≤ 1000, shown above the fold)
A workspace for Claude Code and Codex. Run the real terminal on the left and read the conversation on the right: your prompts, the agent's replies, every step and every file it changed. Free.

## Description
HyperVoice Code puts Claude Code and OpenAI's Codex in a proper desktop window. Pick either one for each session.

The left side is the real Claude Code or Codex terminal, exactly as you know it. The right side turns the same session into something you can read: each prompt with the agent's reply set out in a reading column, the steps it took folded into one line until you want them, and a list of every file each reply changed with the edits behind it.

- Run several sessions in tabs, grouped by project, each kept alive in the background
- See at a glance which sessions are working and which are waiting on you, and jump to the next one that needs you
- Answer the agent's questions from the reader, or open any Claude Code subagent to watch its own work
- Diffs for every file change, syntax-coloured code with Copy buttons
- Resume any Claude Code or Codex session on this PC with its full history
- Optional git worktree isolation per session

Talk instead of typing: pair it with HyperVoice, the dictation hotkey, and say your prompts into the terminal.

Requires Claude Code (Anthropic's command-line tool) or Codex (OpenAI's command-line tool) installed and signed in. HyperVoice Code is an independent app and is not made by or affiliated with Anthropic or OpenAI.

## Search terms
Claude Code, Codex, AI coding, terminal, coding assistant, developer tools, dictation

## What's new
First Store release.

## Category
Developer tools

## Testing notes (for certification)
The app needs the Claude Code CLI (`npm install -g @anthropic-ai/claude-code`) with a Claude account, or the Codex CLI (`npm install -g @openai/codex`) with a ChatGPT account, to run sessions. Without either, the app opens and shows the start screen with both agents marked "Not installed" and a link to install each. No sign-in to HyperVoice Code itself is required.

## runFullTrust justification
HyperVoice Code is a desktop developer tool. It runs the user's own Claude Code or Codex command-line program in a terminal (Windows ConPTY), reads that program's session files from the user's profile, and can create git worktrees in the user's project folders. These need full desktop access.
