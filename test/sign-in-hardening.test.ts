// Sign-in on first use, reviewed for the paths the decision table does not spell out: the loopback listener is
// closed however the sign-in ends; an interrupt leaves no key and no listener; a refused stored key is replaced
// only once a new sign-in has succeeded; the host said is the one opened. Every env is built from scratch.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseCommandLine } from "../src/args.js";
import { signIn, startSignedIn, type SignInDeps } from "../src/auth/ensure.js";
import { buildContext, type Context } from "../src/context.js";
import { checkBaseUrl } from "../src/config.js";
import { Capture, startFakePlatform, stdinFrom, type FakePlatform } from "./fake-platform.js";

let fake: FakePlatform;
before(async () => (fake = await startFakePlatform()));
after(() => fake.close());

const freshEnv = (): NodeJS.ProcessEnv => ({
  MEMTRO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memtro-sih-")),
  XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "memtro-sih-state-")),
  MEMTRO_CREDENTIALS: "file",
  MEMTRO_BASE_URL: fake.base,
  MEMTRO_NO_UPDATE_CHECK: "1",
  NO_COLOR: "1",
});

function context(env: NodeJS.ProcessEnv): { ctx: Context; stderr: Capture } {
  const parsed = parseCommandLine(["whoami"]);
  const stderr = new Capture(false);
  const ctx = buildContext({ stdout: new Capture(true), stderr, stdin: stdinFrom(null, true), env, flags: parsed.flags, positionals: parsed.positionals, cwd: tmpdir() });
  return { ctx, stderr };
}

function storedKey(env: NodeJS.ProcessEnv): string | null {
  const path = join(env.MEMTRO_CONFIG_DIR!, "credentials.json");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").match(/sk-memtro-[A-Za-z0-9_-]+/)?.[0] ?? null;
}

/** The loopback listener's port, from the redirect_uri the authorize address carries. */
const portOf = (url: string): number => Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port);

/** Whether anything accepts on the port, after the listener's own deferred close has had its tick. */
async function listening(port: number): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 50));
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

/** A browser that never approves; it records the address and lets the test end the wait. */
function idleBrowser(onOpen: (url: string) => void | Promise<void>): Partial<SignInDeps> {
  return { hostname: () => "test-host", platform: "darwin", timeoutMs: 60_000, openBrowser: async (url) => (await onOpen(url), true) };
}

test("an interrupt mid sign-in stores no key and leaves no listener", async () => {
  const env = freshEnv();
  const { ctx } = context(env);
  let port = 0;
  const pending = signIn(ctx, { interactive: true, noBrowser: false }, idleBrowser((url) => {
    port = portOf(url);
    setImmediate(() => process.emit("SIGINT"));
  }));
  await assert.rejects(pending, /Sign-in cancelled\. Nothing was stored\./);
  assert.ok(port > 0);
  assert.equal(await listening(port), false, "the loopback listener is closed");
  assert.equal(storedKey(env), null);
  assert.equal(process.listenerCount("SIGINT"), 0, "its SIGINT handler is gone too");
});

test("a browser opener that throws, and a sign-in that times out, close the listener", async () => {
  for (const kind of ["throws", "timeout"] as const) {
    const env = freshEnv();
    const { ctx } = context(env);
    let port = 0;
    const deps: Partial<SignInDeps> =
      kind === "throws"
        ? { hostname: () => "h", platform: "darwin", timeoutMs: 60_000, openBrowser: async (url) => ((port = portOf(url)), Promise.reject(new Error("no opener"))) }
        : { ...idleBrowser((url) => void (port = portOf(url))), timeoutMs: 200 };
    await assert.rejects(signIn(ctx, { interactive: true, noBrowser: false }, deps));
    assert.ok(port > 0, kind);
    assert.equal(await listening(port), false, `${kind}: listener closed`);
    assert.equal(storedKey(env), null, kind);
  }
});

test("a refused stored key is kept until a new sign-in succeeds: a sign-in cancelled in the browser leaves it", async () => {
  const env = freshEnv();
  const { ctx } = context(env);
  await signIn(ctx, { interactive: true, noBrowser: false }, { hostname: () => "h", platform: "darwin", openBrowser: async (url) => (void fetch(url).catch(() => {}), true) });
  const key = storedKey(env)!;
  fake.keys.get(key)!.revoked = true;
  fake.mode = "deny";
  try {
    const { ctx: again } = context(env);
    const start = async (c: Context) => (await c.client()).json("/api/cli/whoami");
    await assert.rejects(
      startSignedIn(again, { interactive: true, noBrowser: false }, start, { hostname: () => "h", platform: "darwin", openBrowser: async (url) => (void fetch(url).catch(() => {}), true) }),
      /cancelled in the browser/,
    );
    assert.equal(storedKey(env), key, "the old key is still where it was");
  } finally {
    fake.mode = "approve";
  }
});

test("the host said before the browser opens is the origin of the address opened; control characters cannot reach the line", async () => {
  const env = freshEnv();
  const { ctx, stderr } = context(env);
  let opened = "";
  await signIn(ctx, { interactive: true, noBrowser: false }, { hostname: () => "h", platform: "darwin", openBrowser: async (url) => ((opened = url), void fetch(url).catch(() => {}), true) });
  const said = /Signing in to (\S+): opening/.exec(stderr.text)![1]!;
  assert.equal(new URL(said).origin, new URL(opened).origin);
  // A base URL is normalised by URL parsing before it is printed: no raw control character or look-alike survives.
  assert.match(checkBaseUrl("https://plаtform.memtro.com"), /^https:\/\/xn--[a-z0-9-]+\.memtro\.com$/, "a look-alike host is shown as punycode");
  assert.throws(() => checkBaseUrl("https://evil.example\u001b]0;x\u0007"), (e: Error) => !/[\u0000-\u001f]/.test(e.message));
});
