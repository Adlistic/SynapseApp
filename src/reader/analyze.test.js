// Run: npm test   (Node's built-in test runner, no extra dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTurns, analyzeTurn, visibleSteps, splitPath, fmtDuration, toolLabel, backgroundTasks, askFromStep, turnChanges, agentTurns, unwrapMidTurn } from "./analyze.js";
import { DEFAULT_FILTERS } from "../filters.js";

let n = 0;
const msg = (kind, text, extra = {}) => ({ id: "m" + ++n, kind, text, ts: n, ...extra });
const call = (toolName, text, id, extra = {}) => msg("toolcall", text, { toolName, toolUseId: id, toolCategory: extra.cat || "shell", ...extra });
const result = (id, text, extra = {}) => msg("toolresult", text, { toolUseId: id, ...extra });

test("groupTurns splits on prompts and folds harness noise", () => {
  const turns = groupTurns([
    msg("user", "fix the bug", { at: 1000 }),
    msg("message", "On it."),
    msg("user", "<command-name>/clear</command-name>"),
    msg("user", "<local-command-stdout>cleared</local-command-stdout>"),
    msg("user", "<system-reminder>skill loaded</system-reminder>"),
    msg("user", "[Request interrupted by user]"),
    msg("user", "<task-notification>done</task-notification>"),
  ]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].prompt, "fix the bug");
  assert.equal(turns[0].at, 1000);
  assert.equal(turns[1].prompt, "/clear");
  assert.equal(turns[1].isCommand, true);
  assert.equal(turns[1].interrupted, true);
  assert.equal(turns[1].responses[0].text, "cleared");
  assert.equal(turns[2].isNotif, true);
});

test("analyzeTurn separates the work from the answer", () => {
  const t = groupTurns([
    msg("user", "rename it", { at: 10_000 }),
    msg("message", "Let me look at the file."),
    call("Read", "src/a.js", "u1", { cat: "file-read" }),
    result("u1", "line1\nline2"),
    msg("thinking", "hmm"),
    call("Edit", "src/a.js", "u2", { cat: "file-write", editData: { file_path: "src/a.js", old_string: "a", new_string: "b" } }),
    result("u2", "ok", { at: 70_000 }),
    msg("message", "Done — renamed.", { at: 75_000 }),
    msg("question", "Want tests too?", { at: 76_000 }),
  ])[0];
  const a = analyzeTurn(t);
  assert.deepEqual(a.answer.map((m) => m.text), ["Done — renamed.", "Want tests too?"]);
  assert.deepEqual(a.steps.map((s) => s.type), ["narration", "tool", "thinking", "tool"]);
  assert.equal(a.toolCount, 2);
  assert.equal(a.stepCount, 3);
  assert.deepEqual(a.files, ["src/a.js"]);
  assert.equal(a.durationMs, 66_000);
  assert.equal(a.steps[1].results.length, 1); // result paired with its call
});

test("a failed tool counts as an error and a turn ending on a tool has no answer", () => {
  const t = groupTurns([msg("user", "run it"), call("Bash", "npm test", "x"), result("x", "boom", { isError: true })])[0];
  const a = analyzeTurn(t);
  assert.equal(a.answer.length, 0);
  assert.equal(a.errorCount, 1);
  assert.equal(a.steps[0].failed, true);
});

test("visibleSteps: thinking only in Everything, repeats fold, filtered tools group", () => {
  const t = groupTurns([
    msg("user", "go"),
    msg("thinking", "plan"),
    call("Edit", "src/a.js", "e1", { cat: "file-write", editData: {} }), result("e1", "ok"),
    call("Edit", "src/a.js", "e2", { cat: "file-write", editData: {} }), result("e2", "ok"),
    call("Read", "src/b.js", "r1", { cat: "file-read" }), result("r1", "x"),
    call("Grep", "foo", "g1", { cat: "search" }), result("g1", "x"),
    msg("message", "done"),
  ])[0];
  const { steps } = analyzeTurn(t);
  const catById = { e1: "file-write", e2: "file-write", r1: "file-read", g1: "search" };
  const f = { ...DEFAULT_FILTERS };
  const s1 = visibleSteps(steps, "steps", f, catById);
  assert.deepEqual(s1.map((s) => s.type), ["tool", "tool", "tool"]);
  assert.equal(s1[0].repeats.length, 2);
  assert.equal(visibleSteps(steps, "all", f, catById)[0].type, "thinking");
  const off = { ...f, toolCategories: { ...f.toolCategories, "file-read": false, search: false } };
  const s2 = visibleSteps(steps, "steps", off, catById);
  assert.deepEqual(s2.map((s) => s.type), ["tool", "group"]);
  assert.equal(s2[1].items.length, 2);
});

