import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Tool, ToolContext } from "../src/agent/types.js";
import { createLocalTools } from "../src/tools/index.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "memtro-read-"));
  const read = createLocalTools().find((t) => t.spec.name === "read") as Tool;
  const ctx: ToolContext = { cwd: dir, workspaceRoot: dir, signal: new AbortController().signal };
  const call = async (raw: Record<string, unknown>) => {
    const v = read.validate(raw);
    if (!v.ok) return { content: `invalid: ${v.error}`, isError: true };
    return read.run(v.args, ctx);
  };
  return { dir, call, read, ctx };
}

test("read numbers lines and shows a small file whole", async () => {
  const { dir, call } = setup();
  writeFileSync(join(dir, "a.txt"), "first\r\nsecond\n");
  const r = await call({ path: "a.txt" });
  assert.equal(r.content, "1\tfirst\n2\tsecond");
});

test("read caps at 2000 lines and says how to read on; offset and limit work", async () => {
  const { dir, call } = setup();
  writeFileSync(join(dir, "big.txt"), Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
  const r = await call({ path: "big.txt" });
  const lines = r.content.split("\n");
  assert.equal(lines.length, 2001);
  assert.match(lines[0]!, /^\s*1\tl1$/);
  assert.equal(lines[2000], "[Showed lines 1–2000 of 2500. Read on with offset=2001.]");
  const next = await call({ path: "big.txt", offset: 2001 });
  assert.match(next.content, /^2001\tl2001/);
  assert.match(next.content, /2500\tl2500\n\[Showed lines 2001–2500 of 2500; that is the end of the file.\]$/);
  const window = await call({ path: "big.txt", offset: 10, limit: 3 });
  assert.equal(window.content, "10\tl10\n11\tl11\n12\tl12\n[Showed lines 10–12 of 2500. Read on with offset=13.]");
  const past = await call({ path: "big.txt", offset: 3000 });
  assert.match(past.content, /has 2500 lines; there is nothing at line 3000/);
  assert.match((await call({ path: "big.txt", limit: 5000 })).content, /between 1 and 2000/);
});

test("read stops at 50 KB and cuts very long lines with a marker", async () => {
  const { dir, call } = setup();
  writeFileSync(join(dir, "wide.txt"), Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"));
  const r = await call({ path: "wide.txt" });
  assert.ok(Buffer.byteLength(r.content) <= 51 * 1024);
  assert.match(r.content, /\(the 50 KB limit\)\. Read on with offset=\d+\.\]$/);
  writeFileSync(join(dir, "long.txt"), "y".repeat(10_000));
  assert.match((await call({ path: "long.txt" })).content, /… \[line cut: 8000 more characters\]$/);
});

test("read refuses binary files and directories, and says when a file is missing or empty", async () => {
  const { dir, call } = setup();
  writeFileSync(join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const bin = await call({ path: "img.png" });
  assert.equal(bin.isError, true);
  assert.match(bin.content, /binary file/);
  mkdirSync(join(dir, "sub"));
  assert.match((await call({ path: "sub" })).content, /is a directory. Use `list`/);
  assert.match((await call({ path: "nope.txt" })).content, /does not exist/);
  writeFileSync(join(dir, "empty.txt"), "");
  assert.match((await call({ path: "empty.txt" })).content, /is empty/);
});

test("read's summary names the resolved absolute path", async () => {
  const { dir, read, ctx } = setup();
  const s = await read.summarise({ path: "x/y.txt" }, ctx);
  assert.equal(s.title, "Read x/y.txt");
  assert.ok(s.paths?.[0]?.endsWith(join("x", "y.txt")));
  assert.ok(s.paths?.[0]?.startsWith("/") || /^[A-Z]:/.test(s.paths?.[0] ?? ""));
  void dir;
});
