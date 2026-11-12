import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Tool, ToolContext } from "../src/agent/types.js";
import { unifiedDiff } from "../src/tools/diff.js";
import { planEdit } from "../src/tools/edit.js";
import { createLocalTools } from "../src/tools/index.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "memtro-edit-"));
  const tools = new Map(createLocalTools().map((t) => [t.spec.name, t]));
  const ctx: ToolContext = { cwd: dir, workspaceRoot: dir, signal: new AbortController().signal };
  const call = async (name: string, raw: Record<string, unknown>) => {
    const tool = tools.get(name) as Tool;
    const v = tool.validate(raw);
    if (!v.ok) return { content: `invalid: ${v.error}`, isError: true };
    return tool.run(v.args, ctx);
  };
  const summarise = async (name: string, raw: Record<string, unknown>) => {
    const tool = tools.get(name) as Tool;
    const v = tool.validate(raw);
    assert.ok(v.ok);
    return tool.summarise(v.args, ctx);
  };
  return { dir, call, summarise, tools };
}

test("edit refuses a file that was not read", async () => {
  const { dir, call } = setup();
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  const r = await call("edit", { path: "a.txt", old_string: "one", new_string: "uno" });
  assert.equal(r.isError, true);
  assert.match(r.content, /has not been read in this session/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\n");
});

test("edit refuses a file changed on disk since it was read", async () => {
  const { dir, call } = setup();
  const file = join(dir, "a.txt");
  writeFileSync(file, "one\ntwo\n");
  await call("read", { path: "a.txt" });
  writeFileSync(file, "one\ntwo\nthree\n");
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const r = await call("edit", { path: "a.txt", old_string: "one", new_string: "uno" });
  assert.equal(r.isError, true);
  assert.match(r.content, /changed on disk since it was read/);
});

test("edit says when old_string is not found, found N times, or identical", async () => {
  const { dir, call } = setup();
  writeFileSync(join(dir, "a.txt"), "x = 1\nx = 1\nx = 1\n");
  await call("read", { path: "a.txt" });
  const missing = await call("edit", { path: "a.txt", old_string: "y = 2", new_string: "y = 3" });
  assert.match(missing.content, /was not found/);
  const many = await call("edit", { path: "a.txt", old_string: "x = 1", new_string: "x = 2" });
  assert.match(many.content, /found 3 times/);
  const same = await call("edit", { path: "a.txt", old_string: "x = 1", new_string: "x = 1" });
  assert.match(same.content, /identical/);
  const all = await call("edit", { path: "a.txt", old_string: "x = 1", new_string: "x = 2", replace_all: true });
  assert.equal(all.isError, undefined);
  assert.match(all.content, /3 replacements/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "x = 2\nx = 2\nx = 2\n");
});

test("edit validates its arguments", async () => {
  const { call } = setup();
  assert.match((await call("edit", { path: "a", old_string: "", new_string: "b" })).content, /must not be empty/);
  assert.match((await call("edit", { path: "a", old_string: "a" })).content, /new_string" is required/);
  assert.match((await call("edit", { path: "a", old_string: "a", new_string: 3 })).content, /must be a string/);
});

test("consecutive edits work, keep CRLF endings, the final newline and the file mode", async () => {
  const { dir, call } = setup();
  const file = join(dir, "w.txt");
  writeFileSync(file, "alpha\r\nbeta\r\ngamma\r\n");
  chmodSync(file, 0o750);
  await call("read", { path: "w.txt" });
  const first = await call("edit", { path: "w.txt", old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" });
  assert.equal(first.isError, undefined, first.content);
  assert.equal(first.display?.kind, "diff");
  assert.match(first.content, /-alpha\n-beta\n\+ALPHA\n\+BETA/);
  const second = await call("edit", { path: "w.txt", old_string: "gamma\n", new_string: "GAMMA" });
  assert.equal(second.isError, undefined, second.content);
  assert.equal(readFileSync(file, "utf8"), "ALPHA\r\nBETA\r\nGAMMA\r\n");
  assert.equal(statSync(file).mode & 0o777, 0o750);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".memtro-")), [], "no temp file left behind");
});

test("edit writes through an inside symlink to its target, keeping the link", async () => {
  const { dir, call } = setup();
  mkdirSync(join(dir, "real"));
  writeFileSync(join(dir, "real", "t.txt"), "v1\n");
  symlinkSync(join(dir, "real", "t.txt"), join(dir, "alias.txt"));
  await call("read", { path: "alias.txt" });
  const r = await call("edit", { path: "alias.txt", old_string: "v1", new_string: "v2" });
  assert.equal(r.isError, undefined, r.content);
  assert.equal(readFileSync(join(dir, "real", "t.txt"), "utf8"), "v2\n");
  assert.ok(statSync(join(dir, "alias.txt")).isFile());
});

test("summarise computes the diff without writing", async () => {
  const { dir, call, summarise } = setup();
  writeFileSync(join(dir, "s.txt"), "keep\nold\n");
  await call("read", { path: "s.txt" });
  const s = await summarise("edit", { path: "s.txt", old_string: "old", new_string: "new" });
  assert.equal(s.title, "Edit s.txt");
  assert.ok(s.paths?.[0]?.endsWith("s.txt"));
  assert.match(s.diff ?? "", /-old\n\+new/);
  assert.equal(readFileSync(join(dir, "s.txt"), "utf8"), "keep\nold\n");
});

test("write creates a new file (with parents), and refuses to replace an unread one", async () => {
  const { dir, call } = setup();
  const created = await call("write", { path: "deep/new/file.txt", content: "hello\n" });
  assert.equal(created.isError, undefined, created.content);
  assert.match(created.content, /Created deep\/new\/file.txt/);
  assert.equal(readFileSync(join(dir, "deep/new/file.txt"), "utf8"), "hello\n");

  writeFileSync(join(dir, "exists.txt"), "old\n");
  const refused = await call("write", { path: "exists.txt", content: "new\n" });
  assert.equal(refused.isError, true);
  assert.match(refused.content, /has not been read/);
  assert.equal(readFileSync(join(dir, "exists.txt"), "utf8"), "old\n");
});

test("write replaces a file that was read, and the file it created can be edited at once", async () => {
  const { dir, call } = setup();
  writeFileSync(join(dir, "r.txt"), "a\r\nb\r\n");
  await call("read", { path: "r.txt" });
  const r = await call("write", { path: "r.txt", content: "a\nc" });
  assert.equal(r.isError, undefined, r.content);
  assert.equal(readFileSync(join(dir, "r.txt"), "utf8"), "a\r\nc\r\n", "CRLF and final newline kept");
  await call("write", { path: "fresh.txt", content: "x\n" });
  const e = await call("edit", { path: "fresh.txt", old_string: "x", new_string: "y" });
  assert.equal(e.isError, undefined, e.content);
  const again = await call("write", { path: "r.txt", content: "z\n" });
  assert.equal(again.isError, undefined, "a successful write keeps the ledger current");
});

test("write refuses a directory", async () => {
  const { dir, call } = setup();
  mkdirSync(join(dir, "d"));
  assert.match((await call("write", { path: "d", content: "x" })).content, /is a directory/);
});

test("planEdit is pure and handles $ patterns literally", () => {
  const p = planEdit("a $& b", "$&", "$1", false, "f");
  assert.deepEqual(p, { ok: true, after: "a $1 b", count: 1 });
});

test("unifiedDiff gives hunks with context, a new-file header, and a cap", () => {
  const before = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 10\n", "line ten\n").replace("line 40\n", "");
  const d = unifiedDiff("f.txt", before, after);
  assert.match(d, /^--- a\/f.txt\n\+\+\+ b\/f.txt\n@@ -7,7 \+7,7 @@/);
  assert.match(d, /-line 10\n\+line ten/);
  assert.match(d, /@@ -37,7 \+37,6 @@/);
  assert.match(unifiedDiff("n.txt", null, "x\ny\n"), /^--- \/dev\/null\n\+\+\+ b\/n.txt\n@@ -0,0 \+1,2 @@\n\+x\n\+y$/);
  const big = unifiedDiff("b.txt", "", Array.from({ length: 1000 }, (_, i) => `${i}`).join("\n"), { maxLines: 10 });
  assert.match(big, /\[diff cut: 990 more changed lines not shown\]/);
  assert.equal(unifiedDiff("same", "a\n", "a\n"), "");
});