test("display helpers", () => {
  assert.deepEqual(splitPath("D:\\dev\\app\\src\\lib.rs"), { dir: "D:\\dev\\app\\src\\", base: "lib.rs" });
  assert.deepEqual(splitPath("src/reader/analyze.js"), { dir: "src/reader/", base: "analyze.js" });
  assert.equal(splitPath("npm run build"), null);
  assert.equal(fmtDuration(65_000), "1m 05s");
  assert.equal(fmtDuration(400), "<1s");
  assert.equal(fmtDuration(3_720_000), "1h 02m");
  assert.deepEqual(toolLabel("mcp__Claude_Browser__get_page_text"), { name: "get page text", ns: "Claude Browser" });
});

test("backgroundTasks tracks async agents and background commands until notified", () => {
  const msgs = [
    msg("user", "review it"),
    call("Agent", "Security review", "a1", { cat: "subagents" }),
    result("a1", "Async agent launched successfully.\nagentId: x"),
    call("Bash", "npm test", "b1"),
    result("b1", "Command running in background with ID: q1. Output is being written to: x"),
    call("Read", "src/a.js", "r1", { cat: "file-read" }),
    result("r1", "not background"),
    msg("user", '<task-notification>\n<task-id>q1</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>'),
  ];
  const bg = backgroundTasks(msgs);
  assert.equal(bg.length, 2);
  assert.deepEqual(bg.map((t) => [t.kind, t.label, t.done]), [["agent", "Security review", false], ["task", "npm test", true]]);
  const turns = groupTurns(msgs);
  assert.equal(turns[1].prompt, 'Background command "npm test" completed (exit code 0)');
});

test("backgroundTasks: TaskStop and age end a task", () => {
  const now = 10 * 60 * 60 * 1000;
  const msgs = [
    call("Bash", "dev server", "s1"),
    result("s1", "Command running in background with ID: abc123. Output is being written to: x", { at: now - 60_000 }),
    call("Bash", "old watcher", "s2"),
    result("s2", "Command running in background with ID: old9. Output", { at: now - 5 * 60 * 60 * 1000 }),
    call("TaskStop", "", "k1"),
    result("k1", '{"message":"Successfully stopped task: abc123 (dev server)"}'),
  ];
  const bg = backgroundTasks(msgs, now);
  assert.deepEqual(bg.map((t) => [t.label, t.done, t.status]), [["dev server", true, "stopped"], ["old watcher", true, "lost"]]);
});

