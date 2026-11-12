import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { performUpdate, type UpdateDeps, type UpdateOutcome } from "../src/update/index.js";
import { VERSION } from "../src/version.js";
import { fakeExecutable, fakeGitHub, makeRelease, sha256, tarGz, type FakeGitHub } from "./update-fixtures.js";

const NEWER = "9.0.0";
const TARGET = `${process.platform}-${process.arch}`;
const FAKE_KEY = "mk_live_this_must_never_be_sent_0123456789";
/** The real standalone executable when `npm run bundle && npm run build:sea` has run here; a script otherwise. */
const BUILT = fileURLToPath(new URL(`../build/memtro-${TARGET}`, import.meta.url));
const OLD = existsSync(BUILT) ? readFileSync(BUILT) : fakeExecutable(VERSION);

let gh: FakeGitHub;
let dir: string;
let exe: string;
let oldSum: string;

before(async () => {
  gh = await fakeGitHub();
});
after(async () => {
  await gh.close();
});
// Each test may hold a copy of the real ~115 MB executable: never leave them behind in the temp directory.
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  gh.requests.length = 0;
  gh.intercept = null;
  gh.latestTag = null;
  gh.releases.clear();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "memtro-update-perform-")));
  mkdirSync(join(dir, "bin"));
  exe = join(dir, "bin", "memtro");
  writeFileSync(exe, OLD, { mode: 0o755 });
  oldSum = sha256(OLD);
});

function deps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    env: { MEMTRO_RELEASE_BASE: gh.base, MEMTRO_API_KEY: FAKE_KEY, PATH: process.env.PATH },
    stateDir: join(dir, "state"),
    now: () => new Date("2026-11-12T10:00:00Z"),
    fetch: globalThis.fetch,
    execPath: exe,
    platform: process.platform,
    arch: process.arch,
    isSea: true,
    ...over,
  };
}

function publish(version: string, exeBytes: Buffer = fakeExecutable(version), opts: { tamper?: string } = {}): void {
  const r = makeRelease(version, { [TARGET]: exeBytes }, opts);
  gh.releases.set(r.tag, r);
  gh.latestTag = r.tag;
}

const update = (d: UpdateDeps = deps(), version?: string, signal = new AbortController().signal): Promise<UpdateOutcome> =>
  performUpdate(d, { version, signal });

function assertUntouched(): void {
  assert.equal(sha256(readFileSync(exe)), oldSum, "the old executable is byte-identical");
  assert.deepEqual(readdirSync(join(dir, "bin")), ["memtro"], "no temporary file left behind");
}

test("success: the new version replaces the executable, starts, and reports itself", async () => {
  publish(NEWER);
  const progress: string[] = [];
  const out = await performUpdate(deps(), { signal: new AbortController().signal, onProgress: (t) => progress.push(t) });
  assert.deepEqual(out, { kind: "updated", from: VERSION, to: NEWER, path: exe });
  assert.equal(execFileSync(exe, ["--version"], { encoding: "utf8" }).trim(), NEWER);
  assert.equal(statSync(exe).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(join(dir, "bin")), ["memtro"]);
  assert.ok(progress.length >= 3, progress.join(" | "));
  for (const r of gh.requests) {
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers.cookie, undefined);
    assert.ok(!JSON.stringify(r.headers).includes(FAKE_KEY));
    assert.equal(r.headers["user-agent"], `memtro-cli/${VERSION}`);
  }
  // checksums.txt and the tarball come from the same tag latest.json named.
  assert.ok(gh.requests.some((r) => r.url === `/releases/download/v${NEWER}/checksums.txt`));
  assert.ok(gh.requests.some((r) => r.url === `/releases/download/v${NEWER}/memtro-${TARGET}.tar.gz`));
});

test("success through a symlink: the real file is replaced, the link kept", async () => {
  publish(NEWER);
  const link = join(dir, "memtro-link");
  symlinkSync(exe, link);
  const out = await update(deps({ execPath: link }));
  assert.equal(out.kind, "updated");
  assert.equal(execFileSync(link, ["--version"], { encoding: "utf8" }).trim(), NEWER);
});

