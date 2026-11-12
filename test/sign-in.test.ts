import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseCommandLine } from "../src/args.js";
import { cleanPastedCode } from "../src/auth/authorize.js";
import { ensureSignedIn, isInteractive, signIn, startSignedIn, type SignInDeps } from "../src/auth/ensure.js";
import { PlatformError } from "../src/api/client.js";
import { run } from "../src/cli.js";
import { buildContext, type Context } from "../src/context.js";
import { AuthError, EXIT, KeyRefusedError, NO_LOGIN_COMMAND, UnavailableError } from "../src/errors.js";
import { Capture, startFakePlatform, stdinFrom, textReply, type FakePlatform } from "./fake-platform.js";

/**
 * Signing in on first use: the decision table of `ensureSignedIn` / `startSignedIn`, and which commands go through
 * it. The "browser" is a fetch that follows the fake platform's approval redirect to the loopback listener; nothing
 * here opens a real browser, touches the real keychain or reaches a real Memtro (every env is built from scratch).
 */

let fake: FakePlatform;
before(async () => (fake = await startFakePlatform()));
after(() => fake.close());

const freshEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  MEMTRO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memtro-signin-")),
  MEMTRO_CREDENTIALS: "file",
  MEMTRO_BASE_URL: fake.base,
  XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "memtro-signin-state-")),
  NO_COLOR: "1",
  ...extra,
});

/** A fake browser: records each address it is asked to open and what stderr said before it was asked. */
function fakeBrowser(stderr?: Capture) {
  const opened: { url: string; saidBefore: string }[] = [];
  const deps: Partial<SignInDeps> = {
    hostname: () => "test-host",
    platform: "darwin",
    openBrowser: async (url) => {
      opened.push({ url, saidBefore: stderr?.text ?? "" });
      void fetch(url).catch(() => {});
      return true;
    },
  };
  return { opened, deps };
}

function context(env: NodeJS.ProcessEnv, opts: { tty?: boolean; argv?: string[] } = {}) {
  const parsed = parseCommandLine(opts.argv ?? ["whoami"]);
  const stdout = new Capture(opts.tty ?? true);
  const stderr = new Capture(false);
  const ctx = buildContext({ stdout, stderr, stdin: stdinFrom(null, opts.tty ?? true), env, flags: parsed.flags, positionals: parsed.positionals, cwd: tmpdir() });
  return { ctx, stdout, stderr };
}

async function cli(argv: string[], env: NodeJS.ProcessEnv, opts: { tty?: boolean; stdin?: string | null } = {}) {
  const tty = opts.tty ?? false;
  const stdout = new Capture(tty);
  const stderr = new Capture(false);
  const browser = fakeBrowser(stderr);
  const stdin = opts.stdin !== undefined && opts.stdin !== null ? stdinFrom(opts.stdin, false) : stdinFrom(null, tty);
  const code = await run({ argv, env, stdout, stderr, stdin, cwd: tmpdir(), deps: { signIn: browser.deps } });
  return { code, out: stdout.text, err: stderr.text, opened: browser.opened };
}

/** Signs a fresh env in and returns its stored key. */
async function signedInEnv(): Promise<{ env: NodeJS.ProcessEnv; key: string }> {
  const env = freshEnv();
  const { ctx } = context(env);
  await signIn(ctx, { interactive: true, noBrowser: false }, fakeBrowser().deps);
  return { env, key: storedKey(env)! };
}

function storedKey(env: NodeJS.ProcessEnv): string | null {
  const path = join(env.MEMTRO_CONFIG_DIR!, "credentials.json");
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, "utf8")) as { keys?: Record<string, string> } & Record<string, unknown>;
  const found = JSON.stringify(doc).match(/sk-memtro-[A-Za-z0-9_-]+/);
  return found ? found[0] : null;
}

const whoamiStart = async (c: Context) => (await c.client()).json<{ user: { email: string } }>("/api/cli/whoami");

test("interactive means stdin and stdout are terminals and CI is not set", () => {
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} }), true);
  assert.equal(isInteractive({ stdin: { isTTY: false }, stdout: { isTTY: true }, env: {} }), false);
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: false }, env: {} }), false);
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CI: "true" } }), false);
});

