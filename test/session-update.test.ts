import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { parseCommandLine } from "../src/args.js";
import { run } from "../src/cli.js";
import { chat } from "../src/commands/chat.js";
import { cleanVersion, describeOutcome, requestedVersion, startUpdateCheck, updateNotice, type UpdateApi } from "../src/commands/update.js";
import { buildContext } from "../src/context.js";
import { EXIT } from "../src/errors.js";
import type { UpdateInfo, UpdateOutcome } from "../src/update/index.js";
import { Capture, startFakePlatform, stdinFrom, type FakePlatform } from "./fake-platform.js";

/**
 * The update notice at the start of a session, `/update` and `memtro update`, against a fake of `src/update`:
 * nothing here reaches GitHub, and the fake's refresh can be made to never finish.
 */

let fake: FakePlatform;
before(async () => (fake = await startFakePlatform()));
after(() => fake.close());

const freshEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  MEMTRO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memtro-upd-")),
  MEMTRO_CREDENTIALS: "file",
  MEMTRO_BASE_URL: fake.base,
  XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "memtro-upd-state-")),
  NO_COLOR: "1",
  ...extra,
});

interface FakeUpdate {
  api: UpdateApi;
  cachedCalls: number;
  refreshSignals: AbortSignal[];
  configuredSeen: (boolean | undefined)[];
  performed: { version?: string }[];
}

function fakeUpdate(o: { cached?: UpdateInfo | null; disabled?: boolean; refresh?: "never" | "throws" | "ok"; outcome?: UpdateOutcome } = {}): FakeUpdate {
  const f: FakeUpdate = { api: undefined as unknown as UpdateApi, cachedCalls: 0, refreshSignals: [], configuredSeen: [], performed: [] };
  f.api = {
    cachedUpdate: () => {
      f.cachedCalls++;
      return o.cached ?? null;
    },
    refreshUpdateCache: (_deps, signal) => {
      f.refreshSignals.push(signal);
      if (o.refresh === "throws") throw new Error("offline");
      return o.refresh === "ok" ? Promise.resolve() : new Promise<void>(() => {});
    },
    updateCheckDisabled: (_env, configured) => {
      f.configuredSeen.push(configured);
      return o.disabled ?? configured === false;
    },
    performUpdate: async (_deps, opts) => {
      f.performed.push({ ...(opts.version ? { version: opts.version } : {}) });
      opts.onProgress?.("Downloading memtro-darwin-arm64.tar.gz\u001b[2J");
      return o.outcome ?? { kind: "current", version: "0.1.0" };
    },
    defaultUpdateDeps: () => ({}) as ReturnType<UpdateApi["defaultUpdateDeps"]>,
  };
  return f;
}

const newer: UpdateInfo = { current: "0.2.0", latest: "0.3.0", newer: true, tag: "v0.3.0" };

function context(env: NodeJS.ProcessEnv, opts: { tty?: boolean; argv?: string[] } = {}) {
  const parsed = parseCommandLine(opts.argv ?? []);
  const stdout = new Capture(opts.tty ?? true);
  const stderr = new Capture(false);
  const ctx = buildContext({ stdout, stderr, stdin: stdinFrom(null, true), env, flags: parsed.flags, positionals: parsed.positionals, cwd: tmpdir() });
  return { ctx, stdout, stderr };
}

test("versions from the cache are printed only when they look like versions", () => {
  assert.equal(cleanVersion("0.3.0"), "0.3.0");
  assert.equal(cleanVersion("1.2.3-rc.1"), "1.2.3-rc.1");
  for (const bad of ["v0.3.0", "0.3", "0.3.0\u001b[31m", "0.3.0 ; rm -rf ~", "", 3, null]) assert.equal(cleanVersion(bad), null, String(bad));
  assert.equal(updateNotice(newer), "memtro 0.3.0 is available (you have 0.2.0). Type /update.");
  assert.equal(updateNotice({ ...newer, newer: false }), null);
  assert.equal(updateNotice({ ...newer, latest: "9.9.9\u001b]0;pwned\u0007" }), null);
  assert.equal(updateNotice(null), null);
});

