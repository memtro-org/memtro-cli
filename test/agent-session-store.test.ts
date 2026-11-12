import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openSessionStore, sessionsDir } from "../src/agent/session-store.js";
import { isSummaryMessage } from "../src/agent/compaction.js";
import type { SessionMeta } from "../src/agent/types.js";

const home = mkdtempSync(join(tmpdir(), "memtro-sessions-"));
after(() => rmSync(home, { recursive: true, force: true }));
let n = 0;
const store = () => {
  const env = { XDG_STATE_HOME: join(home, `s${n++}`) };
  return { s: openSessionStore({ env, platform: "linux", home }), dir: sessionsDir({ env, platform: "linux", home }) };
};
const meta = (id: string, cwd = "/work/app"): SessionMeta => ({ id, cwd, started: "2026-11-12T10:00:00.000Z", model: "auto", title: "Fix it" });

test("sessionsDir: XDG_STATE_HOME, else ~/.local/state; LOCALAPPDATA on Windows; a relative XDG is ignored", () => {
  assert.equal(sessionsDir({ env: { XDG_STATE_HOME: "/x/state" }, platform: "linux", home: "/h" }), "/x/state/memtro/sessions");
  assert.equal(sessionsDir({ env: {}, platform: "darwin", home: "/h" }), "/h/.local/state/memtro/sessions");
  assert.equal(sessionsDir({ env: { XDG_STATE_HOME: "rel" }, platform: "linux", home: "/h" }), "/h/.local/state/memtro/sessions");
  assert.match(sessionsDir({ env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, platform: "win32", home: "C:\\Users\\a" }), /memtro.sessions$/);
});

test("files are 0600 in a 0700 directory, and round-trip messages in order", () => {
  const { s, dir } = store();
  s.create(meta("cli-1"));
  s.appendMessage("cli-1", { role: "user", content: "hi" });
  s.appendMessage("cli-1", { role: "assistant", content: null, tool_calls: [{ id: "c", name: "read", arguments: "{}" }] });
  s.appendMessage("cli-1", { role: "tool", tool_call_id: "c", content: "line\u2028two" });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "cli-1.jsonl")).mode & 0o777, 0o600);
  const loaded = s.load("cli-1")!;
  assert.deepEqual(loaded.meta, meta("cli-1"));
  assert.deepEqual(loaded.messages.map((m) => m.role), ["user", "assistant", "tool"]);
  assert.equal(loaded.messages[2]!.content, "line\u2028two");
});

test("a torn last line is skipped, and the next append does not run into it", () => {
  const { s, dir } = store();
  s.create(meta("cli-2"));
  s.appendMessage("cli-2", { role: "user", content: "one" });
  appendFileSync(join(dir, "cli-2.jsonl"), '{"type":"message","message":{"role":"assis');
  assert.deepEqual(s.load("cli-2")!.messages, [{ role: "user", content: "one" }]);
  // A new process carries on with the session.
  const again = openSessionStore({ env: { XDG_STATE_HOME: join(dir, "..", "..") }, platform: "linux", home });
  again.appendMessage("cli-2", { role: "user", content: "two" });
  assert.deepEqual(again.load("cli-2")!.messages, [
    { role: "user", content: "one" },
    { role: "user", content: "two" },
  ]);
  assert.equal(readFileSync(join(dir, "cli-2.jsonl"), "utf8").split("\n").length, 5);
});

test("compaction records apply in order on load", () => {
  const { s } = store();
  s.create(meta("cli-3"));
  for (const c of ["a", "b", "c"]) s.appendMessage("cli-3", { role: "user", content: c });
  s.appendCompaction("cli-3", "first summary", 2);
  s.appendMessage("cli-3", { role: "user", content: "d" });
  s.appendCompaction("cli-3", "second summary", 2);
  const { messages } = s.load("cli-3")!;
  assert.equal(messages.length, 2);
  assert.ok(isSummaryMessage(messages[0]!));
  assert.match(messages[0]!.content as string, /second summary/);
  assert.deepEqual(messages[1], { role: "user", content: "d" });
});

test("list: this directory only, most recently active first; load refuses ids that are paths", () => {
  const { s, dir } = store();
  s.create(meta("cli-old"));
  s.create(meta("cli-new"));
  s.create(meta("cli-elsewhere", "/work/other"));
  utimesSync(join(dir, "cli-old.jsonl"), new Date(1000), new Date(1000));
  assert.deepEqual(s.list("/work/app").map((m) => m.id), ["cli-new", "cli-old"]);
  s.appendMessage("cli-old", { role: "user", content: "back to it" });
  assert.deepEqual(s.list("/work/app").map((m) => m.id), ["cli-old", "cli-new"]);
  assert.equal(s.load("../../etc/passwd"), null);
  assert.equal(s.load("missing"), null);
  assert.throws(() => s.create(meta("../escape")));
  assert.throws(() => s.create(meta("cli-new")), "an existing session is not overwritten");
  assert.deepEqual(store().s.list("/work/app"), [], "no directory yet is no sessions");
});

test("load answers a tool call left unanswered by a crash, and drops a result that answers nothing", async () => {
  const { answerDangling, LOST_RESULT } = await import("../src/agent/session-store.js");
  const { s, dir } = store();
  s.create(meta("cli-crash"));
  s.appendMessage("cli-crash", { role: "user", content: "go" });
  s.appendMessage("cli-crash", { role: "assistant", content: null, tool_calls: [{ id: "a", name: "bash", arguments: "{}" }, { id: "b", name: "read", arguments: "{}" }] });
  s.appendMessage("cli-crash", { role: "tool", tool_call_id: "a", content: "done" });
  // The process died here, while `b` ran; a later process carried on with the session.
  s.appendMessage("cli-crash", { role: "user", content: "again" });
  s.appendMessage("cli-crash", { role: "tool", tool_call_id: "zz", content: "orphan" });
  const loaded = s.load("cli-crash")!.messages;
  assert.deepEqual(
    loaded.map((m) => (m.role === "tool" ? `tool:${m.tool_call_id}:${m.content}` : m.role)),
    ["user", "assistant", "tool:a:done", `tool:b:${LOST_RESULT}`, "user"],
  );
  assert.deepEqual(answerDangling(loaded), loaded, "a whole conversation is unchanged");
  assert.ok(dir);
});
