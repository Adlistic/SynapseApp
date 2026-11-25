import { test } from "node:test";
import assert from "node:assert/strict";
import { statusFor, readScreen } from "./status.js";

const now = 1_800_000_000_000;
const st = (lastKind, quietMs, extra = {}) => ({ lastTsMs: now - quietMs, lastKind, lastActivity: "", ...extra });

test("a ticking timer in the terminal means working, however quiet the transcript", () => {
  for (const kind of ["message", "thinking", "toolresult", "user", "toolcall"]) {
    const r = statusFor(st(kind, 10 * 60_000), false, true, { now, screen: "running" });
    assert.equal(r.key, "working", kind);
  }
});

test("without the timer, a long-quiet answer is idle", () => {
  assert.equal(statusFor(st("message", 10 * 60_000), false, true, { now }).key, "idle");
});

test("a permission prompt still wins", () => {
  assert.equal(statusFor(st("toolcall", 1000), true, true, { now, screen: "prompt" }).key, "attention");
});

test("readScreen spots Claude Code's and Codex's working lines", () => {
  assert.equal(readScreen("✻ Cogitating… (2m 13s · ↓ 4.1k tokens · esc to interrupt)\n> "), "running");
  assert.equal(readScreen("• Working (12s • esc to interrupt)"), "running");
  assert.equal(readScreen("> \n  ? for shortcuts"), null);
});
