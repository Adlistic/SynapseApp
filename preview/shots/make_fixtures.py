# Fictional Claude Code sessions for Microsoft Store screenshots (preview
# harness only). Writes <id>.jsonl here; dump each with synapse-core's
# dump_transcript example into <id>.json:
# (run from the repo root, once per session id)
#   cargo run -q --manifest-path synapse-core/Cargo.toml --example dump_transcript -- preview/shots/s-api.jsonl > preview/shots/s-api.json
# Every project, file and person here is made up.
import json, os, uuid
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
NOW = datetime.now(timezone.utc)


class Session:
    def __init__(self, sid, cwd, start_min_ago):
        self.sid, self.cwd, self.lines = sid, cwd, []
        self.t = NOW - timedelta(minutes=start_min_ago)
        self.n = 0

    def ts(self, sec):
        self.t += timedelta(seconds=sec)
        return self.t.isoformat().replace("+00:00", "Z")

    def _base(self, typ, sec):
        return {"type": typ, "sessionId": self.sid, "uuid": str(uuid.uuid4()), "timestamp": self.ts(sec), "cwd": self.cwd}

    def user(self, text, sec=5):
        d = self._base("user", sec); d["message"] = {"role": "user", "content": text}; self.lines.append(d)

    def asst(self, blocks, sec=6):
        d = self._base("assistant", sec)
        d["message"] = {"role": "assistant", "model": "claude-opus-4-5", "content": blocks,
                        "usage": {"input_tokens": 1800, "output_tokens": 420}}
        self.lines.append(d)

    def tool(self, name, inp, text=None, sec=6):
        self.n += 1
        tid = f"{self.sid}-t{self.n}"
        b = ([{"type": "text", "text": text}] if text else []) + [{"type": "tool_use", "id": tid, "name": name, "input": inp}]
        self.asst(b, sec)
        return tid

    def result(self, tid, content, sec=2):
        d = self._base("user", sec)
        d["message"] = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": content}]}
        self.lines.append(d)

    def say(self, text, sec=5):
        self.asst([{"type": "text", "text": text}], sec)

    def think(self, text, sec=4):
        self.asst([{"type": "thinking", "thinking": text, "signature": "x"}], sec)

    def write(self):
        with open(os.path.join(HERE, self.sid + ".jsonl"), "w", encoding="utf-8") as f:
            for l in self.lines:
                f.write(json.dumps(l) + "\n")


P = "C:\\Projects\\"

# 1) notes-app — finished, idle: the hero conversation.
s = Session("s-notes", P + "notes-app", 40)
s.user("Dark mode doesn't stick: if I switch it on in Settings and reload the page, it's light again. Can you fix that and add a test so it doesn't come back?", 0)
t = s.tool("Grep", {"pattern": "theme", "path": "src"}, "Let me find where the theme is set."); s.result(t, "src/settings/ThemeToggle.tsx\nsrc/app/App.tsx\nsrc/lib/prefs.ts")
t = s.tool("Read", {"file_path": P + "notes-app\\src\\settings\\ThemeToggle.tsx"}); s.result(t, "export function ThemeToggle() {\n  const [dark, setDark] = useState(false);\n  ...")
t = s.tool("Read", {"file_path": P + "notes-app\\src\\lib\\prefs.ts"}); s.result(t, "export function savePref(key, value) { localStorage.setItem(key, value); }\nexport function loadPref(key) { return localStorage.getItem(key); }")
t = s.tool("Edit", {"file_path": P + "notes-app\\src\\settings\\ThemeToggle.tsx",
                    "old_string": "  const [dark, setDark] = useState(false);",
                    "new_string": "  const [dark, setDark] = useState(() => loadPref(\"theme\") === \"dark\");\n  useEffect(() => savePref(\"theme\", dark ? \"dark\" : \"light\"), [dark]);"},
           "Found it: the toggle starts from `false` every time and never saves. I'll read the saved value on start and save on every change."); s.result(t, "The file has been updated.")