test("a key from MEMTRO_API_KEY is used as it is: no request, no browser", async () => {
  const env = freshEnv({ MEMTRO_API_KEY: fake.mintKey() });
  const { ctx } = context(env);
  const browser = fakeBrowser();
  const sent = fake.requests.length;
  assert.equal(await ensureSignedIn(ctx, { interactive: true, noBrowser: false }, browser.deps), ctx);
  assert.equal(fake.requests.length, sent, "nothing is sent just to check the key");
  assert.equal(browser.opened.length, 0);
});

test("a stored key is used as it is: no request, no browser", async () => {
  const { env } = await signedInEnv();
  const { ctx } = context(env);
  const browser = fakeBrowser();
  const sent = fake.requests.length;
  assert.equal(await ensureSignedIn(ctx, { interactive: true, noBrowser: false }, browser.deps), ctx);
  assert.equal(fake.requests.length, sent);
  assert.equal(browser.opened.length, 0);
});

test("no key and a person there: the host and address are printed, then the browser; the command carries on", async () => {
  const env = freshEnv();
  const r = await cli(["whoami"], env, { tty: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.opened.length, 1, "signed in exactly once");
  const { url, saidBefore } = r.opened[0]!;
  assert.ok(saidBefore.includes(`Signing in to ${fake.base}`), "the host is said before the browser opens");
  assert.ok(saidBefore.includes(url), "the address is printed before the browser opens");
  assert.match(r.err, /Signed in as Ada Lovelace <ada@example.com> in Analytical Engines; this key expires on /);
  assert.match(r.out, /^Ada Lovelace <ada@example.com>\nOrganisation {2}Analytical Engines/, "then whoami itself ran, on stdout");
  const key = storedKey(env);
  assert.ok(key, "the key is stored");
  assert.ok(!(r.out + r.err).includes(key), "the key is never printed (whoami shows its prefix only)");

  // --json to a terminal may still sign in; stdout carries only the JSON.
  const env2 = freshEnv();
  const j = await cli(["whoami", "--json"], env2, { tty: true });
  assert.equal(j.code, 0, j.err);
  assert.equal(JSON.parse(j.out).organisation.name, "Analytical Engines");
  assert.match(j.err, /Signed in as/);
});

test("no key and nobody there (piped, or CI): exit 3 saying how, no browser, nothing sent", async () => {
  for (const [label, env, tty] of [
    ["piped", freshEnv(), false],
    ["CI", freshEnv({ CI: "1" }), true],
  ] as const) {
    const sent = fake.requests.length;
    const r = await cli(["whoami"], env, { tty });
    assert.equal(r.code, EXIT.auth, label);
    assert.match(r.err, /Not signed in\. Run `memtro` in a terminal to sign in, or set MEMTRO_API_KEY\./, label);
    assert.equal(r.opened.length, 0, label);
    assert.equal(fake.requests.length, sent, `${label}: nothing sent, so no sign-in started`);
  }
  // ensureSignedIn itself refuses before any listener exists: signIn is never reached.
  const { ctx } = context(freshEnv(), { tty: false });
  const browser = fakeBrowser();
  await assert.rejects(ensureSignedIn(ctx, { interactive: false, noBrowser: false }, browser.deps), (e: AuthError) => e.exitCode === EXIT.auth);
  assert.equal(browser.opened.length, 0);
});

test("a stored key Memtro refuses, with a person there: signed in again once, the old key retired", async () => {
  const { env, key } = await signedInEnv();
  fake.keys.get(key)!.revoked = true;
  const { ctx, stderr } = context(env);
  const browser = fakeBrowser(stderr);
  const started = await startSignedIn(ctx, { interactive: true, noBrowser: false }, whoamiStart, browser.deps);
  assert.equal(started.value.user.email, "ada@example.com");
  assert.equal(browser.opened.length, 1, "exactly one re-sign-in");
  assert.match(stderr.text, /refused the stored key for profile "default": it has been revoked or has expired\. Signing in again\./);
  const now = storedKey(env)!;
  assert.notEqual(now, key, "the stored key was replaced");
  assert.notEqual(started.ctx, ctx, "the context is read again after the sign-in");
});

test("a stored key Memtro refuses with nobody there is exit 3, and the key is left alone", async () => {
  const { env, key } = await signedInEnv();
  fake.keys.get(key)!.revoked = true;
  const { ctx } = context(env, { tty: false });
  const browser = fakeBrowser();
  await assert.rejects(startSignedIn(ctx, { interactive: false, noBrowser: false }, whoamiStart, browser.deps), (e: KeyRefusedError) => e instanceof KeyRefusedError && e.exitCode === EXIT.auth);
  assert.equal(browser.opened.length, 0);
  assert.equal(storedKey(env), key);
});

test("refused again straight after signing in is an error, never a loop", async () => {
  const { env } = await signedInEnv();
  const { ctx } = context(env);
  const browser = fakeBrowser();
  let calls = 0;
  const alwaysRefused = async () => {
    calls++;
    throw new KeyRefusedError("refused", "stored");
  };
  await assert.rejects(startSignedIn(ctx, { interactive: true, noBrowser: false }, alwaysRefused, browser.deps), (e: AuthError) => e.exitCode === EXIT.auth && /just issued/.test(e.message));
  assert.equal(browser.opened.length, 1, "one re-sign-in, no more");
  assert.equal(calls, 2);

  // No key at all: the first sign-in counts, so a refusal after it is the error at once.
  const { ctx: none } = context(freshEnv());
  const b2 = fakeBrowser();
  await assert.rejects(startSignedIn(none, { interactive: true, noBrowser: false }, alwaysRefused, b2.deps), /just issued/);
  assert.equal(b2.opened.length, 1);
});

test("a refused MEMTRO_API_KEY is exit 3 naming the variable; never a sign-in", async () => {
  const env = freshEnv({ MEMTRO_API_KEY: "sk-memtro-revokedrevokedrevoked" });
  const r = await cli(["search", "x1"], env, { tty: true });
  assert.equal(r.code, EXIT.auth);
  assert.match(r.err, /refused the key in MEMTRO_API_KEY/);
  assert.equal(r.opened.length, 0);
  const { ctx } = context(env);
  const browser = fakeBrowser();
  await assert.rejects(startSignedIn(ctx, { interactive: true, noBrowser: false }, whoamiStart, browser.deps), (e: KeyRefusedError) => e.source === "env");
  assert.equal(browser.opened.length, 0);
  assert.equal(storedKey(env), null, "nothing was stored");
});

test("unreachable, 5xx or a quota error: no sign-in, and the key is untouched", async () => {
  const { env, key } = await signedInEnv();
  for (const err of [
    new UnavailableError("Could not reach Memtro"),
    new PlatformError("Memtro failed to answer (HTTP 500)", { status: 500, retryable: true }),
    new PlatformError("allowance", { status: 429, code: "allowance_exhausted" }),
  ]) {
    const { ctx } = context(env);
    const browser = fakeBrowser();
    await assert.rejects(startSignedIn(ctx, { interactive: true, noBrowser: false }, async () => Promise.reject(err), browser.deps), (e) => e === err);
    assert.equal(browser.opened.length, 0);
    assert.equal(storedKey(env), key);
  }

  // And for real: the profile's host does not answer.
  const cfgPath = join(env.MEMTRO_CONFIG_DIR!, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.profiles.default.base_url = "http://127.0.0.1:9";
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = await cli(["whoami"], { ...env, MEMTRO_BASE_URL: "http://127.0.0.1:9" }, { tty: true });
  assert.equal(r.code, EXIT.unavailable);
  assert.equal(r.opened.length, 0);
  assert.equal(storedKey(env), key);
});

test("memtro login is gone: one line saying what to do, exit 2", async () => {
  for (const argv of [["login"], ["login", "--no-browser"], ["help", "login"]]) {
    const r = await cli(argv, freshEnv(), { tty: true });
    assert.equal(r.code, EXIT.usage, argv.join(" "));
    assert.equal(r.err, `memtro: ${NO_LOGIN_COMMAND}\n`);
    assert.equal(r.opened.length, 0);
  }
  assert.equal(NO_LOGIN_COMMAND, "There is no login command: run `memtro` and it signs you in.");
});

test("every command that needs a key signs in first; token, logout, update and help never do", async () => {
  const needing: string[][] = [
    ["whoami"],
    ["ask", "hello?"],
    ["search", "x1"],
    ["remember", "Ada prefers tea"],
    ["why", "--repo", "acme/app"],
    ["tools"],
    ["call", "memtro_remember", "--input", '{"content":"x"}'],
  ];
  for (const argv of needing) {
    const piped = await cli(argv, freshEnv());
    assert.equal(piped.code, EXIT.auth, `${argv[0]} piped`);
    assert.equal(piped.opened.length, 0);
    const there = await cli(argv, freshEnv(), { tty: true });
    assert.equal(there.opened.length, 1, `${argv[0]} in a terminal signs in`);
    assert.match(there.err, /Signed in as/, argv[0]);
  }
  // run: piped is exit 3 with the new words; in a terminal it signs in before the session starts.
  const runPiped = await cli(["run"], freshEnv(), { stdin: "do the thing" });
  assert.equal(runPiped.code, EXIT.auth);
  assert.match(runPiped.err, /Run `memtro` in a terminal to sign in/);
  assert.equal(runPiped.opened.length, 0);
  fake.chatScript.push(textReply("done"));
  const runThere = await cli(["run", "say done", "--no-classifier"], freshEnv(), { tty: true });
  assert.equal(runThere.opened.length, 1, "run in a terminal signs in");
  assert.equal(runThere.code, 0, runThere.err);

  const fakeUpdate = {
    cachedUpdate: () => null,
    refreshUpdateCache: async () => {},
    updateCheckDisabled: () => false,
    performUpdate: async () => ({ kind: "current" as const, version: "0.1.0" }),
    defaultUpdateDeps: () => ({}) as never,
  };
  for (const argv of [["token", "--show"], ["logout"], ["update"], ["--help"], ["--version"], ["help", "whoami"]]) {
    const env = freshEnv();
    const stdout = new Capture(true);
    const stderr = new Capture(false);
    const browser = fakeBrowser(stderr);
    await run({ argv, env, stdout, stderr, stdin: stdinFrom(null, true), cwd: tmpdir(), deps: { signIn: browser.deps, update: fakeUpdate } });
    assert.equal(browser.opened.length, 0, `${argv.join(" ")} never opens a browser`);
  }
});

test("--no-browser is a global flag: the address is printed and a code pasted", async () => {
  assert.equal(parseCommandLine(["whoami", "--no-browser"]).flags["no-browser"], true);
  assert.equal(parseCommandLine(["--no-browser"]).flags["no-browser"], true);
  const env = freshEnv();
  const { ctx, stderr } = context(env, { argv: ["whoami", "--no-browser"] });
  const browser = fakeBrowser(stderr);
  // The fake's manual approval page answers with the code itself; paste it in once the address is printed.
  const stdin = ctx.stdin as NodeJS.ReadWriteStream;
  const pasting = (async () => {
    for (let i = 0; i < 200 && !/cli\/authorize\S*/.test(stderr.text); i++) await new Promise((r) => setTimeout(r, 10));
    const url = /(http\S*\/cli\/authorize\S*)/.exec(stderr.text)![1]!;
    const code = await (await fetch(url)).text();
    stdin.write(`${code}\n`);
  })();
  const next = await ensureSignedIn(ctx, { interactive: true, noBrowser: true }, browser.deps);
  await pasting;
  assert.equal(browser.opened.length, 0, "no browser is opened");
  assert.match(stderr.text, new RegExp(`Signing in to ${fake.base.replace(/[.]/g, "\\.")}\\. Open this address`));
  assert.ok(await next.credential());
  // Pasted inside a session, where bracketed paste is on.
  assert.equal(cleanPastedCode("\u001b[200~abcdefghijklmnopqrstuvwxyz\u001b[201~\n"), "abcdefghijklmnopqrstuvwxyz");
});

test("no source file still says `memtro login`", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && /memtro login/.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk(join(import.meta.dirname, "..", "src"));
  assert.deepEqual(offenders, []);
});