test("a pinned version, with or without the v", async () => {
  publish(NEWER);
  const pinned = makeRelease("3.1.4", { [TARGET]: fakeExecutable("3.1.4") });
  gh.releases.set(pinned.tag, pinned);
  assert.deepEqual(await update(deps(), "v3.1.4"), { kind: "updated", from: VERSION, to: "3.1.4", path: exe });
  assert.ok(!gh.requests.some((r) => r.url.includes("latest")), "a pinned version never asks for latest");
});

test("already current, or latest older: nothing downloaded", async () => {
  publish(VERSION);
  assert.deepEqual(await update(), { kind: "current", version: VERSION });
  publish("0.0.1");
  assert.deepEqual(await update(), { kind: "current", version: VERSION });
  assert.deepEqual(await update(deps(), VERSION), { kind: "current", version: VERSION });
  assert.ok(!gh.requests.some((r) => r.url.endsWith(".tar.gz")));
  assertUntouched();
});

test("checksum mismatch: failed, nothing replaced", async () => {
  publish(NEWER, fakeExecutable(NEWER), { tamper: TARGET });
  const out = await update();
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /checksum/);
  assertUntouched();
});

for (const [label, entries] of [
  ["a traversal entry", [{ name: "../memtro", data: fakeExecutable(NEWER) }]],
  ["an absolute path", [{ name: "/tmp/memtro", data: fakeExecutable(NEWER) }]],
  ["a symlink entry", [{ name: "memtro", type: "2", linkname: "/bin/sh" }]],
  ["a hard link entry", [{ name: "memtro", type: "1", linkname: "/bin/sh" }]],
  ["a directory then the file", [{ name: "memtro/", type: "5" }, { name: "memtro", data: fakeExecutable(NEWER) }]],
  ["two files", [{ name: "memtro", data: fakeExecutable(NEWER) }, { name: "memtro", data: fakeExecutable("6.6.6") }]],
  ["the wrong name", [{ name: "node", data: fakeExecutable(NEWER) }]],
  ["a pax header", [{ name: "PaxHeader", type: "x", data: Buffer.from("30 path=../../../etc/memtro\n") }, { name: "memtro", data: fakeExecutable(NEWER) }]],
] as const) {
  test(`a tarball with ${label} is refused and nothing is written`, async () => {
    const r = makeRelease(NEWER, {});
    const tarball = tarGz(entries.map((e) => ({ ...e })));
    r.files[`memtro-${TARGET}.tar.gz`] = tarball;
    r.files["checksums.txt"] = `${sha256(tarball)}  memtro-${TARGET}.tar.gz\n`;
    gh.releases.set(r.tag, r);
    gh.latestTag = r.tag;
    const out = await update();
    assert.equal(out.kind, "failed", JSON.stringify(out));
    assertUntouched();
    assert.ok(!existsSync(join(dir, "memtro")) && !existsSync(join(dir, "PaxHeader")));
  });
}

test("a corrupt (non-gzip) tarball whose checksum matches is refused", async () => {
  const r = makeRelease(NEWER, {});
  const junk = Buffer.from("this is not a tarball");
  r.files[`memtro-${TARGET}.tar.gz`] = junk;
  r.files["checksums.txt"] = `${sha256(junk)}  memtro-${TARGET}.tar.gz\n`;
  gh.releases.set(r.tag, r);
  gh.latestTag = r.tag;
  assert.equal((await update()).kind, "failed");
  assertUntouched();
});

test("an unwritable directory: unmanaged, nothing fetched", async () => {
  publish(NEWER);
  chmodSync(join(dir, "bin"), 0o555);
  try {
    const out = await update();
    assert.equal(out.kind, "unmanaged", JSON.stringify(out));
    assert.match((out as { howTo: string }).howTo, /install\.sh/);
    assert.equal(gh.requests.length, 0);
  } finally {
    chmodSync(join(dir, "bin"), 0o755);
  }
  assertUntouched();
});