t = s.tool("Edit", {"file_path": P + "notes-app\\src\\app\\App.tsx", "old_string": "<div className=\"app\">",
                    "new_string": "<div className=\"app\" data-theme={loadPref(\"theme\") ?? \"light\"}>"}); s.result(t, "The file has been updated.")
t = s.tool("Write", {"file_path": P + "notes-app\\src\\settings\\ThemeToggle.test.tsx",
                     "content": "test(\"dark mode survives a reload\", () => {\n  render(<ThemeToggle />);\n  click(screen.getByRole(\"switch\"));\n  cleanup();\n  render(<ThemeToggle />);\n  expect(screen.getByRole(\"switch\")).toBeChecked();\n});\n"},
           "Now a test that switches dark mode on, re-renders as a reload would, and checks it's still on."); s.result(t, "File created successfully.")
t = s.tool("Bash", {"command": "npm test -- ThemeToggle", "description": "Run the theme tests"}); s.result(t, " PASS  src/settings/ThemeToggle.test.tsx\n  ✓ dark mode survives a reload (38 ms)\n\nTests: 1 passed, 1 total", 9)
s.say("Fixed. Dark mode now stays on after a reload.\n\n**What was wrong**\nThe toggle always started as light and never saved your choice, so every reload reset it.\n\n**What I changed**\n- `ThemeToggle.tsx` reads the saved theme when it starts and saves it whenever you flip it.\n- `App.tsx` applies the saved theme on first paint, so there's no flash of light mode.\n- New test `ThemeToggle.test.tsx` checks the setting survives a reload.\n\n**Checked**\n```\nTests: 1 passed, 1 total\n```")
s.write()

# 2) api-server — waiting on a multiple-choice question.
s = Session("s-api", P + "api-server", 12)
s.user("Add rate limiting to the login endpoint so people can't brute-force passwords.", 0)
t = s.tool("Read", {"file_path": P + "api-server\\src\\routes\\auth.ts"}, "I'll look at the login route first."); s.result(t, "router.post('/login', async (req, res) => { ... })")
t = s.tool("Grep", {"pattern": "rateLimit|redis", "path": "src"}); s.result(t, "src/lib/redis.ts")
s.tool("AskUserQuestion", {"questions": [{
    "question": "How should the login limit be counted?", "header": "Rate limit", "multiSelect": False,
    "options": [
        {"label": "Per account (Recommended)", "description": "5 tries a minute for each email address, wherever they come from"},
        {"label": "Per IP address", "description": "5 tries a minute from each network address"},
        {"label": "Both", "description": "Whichever limit is hit first"}]}]},
    "There's already a Redis client, so I can store the counters there. One decision before I build it:")
s.write()

# 3) docs-site — a subagent is running.
s = Session("s-docs", P + "docs-site", 6)
s.user("Check every page in the docs for broken links and fix the ones you can.", 0)
t = s.tool("Glob", {"pattern": "content/**/*.md"}, "I'll list the pages, then hand the link check to an agent."); s.result(t, "content/getting-started.md\ncontent/install.md\ncontent/api/auth.md\n… 46 more")
s.tool("Task", {"description": "Check links on 49 pages", "subagent_type": "general-purpose",
                "prompt": "Check every link in content/**/*.md. Report each broken link with the page and line."},
       "Starting a link-check agent on all 49 pages.", sec=3)
s.write()

# 4) mobile-app — thinking.
s = Session("s-mobile", P + "mobile-app", 3)
s.user("The app crashes when I rotate the screen on the profile page. Can you find out why?", 0)
t = s.tool("Read", {"file_path": P + "mobile-app\\src\\screens\\Profile.tsx"}, "Let me read the profile screen."); s.result(t, "export default function Profile() { ... }")
t = s.tool("Bash", {"command": "npm run test -- Profile", "description": "Run the profile tests"}); s.result(t, "PASS src/screens/Profile.test.tsx (3 tests)")
s.think("The tests pass, so the crash is likely tied to the orientation change re-creating the screen while a request is still in flight...", sec=3)
s.write()
print("ok")