test("the notice: shown from the cache when newer, the refresh started and never awaited, stopped at the end", async () => {
  const f = fakeUpdate({ cached: newer, refresh: "never" });
  const shown: string[] = [];
  const { ctx } = context(freshEnv());
  const stop = await Promise.race([
    startUpdateCheck(ctx, (l) => shown.push(l), f.api),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("start-up waited on the refresh")), 500)),
  ]);
  assert.deepEqual(shown, ["memtro 0.3.0 is available (you have 0.2.0). Type /update."]);
  assert.equal(f.refreshSignals.length, 1, "a refresh was started");
  assert.equal(f.refreshSignals[0]!.aborted, false);
  stop();
  assert.equal(f.refreshSignals[0]!.aborted, true, "and is stopped when the session ends");

  // A refresh that throws at once is as invisible as one that fails later.
  const t = fakeUpdate({ cached: null, refresh: "throws" });
  const lines: string[] = [];
  (await startUpdateCheck(ctx, (l) => lines.push(l), t.api))();
  assert.deepEqual(lines, []);
});

test("the notice: never with --json, never when stdout is not a terminal, never when turned off", async () => {
  const shown: string[] = [];
  const show = (l: string) => shown.push(l);

  const json = fakeUpdate({ cached: newer });
  await startUpdateCheck(context(freshEnv(), { argv: ["--json"] }).ctx, show, json.api);
  assert.equal(json.cachedCalls + json.refreshSignals.length, 0, "--json: not even read");

  const piped = fakeUpdate({ cached: newer });
  await startUpdateCheck(context(freshEnv(), { tty: false }).ctx, show, piped.api);
  assert.equal(piped.cachedCalls + piped.refreshSignals.length, 0, "stdout not a terminal: not even read");

  const env = freshEnv({ MEMTRO_NO_UPDATE_CHECK: "1" });
  const off = fakeUpdate({ cached: newer, disabled: true });
  await startUpdateCheck(context(env).ctx, show, off.api);
  assert.equal(off.cachedCalls + off.refreshSignals.length, 0, "disabled: no cache read, no refresh");

  const configured = freshEnv();
  writeFileSync(join(configured.MEMTRO_CONFIG_DIR!, "config.json"), JSON.stringify({ version: 1, profiles: {}, updateCheck: false }));
  const cfg = fakeUpdate({ cached: newer });
  await startUpdateCheck(context(configured).ctx, show, cfg.api);
  assert.deepEqual(cfg.configuredSeen, [false], "config's updateCheck is handed to updateCheckDisabled");
  assert.equal(cfg.refreshSignals.length, 0);
  assert.deepEqual(shown, []);

  const wrong = freshEnv();
  writeFileSync(join(wrong.MEMTRO_CONFIG_DIR!, "config.json"), JSON.stringify({ version: 1, profiles: {}, updateCheck: "no" }));
  const w = fakeUpdate({ cached: newer });
  await startUpdateCheck(context(wrong).ctx, show, w.api);
  assert.match(shown.join("\n"), /updateCheck must be true or false/, "a wrong value is said, and start-up goes on");
  assert.equal(w.cachedCalls, 0);
});

test("a session starts and ends while the update refresh never finishes", async () => {
  const env = freshEnv({ MEMTRO_API_KEY: fake.mintKey() });
  const parsed = parseCommandLine(["--no-classifier"]);
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const stdout = new Capture(true);
  const ctx = buildContext({ stdout, stderr: new Capture(false), stdin, env, flags: parsed.flags, positionals: [], cwd: tmpdir() });
  const f = fakeUpdate({ cached: newer, refresh: "never" });
  const ended = chat(ctx, { update: f.api });
  // Leave once the session is up: Ctrl-D on an empty line.
  for (let i = 0; i < 300 && !stdout.text.includes("/help for commands"); i++) await new Promise((r) => setTimeout(r, 10));
  stdin.write("\u0004");
  stdin.end();
  const code = await Promise.race([ended, new Promise<string>((r) => setTimeout(() => r("hung"), 3000))]);
  assert.equal(code, 0);
  assert.match(stdout.text, /· memtro 0\.3\.0 is available \(you have 0\.2\.0\)\. Type \/update\./);
  assert.equal(f.refreshSignals.length, 1);
  assert.equal(f.refreshSignals[0]!.aborted, true, "the refresh is stopped when the session ends");
});

