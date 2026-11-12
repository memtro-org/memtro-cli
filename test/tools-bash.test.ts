import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { bashTool, childEnv, runCommand, shellFor } from "../src/tools/bash.js";

const posix = process.platform !== "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "memtro-bash-"));
const never = new AbortController().signal;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

test("the child environment holds no Memtro credential, by name or by value", { skip: !posix }, async () => {
  const env = {
    PATH: process.env.PATH,
    MEMTRO_API_KEY: "sk-memtro-aaaaaaaaaaaaaaaa",
    MEMTRO_CREDENTIALS: "file",
    MEMTRO_STAGING_TOKEN: "t0ken",
    MEMTRO_OAUTH_SECRET: "s3cret",
    WORK_MEMTRO_KEY: "sk-memtro-bbbbbbbbbbbbbbbb",
    SOMETHING_ELSE: " sk-memtro-cccccccccccccccc",
    LEGACY: "sk-brain-dddddddddddddddd",
    MEMTRO_BASE_URL: "https://example.test",
    KEEP_ME: "yes",
  };
  const r = await runCommand("env", { cwd: tmp(), signal: never, timeoutMs: 10_000, env });
  assert.doesNotMatch(r.content, /sk-memtro-|sk-brain-/);
  assert.doesNotMatch(r.content, /MEMTRO_API_KEY|MEMTRO_CREDENTIALS|MEMTRO_STAGING_TOKEN|MEMTRO_OAUTH_SECRET|WORK_MEMTRO_KEY|SOMETHING_ELSE/);
  assert.match(r.content, /KEEP_ME=yes/);
  assert.match(r.content, /MEMTRO_BASE_URL=https:\/\/example.test/);
  assert.deepEqual(Object.keys(childEnv({ A: "1", MEMTRO_api_key: "x", memtro_x_token: "y" })), ["A"]);
});

test("a non-zero exit is reported, not a tool failure; stdout and stderr are both kept", { skip: !posix }, async () => {
  const r = await runCommand("echo out; echo err >&2; exit 3", { cwd: tmp(), signal: never, timeoutMs: 10_000 });
  assert.equal(r.isError, undefined);
  assert.match(r.content, /out/);
  assert.match(r.content, /err/);
  assert.match(r.content, /\[Exit code 3\.\]$/);
  assert.deepEqual(r.display && r.display.kind === "command" ? r.display.exitCode : "?", 3);
});

test("output is streamed to onProgress and capped to the last 2000 lines", { skip: !posix }, async () => {
  let streamed = "";
  const r = await runCommand("seq 1 5000", { cwd: tmp(), signal: never, timeoutMs: 10_000, onProgress: (t) => (streamed += t) });
  assert.match(streamed, /^1\n2\n/);
  assert.match(r.content, /^\[Output cut: the first 3000 lines \([\d.]+ KB\) are not shown; this is the end of the output\.\]\n3001\n/);
  assert.match(r.content, /\n5000\n\[Exit code 0\.\]$/);
});

test("a flood of output stays bounded in memory and in the result", { skip: !posix }, async () => {
  const r = await runCommand("yes abcdefghij | head -c 20000000", { cwd: tmp(), signal: never, timeoutMs: 30_000 });
  assert.ok(Buffer.byteLength(r.content) < 52 * 1024, `result was ${Buffer.byteLength(r.content)} bytes`);
  assert.match(r.content, /Output cut: the first \d+ lines/);
});

test("on timeout the command and the grandchild it started are killed", { skip: !posix }, async () => {
  const dir = tmp();
  const started = Date.now();
  const r = await runCommand("(sleep 30; echo late) & echo $! > child.pid; sleep 30", { cwd: dir, signal: never, timeoutMs: 600, graceMs: 300 });
  assert.ok(Date.now() - started < 5000);
  assert.match(r.content, /\[Timed out after 600 ms; the command and its children were stopped\.\]/);
  const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
  assert.ok(await waitDead(pid), "the grandchild is gone");
});

test("a process group ignoring SIGTERM is killed with SIGKILL after the grace period", { skip: !posix }, async () => {
  const dir = tmp();
  const started = Date.now();
  const r = await runCommand("trap '' TERM; sleep 30 & echo $! > child.pid; wait", { cwd: dir, signal: never, timeoutMs: 400, graceMs: 300 });
  assert.ok(Date.now() - started < 5000);
  assert.match(r.content, /Timed out/);
  const pid = Number(readFileSync(join(dir, "child.pid"), "utf8"));
  assert.ok(await waitDead(pid));
});

test("an interrupt stops the command and says so", { skip: !posix }, async () => {
  const dir = tmp();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const started = Date.now();
  const r = await runCommand("sleep 30 & echo $! > child.pid; wait", { cwd: dir, signal: ac.signal, timeoutMs: 60_000, graceMs: 300 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(r.isError, true);
  assert.match(r.content, /Interrupted by the person/);
  if (existsSync(join(dir, "child.pid"))) assert.ok(await waitDead(Number(readFileSync(join(dir, "child.pid"), "utf8"))));
  const before = await runCommand("echo hi", { cwd: dir, signal: AbortSignal.abort(), timeoutMs: 1000 });
  assert.match(before.content, /did not run/);
});

test("a background child holding the output does not keep the call open", { skip: !posix }, async () => {
  const started = Date.now();
  const r = await runCommand("sleep 20 & echo done", { cwd: tmp(), signal: never, timeoutMs: 60_000 });
  assert.ok(Date.now() - started < 5000);
  assert.match(r.content, /done/);
  assert.match(r.content, /Exit code 0/);
});

test("failing to start is a tool failure", async () => {
  const r = await runCommand("echo hi", { cwd: join(tmp(), "does-not-exist"), signal: never, timeoutMs: 5000 });
  assert.equal(r.isError, true);
  assert.match(r.content, /could not be started/);
});

test("validation, risk, summary and shell choice", () => {
  const t = bashTool();
  assert.deepEqual(t.validate({ command: "ls", timeout_ms: 5000 }), { ok: true, args: { command: "ls", timeout_ms: 5000, description: undefined } });
  assert.equal(t.validate({ command: "ls", timeout_ms: 700_000 }).ok, false);
  assert.equal(t.validate({}).ok, false);
  assert.equal(t.risk({ command: "ls" }, { cwd: "/", workspaceRoot: "/" }), "execute");
  const s = t.summarise({ command: "npm test -- --watch=false" }, { cwd: "/", workspaceRoot: "/" });
  assert.deepEqual(s, { title: "Run `npm test -- --watch=false`", command: "npm test -- --watch=false" });
  assert.deepEqual(shellFor("x", "linux", () => false), { file: "/bin/sh", args: ["-c", "x"] });
  assert.deepEqual(shellFor("x", "linux", () => true), { file: "/bin/bash", args: ["-c", "x"] });
  assert.deepEqual(shellFor("x", "win32").args, ["/d", "/s", "/c", "x"]);
});