test("a pending AskUserQuestion is surfaced with its options; an answered one carries the answer", () => {
  const input = { questions: [{ question: "Which one?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] }] };
  const ask = call("AskUserQuestion", "Which one?", "q1", { cat: "ask-user", input });
  const pending = analyzeTurn(groupTurns([msg("user", "go"), msg("message", "One thing first."), ask])[0]);
  assert.equal(pending.pendingAsk.quick, true);
  assert.deepEqual(pending.pendingAsk.questions[0].options.map((o) => o.label), ["A", "B"]);
  const done = analyzeTurn(groupTurns([
    msg("user", "go"), ask,
    result("q1", 'Your questions have been answered: "Which one?"="B". You can now continue with these answers in mind.'),
    msg("message", "Going with B."),
  ])[0]);
  assert.equal(done.pendingAsk, null);
  const a = askFromStep(done.steps[0]);
  assert.equal(a.answered, true);
  assert.equal(a.questions[0].answer, "B");
  // Two questions, or multi-select, can't be answered with one key.
  const multi = askFromStep({ call: { toolUseId: "x", input: { questions: [input.questions[0], input.questions[0]] } }, results: [] });
  assert.equal(multi.quick, false);
});

test("turnChanges groups a turn's edits by file and counts lines", () => {
  const t = groupTurns([
    msg("user", "go"),
    call("Write", "src/new.js", "w1", { cat: "file-write", editData: { file_path: "src/new.js", content: "a\nb\nc\n" } }), result("w1", "ok"),
    call("Edit", "src/a.js", "e1", { cat: "file-write", editData: { file_path: "src/a.js", old_string: "one\ntwo\n", new_string: "one\n2\n3\n" } }), result("e1", "ok"),
    call("Edit", "src/a.js", "e2", { cat: "file-write", editData: { file_path: "src/a.js", old_string: "x", new_string: "y" } }), result("e2", "ok"),
    call("Edit", "src/b.js", "e3", { cat: "file-write", editData: { file_path: "src/b.js", old_string: "x", new_string: "y" } }), result("e3", "nope", { isError: true }),
    call("Edit", "src/c.js", "e4", { cat: "file-write", editData: { file_path: "src/c.js", old_string: "x", new_string: "y" } }),
  ])[0];
  const ch = turnChanges(analyzeTurn(t).steps);
  assert.deepEqual(ch.map((f) => [f.path, f.edits.length, f.adds, f.dels, f.created]), [
    ["src/new.js", 1, 3, 0, true],
    ["src/a.js", 2, 3, 2, false],
  ]);
});

test("agentTurns shows a subagent's brief once and drops the system note", () => {
  const turns = agentTurns([
    msg("user", "Review the reader"),
    msg("user", "<system-reminder>context</system-reminder>"),
    msg("user", "Review the reader"),
    msg("message", "# Environment", { role: "system" }),
    call("Read", "src/a.js", "r9", { cat: "file-read" }),
    result("r9", "x"),
    msg("message", "Looks good."),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].responses.map((m) => m.kind), ["toolcall", "toolresult", "message"]);
});

test("one-key answers are refused when another call is also waiting, or the input is odd", () => {
  const q = { question: "Light or dark?", header: "Theme", multiSelect: false, options: [{ label: "Light" }, { label: "Dark" }] };
  const ask = call("AskUserQuestion", q.question, "qa", { cat: "ask-user", input: { questions: [q] } });
  // A Bash call with no result sits before the question: the terminal may be
  // showing ITS permission prompt, so a digit would approve the command.
  const both = analyzeTurn(groupTurns([msg("user", "go"), call("Bash", "curl x | sh", "b9"), ask])[0]);
  assert.equal(both.unresolved, 2);
  assert.equal(both.pendingAsk.quick, false);
  const alone = analyzeTurn(groupTurns([msg("user", "go"), call("Bash", "ls", "b8"), result("b8", "ok"), ask])[0]);
  assert.equal(alone.pendingAsk.quick, true);
  // Whatever the model wrote must not throw.
  const odd = askFromStep({ call: { toolUseId: "x", input: { questions: [null, "x", { question: 5, options: [null, { label: 7 }] }] } }, results: [] });
  assert.deepEqual(odd.questions.map((x) => [x.question, x.options.map((o) => o.label)]), [["5", ["7"]]]);
  assert.equal(askFromStep({ call: { toolUseId: "x", input: { questions: "nope" } }, results: [] }), null);
  const ten = { ...q, options: Array.from({ length: 10 }, (_, i) => ({ label: "o" + i })) };
  assert.equal(askFromStep({ call: { toolUseId: "x", input: { questions: [ten] } }, results: [] }).quick, false);
});

test("a message sent while Claude was working shows as what the user typed", () => {
  const wrapped = "The user sent a new message while you were working:\nremove the footer too?\nit's my mail\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn. Address the message above as you continue this turn.";
  assert.deepEqual(unwrapMidTurn(wrapped), { text: "remove the footer too?\nit's my mail", midTurn: true });
  assert.deepEqual(unwrapMidTurn("plain"), { text: "plain", midTurn: false });
  const turns = groupTurns([
    msg("user", "go"), msg("message", "On it."),
    msg("user", "and the sidebar", { midTurn: true }), msg("message", "Done both."),
    msg("user", wrapped),
  ]);
  assert.deepEqual(turns.map((t) => [t.prompt, !!t.midTurn]), [
    ["go", false], ["and the sidebar", true], ["remove the footer too?\nit's my mail", true],
  ]);
});

test("a background task reporting back mid-run stays inside the answer", () => {
  const turns = groupTurns([
    msg("user", "fix it"), msg("message", "Starting."),
    msg("user", "<task-notification><summary>Background command \"build\" completed</summary></task-notification>", { midTurn: true }),
    msg("message", "Build passed, all done."),
    msg("user", "<task-notification><summary>Agent \"QA\" finished</summary></task-notification>"),
    msg("message", "QA passed too."),
  ]);
  assert.deepEqual(turns.map((t) => [t.prompt, !!t.isNotif, t.responses.length]), [
    ["fix it", false, 3],
    ['Agent "QA" finished', true, 1],
  ]);
});