test("outcomes in words, and memtro update's exit codes", async () => {
  assert.deepEqual(describeOutcome({ kind: "updated", from: "0.2.0", to: "0.3.0", path: "/x/memtro", attestation: "verified" }), {
    text: "Updated to 0.3.0 (build attestation verified). It starts the next time you run memtro.",
    code: 0,
    ok: true,
  });
  assert.deepEqual(describeOutcome({ kind: "updated", from: "0.2.0", to: "0.3.0", path: "/x/memtro", attestation: "unchecked", detail: "GitHub's API was unreachable" }), {
    text: "Updated to 0.3.0. The build attestation could not be checked: GitHub's API was unreachable. The download matched its published checksum. It starts the next time you run memtro.",
    code: 0,
    ok: true,
  });
  const dirty = describeOutcome({ kind: "updated", from: "0.2.0", to: "0.3.0", path: "/x", attestation: "unchecked", detail: "bad\u001b[2J\nline" });
  assert.doesNotMatch(dirty.text, /\u001b|\n/, "an unchecked detail is cleaned before it reaches a terminal");
  assert.equal(describeOutcome({ kind: "current", version: "0.3.0" }).text, "memtro 0.3.0 is the latest release; nothing to do.");
  const un = describeOutcome({ kind: "unmanaged", reason: "it runs from a checkout", howTo: "git pull, then npm ci && npm run build" });
  assert.equal(un.code, 2);
  assert.match(un.text, /cannot update itself: it runs from a checkout\ngit pull, then npm ci && npm run build/);
  const failed = describeOutcome({ kind: "failed", reason: "checksum mismatch\u001b[2J" });
  assert.equal(failed.code, 1);
  assert.doesNotMatch(failed.text, /\u001b/, "a reason is cleaned before it reaches a terminal");

  assert.equal(requestedVersion(undefined), undefined);
  assert.equal(requestedVersion("v0.3.0"), "0.3.0");
  assert.throws(() => requestedVersion("latest"), /--version must be a release number/);

  const cases: [UpdateOutcome, number][] = [
    [{ kind: "updated", from: "0.1.0", to: "0.3.0", path: "/x", attestation: "verified" }, 0],
    [{ kind: "current", version: "0.1.0" }, 0],
    [{ kind: "failed", reason: "no network" }, 1],
    [{ kind: "unmanaged", reason: "a dev checkout", howTo: "git pull" }, 2],
  ];
  for (const [outcome, want] of cases) {
    const f = fakeUpdate({ outcome });
    const stdout = new Capture(false);
    const stderr = new Capture(false);
    const code = await run({ argv: ["update", "--version", "0.3.0"], env: freshEnv(), stdout, stderr, stdin: stdinFrom(null), cwd: tmpdir(), deps: { update: f.api } });
    assert.equal(code, want, outcome.kind);
    assert.deepEqual(f.performed, [{ version: "0.3.0" }]);
    assert.match(stderr.text, /Downloading memtro-darwin-arm64\.tar\.gz/, "progress is shown");
    assert.doesNotMatch(stderr.text, /\u001b\[2J/, "progress is cleaned");
  }
  const bad = await run({ argv: ["update", "--version", "nope"], env: freshEnv(), stdout: new Capture(), stderr: new Capture(), stdin: stdinFrom(null), cwd: tmpdir(), deps: { update: fakeUpdate().api } });
  assert.equal(bad, EXIT.usage);
  // Nothing about updates in `run` or anywhere but the session and the update command: no notice was asked for.
  const quiet = fakeUpdate({ cached: newer });
  await run({ argv: ["run", "x"], env: freshEnv(), stdout: new Capture(true), stderr: new Capture(), stdin: stdinFrom(null), cwd: tmpdir(), deps: { update: quiet.api } });
  assert.equal(quiet.cachedCalls, 0);
});
