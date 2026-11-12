// The seam between the session's update wiring (commands/update.ts) and the real updater (src/update/index.ts),
// with no fake in between: a real cache file, a real background refresh against a server that never answers, and
// `memtro update` run as the real built executable against a local stand-in for GitHub. Nothing reaches the
// network; every environment is built from scratch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCommandLine } from "../src/args.js";
import { startUpdateCheck } from "../src/commands/update.js";
import { buildContext } from "../src/context.js";
import { VERSION } from "../src/version.js";
import { Capture, stdinFrom } from "./fake-platform.js";
import { fakeExecutable, fakeGitHub, makeRelease, sha256, type FakeGitHub } from "./update-fixtures.js";

const TARGET = `${process.platform}-${process.arch}`;
const BUILT = fileURLToPath(new URL(`../build/memtro-${TARGET}`, import.meta.url));
const NEWER = "9.1.0";

let gh: FakeGitHub;
let silent: Server;
let silentBase = "";
before(async () => {
  gh = await fakeGitHub();
  // A release host that accepts the connection and never answers.
  silent = createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  silentBase = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/releases`;
});
after(async () => {
  await gh.close();
  silent.closeAllConnections();
  await new Promise<void>((r) => silent.close(() => r()));
});

function sessionContext(env: NodeJS.ProcessEnv) {
  const parsed = parseCommandLine([]);
  const stdout = new Capture(true);
  const ctx = buildContext({ stdout, stderr: new Capture(), stdin: stdinFrom(null, true), env, flags: parsed.flags, positionals: [], cwd: tmpdir() });
  return ctx;
}

test("seam: the notice comes from a real cache file; the real background refresh never delays start, and is stopped", async () => {
  const state = mkdtempSync(join(tmpdir(), "memtro-seam-state-"));
  try {
    mkdirSync(join(state, "memtro"), { recursive: true });
    writeFileSync(join(state, "memtro", "update.json"), JSON.stringify({ checked: "2000-01-01T00:00:00.000Z", latest: NEWER, tag: `v${NEWER}` }));
    const env: NodeJS.ProcessEnv = { XDG_STATE_HOME: state, MEMTRO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memtro-seam-cfg-")), MEMTRO_RELEASE_BASE: silentBase };
    const lines: string[] = [];
    const started = Date.now();
    const stop = await startUpdateCheck(sessionContext(env), (l) => lines.push(l));
    assert.ok(Date.now() - started < 500, "start-up did not wait for the network");
    assert.deepEqual(lines, [`memtro ${NEWER} is available (you have ${VERSION}). Type /update.`]);
    // The stale cache makes the real refresh ask the silent host; stopping it ends it without a write.
    await new Promise((r) => setTimeout(r, 100));
    stop();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(JSON.parse(readFileSync(join(state, "memtro", "update.json"), "utf8")).checked, "2000-01-01T00:00:00.000Z", "a cancelled check records nothing");
    // A cache holding something that is not a version prints nothing.
    writeFileSync(join(state, "memtro", "update.json"), JSON.stringify({ checked: new Date().toISOString(), latest: "9.9.9\u001b[2J", tag: "v9.9.9\u001b[2J" }));
    const quiet: string[] = [];
    (await startUpdateCheck(sessionContext(env), (l) => quiet.push(l)))();
    assert.deepEqual(quiet, []);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

/** Runs a copy of the real built executable with a from-scratch environment; resolves with its exit and output. */
function runBuilt(exe: string, args: string[], home: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_STATE_HOME: join(home, "state"),
        MEMTRO_CREDENTIALS: "file",
        MEMTRO_BASE_URL: "http://127.0.0.1:9",
        MEMTRO_RELEASE_BASE: gh.base,
        MEMTRO_API_KEY: "sk-memtro-never-sent-to-the-release-host",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function publish(version: string, exe: Buffer, opts: { tamper?: string } = {}): void {
  gh.releases.clear();
  const r = makeRelease(version, { [TARGET]: exe }, opts);
  gh.releases.set(r.tag, r);
  gh.latestTag = r.tag;
}

test("seam: `memtro update` as the real built executable: current 0, updated 0, failed 1, unmanaged 2", { skip: !existsSync(BUILT) && "no build/ executable (run npm run bundle && npm run build:sea)" }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "memtro-seam-")));
  try {
    const bin = join(home, "bin");
    mkdirSync(bin);
    const exe = join(bin, "memtro");
    const fresh = () => copyFileSync(BUILT, exe);

    fresh();
    publish(VERSION, fakeExecutable(VERSION));
    const current = await runBuilt(exe, ["update"], home);
    assert.equal(current.code, 0, current.err);
    assert.match(current.out, /is the latest release; nothing to do/);

    publish(NEWER, fakeExecutable(NEWER), { tamper: TARGET });
    const failed = await runBuilt(exe, ["update"], home);
    assert.equal(failed.code, 1, failed.out + failed.err);
    assert.match(failed.err, /checksum does not match/);
    assert.equal(sha256(readFileSync(exe)), sha256(readFileSync(BUILT)), "nothing replaced");

    // No attestation exists for a tarball built here: GitHub's answer (404) refuses the update, and nothing is replaced.
    publish(NEWER, fakeExecutable(NEWER));
    const unattested = await runBuilt(exe, ["update"], home);
    assert.equal(unattested.code, 1, unattested.out + unattested.err);
    assert.match(unattested.err, /not a memtro release build/);
    assert.equal(sha256(readFileSync(exe)), sha256(readFileSync(BUILT)), "nothing replaced");

    // GitHub's API failing: the update proceeds on the checksum and says the attestation could not be checked.
    gh.requests.length = 0;
    gh.intercept = (path, res) => (path.startsWith("/repos/memtro-org/memtro-cli/attestations/") ? (res.writeHead(503).end(), true) : false);
    const updated = await runBuilt(exe, ["update"], home);
    gh.intercept = null;
    assert.equal(updated.code, 0, updated.err);
    assert.match(updated.out, new RegExp(`Updated to ${NEWER.replace(/\./g, "\\.")}\\. The build attestation could not be checked: GitHub's API failed \\(HTTP 503\\)\\. The download matched its published checksum\\. It starts the next time you run memtro\\.`));
    assert.equal(readFileSync(exe, "utf8"), fakeExecutable(NEWER).toString(), "the verified file is now in place");
    for (const r of gh.requests) {
      assert.equal(r.headers.authorization, undefined);
      assert.ok(!JSON.stringify(r.headers).includes("sk-memtro"), "no Memtro key reaches the release host");
    }

    const nm = join(home, "node_modules", "@memtro", "cli");
    mkdirSync(nm, { recursive: true });
    copyFileSync(BUILT, join(nm, "memtro"));
    const unmanaged = await runBuilt(join(nm, "memtro"), ["update"], home);
    assert.equal(unmanaged.code, 2, unmanaged.out + unmanaged.err);
    assert.match(unmanaged.out + unmanaged.err, /cannot update itself.*installed with npm/s);

    fresh();
    const bad = await runBuilt(exe, ["update", "--version", "nope"], home);
    assert.equal(bad.code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