test("not a single executable (npm, a checkout): unmanaged", async () => {
  publish(NEWER);
  const out = await update(deps({ isSea: false }));
  assert.equal(out.kind, "unmanaged");
  assert.match((out as { howTo: string }).howTo, /npm install -g @memtro\/cli/);
  assert.equal(gh.requests.length, 0);
  assertUntouched();
});

test("inside node_modules or a system or Homebrew prefix: unmanaged", async () => {
  publish(NEWER);
  const nm = join(dir, "node_modules", "@memtro", "cli");
  mkdirSync(nm, { recursive: true });
  copyFileSync(exe, join(nm, "memtro"));
  assert.equal((await update(deps({ execPath: join(nm, "memtro") }))).kind, "unmanaged");
  for (const p of ["/usr/bin/true", "/bin/sh"]) assert.equal((await update(deps({ execPath: p }))).kind, "unmanaged", p);
  assert.equal(gh.requests.length, 0);
});

test("an unsupported platform or architecture: unmanaged", async () => {
  assert.equal((await update(deps({ platform: "win32" }))).kind, "unmanaged");
  assert.equal((await update(deps({ arch: "ia32" }))).kind, "unmanaged");
});

test("a new executable that fails its --version proof, or reports another version, is not swapped in", async () => {
  publish(NEWER, fakeExecutable(NEWER, 1));
  assert.equal((await update()).kind, "failed");
  assertUntouched();
  publish(NEWER, fakeExecutable("8.8.8"));
  const out = await update();
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /8\.8\.8/);
  assertUntouched();
});

test("the proof runs with no Memtro key in its environment", async () => {
  const spy = Buffer.from(`#!/bin/sh\nenv > "${join(dir, "env.txt")}"\necho ${NEWER}\n`);
  publish(NEWER, spy);
  assert.equal((await update()).kind, "updated");
  const seen = readFileSync(join(dir, "env.txt"), "utf8");
  assert.ok(!seen.includes(FAKE_KEY) && !seen.includes("MEMTRO_API_KEY") && !seen.includes("MEMTRO_RELEASE_BASE"), seen);
});

test("interrupted mid-download: failed, nothing replaced", async () => {
  publish(NEWER);
  gh.intercept = (path, res) => {
    if (!path.endsWith(".tar.gz")) return false;
    res.writeHead(200, { "content-length": "100000" });
    res.write(Buffer.alloc(5000, 1));
    setTimeout(() => res.socket?.destroy(), 20);
    return true;
  };
  const out = await update();
  assert.equal(out.kind, "failed", JSON.stringify(out));
  assertUntouched();
});

test("cancelled by the caller mid-download: failed, nothing replaced", async () => {
  publish(NEWER);
  gh.intercept = (path, res) => {
    if (!path.endsWith(".tar.gz")) return false;
    res.writeHead(200, { "content-length": "100000" });
    res.write(Buffer.alloc(5000, 1));
    return true; // and then stalls
  };
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 200);
  const out = await update(deps(), undefined, ctl.signal);
  assert.deepEqual(out, { kind: "failed", reason: "the update was cancelled" });
  assertUntouched();
});

test("a release without this platform's build, a missing release, and an unreachable host fail plainly", async () => {
  const r = makeRelease(NEWER, { "plan9-mips": fakeExecutable(NEWER) });
  gh.releases.set(r.tag, r);
  gh.latestTag = r.tag;
  const out = await update();
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /no memtro-.*tar\.gz/);
  const missing = await update(deps(), "7.7.7");
  assert.equal(missing.kind, "failed");
  assert.match((missing as { reason: string }).reason, /no release v7\.7\.7/);
  const offline = await update(deps({ env: { MEMTRO_RELEASE_BASE: "http://127.0.0.1:9/releases" } }));
  assert.equal(offline.kind, "failed");
  assert.equal((await update(deps(), "not-a-version")).kind, "failed");
  assertUntouched();
});

test("a download redirected off the release host is refused", async () => {
  publish(NEWER);
  gh.intercept = (path, res) => (path.endsWith(".tar.gz") ? (res.writeHead(302, { location: "http://127.0.0.2:9/x.tar.gz" }).end(), true) : false);
  const out = await update();
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /refusing/);
  assertUntouched();
});
