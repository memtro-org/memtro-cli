import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseCommandLine } from "../src/args.js";
import { run } from "../src/cli.js";
import { login } from "../src/commands/login.js";
import { buildContext } from "../src/context.js";
import { type CliError, EXIT } from "../src/errors.js";
import { Capture, startFakePlatform, stdinFrom, type FakePlatform } from "./fake-platform.js";

let fake: FakePlatform;
before(async () => (fake = await startFakePlatform()));
after(() => fake.close());

const freshEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  MEMTRO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memtro-cli-")),
  MEMTRO_CREDENTIALS: "file",
  MEMTRO_BASE_URL: fake.base,
  NO_COLOR: "1",
  ...extra,
});

async function cli(argv: string[], env: NodeJS.ProcessEnv, opts: { stdin?: string | null; stdoutTTY?: boolean; cwd?: string } = {}) {
  const stdout = new Capture(opts.stdoutTTY ?? false);
  const stderr = new Capture(false);
  const code = await run({ argv, env, stdout, stderr, stdin: stdinFrom(opts.stdin ?? null), cwd: opts.cwd ?? tmpdir() });
  return { code, out: stdout.text, err: stderr.text };
}

/** `memtro login`, with the "browser" being a fetch that follows the fake's approval redirect to the listener. */
async function signIn(env: NodeJS.ProcessEnv, argv: string[] = ["login"]) {
  const parsed = parseCommandLine(argv);
  const stdout = new Capture();
  const stderr = new Capture();
  const ctx = buildContext({ stdout, stderr, stdin: stdinFrom(null), env, flags: parsed.flags, positionals: parsed.positionals });
  let opened = "";
  const code = await login(ctx, {
    hostname: () => "test-host",
    platform: "darwin",
    openBrowser: async (url) => {
      opened = url;
      void fetch(url).catch(() => {});
      return true;
    },
  });
  return { code, out: stdout.text, err: stderr.text, opened };
}

test("exit 2 for usage, 0 for help and version, never touching the network", async () => {
  const env = freshEnv();
  assert.equal((await cli(["frobnicate"], env)).code, EXIT.usage);
  assert.equal((await cli(["search", "--nope", "x"], env)).code, EXIT.usage);
  assert.equal((await cli([], env)).code, EXIT.usage);
  const help = await cli(["--help"], env);
  assert.equal(help.code, 0);
  assert.match(help.out, /login\s+Sign in through the browser/);
  assert.match((await cli(["help", "call"], env)).out, /key:=json/);
  assert.match((await cli(["search", "--help"], env)).out, /--limit/);
  assert.match((await cli(["--version"], env)).out, /^\d+\.\d+\.\d+\n$/);
  assert.equal(fake.requests.length, 0);
});

test("exit 3 when not signed in, with the way out", async () => {
  const r = await cli(["whoami"], freshEnv());
  assert.equal(r.code, EXIT.auth);
  assert.match(r.err, /Not signed in.*memtro login/);
});

test("exit 3 when Memtro refuses the key", async () => {
  const r = await cli(["search", "anything"], freshEnv({ MEMTRO_API_KEY: "sk-memtro-revokedrevokedrevoked" }));
  assert.equal(r.code, EXIT.auth);
  assert.match(r.err, /revoked or has expired.*memtro login/);
  assert.doesNotMatch(r.err, /revokedrevoked/, "the key is never echoed");
});

test("exit 4 when Memtro cannot be reached", async () => {
  const r = await cli(["search", "anything"], freshEnv({ MEMTRO_API_KEY: fake.mintKey(), MEMTRO_BASE_URL: "http://127.0.0.1:9" }));
  assert.equal(r.code, EXIT.unavailable);
  assert.match(r.err, /Could not reach Memtro/);
});

test("login → whoami → token → logout, end to end against the fake platform", async () => {
  const env = freshEnv();
  const signed = await signIn(env);
  assert.equal(signed.code, 0, signed.err);
  const authorize = new URL(signed.opened);
  assert.equal(authorize.pathname, "/cli/authorize");
  assert.equal(authorize.searchParams.get("device"), "test-host");
  assert.match(authorize.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.match(signed.out, /Signed in as Ada Lovelace <ada@example.com> in Analytical Engines; this key expires on .* \(in 90 days\)/);
  assert.ok(signed.err.includes(signed.opened), "the URL is always printed as well as opened");
  assert.doesNotMatch(signed.out + signed.err, /sk-memtro-/);

  const creds = readFileSync(join(env.MEMTRO_CONFIG_DIR!, "credentials.json"), "utf8");
  const config = readFileSync(join(env.MEMTRO_CONFIG_DIR!, "config.json"), "utf8");
  assert.match(creds, /sk-memtro-/);
  assert.doesNotMatch(config, /sk-memtro-/, "the config file never holds the key");

  const who = await cli(["whoami", "--json"], env);
  assert.equal(who.code, 0, who.err);
  const doc = JSON.parse(who.out);
  assert.equal(doc.organisation.name, "Analytical Engines");
  assert.equal(doc.key_source, "file");
  assert.match(fake.requests.at(-1)!.headers["user-agent"]!, /^memtro-cli\/\d+\.\d+\.\d+ \(\w+; node [\d.]+\)$/);

  assert.equal((await cli(["token"], env, { stdoutTTY: true })).code, EXIT.usage, "no key to a terminal");
  const piped = await cli(["token"], env);
  assert.match(piped.out, /^sk-memtro-[A-Za-z0-9_-]+\n$/);
  const key = piped.out.trim();

  const out = await cli(["logout"], env);
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /Revoked the key on Memtro\.\nRemoved it from/);
  assert.equal(fake.keys.get(key)!.revoked, true);
  assert.equal((await cli(["whoami"], env)).code, EXIT.auth);
  assert.match((await cli(["logout"], env)).out, /Not signed in/);
});

test("login again revokes the key it replaces", async () => {
  const env = freshEnv();
  await signIn(env);
  const first = (await cli(["token"], env)).out.trim();
  const again = await signIn(env);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /held before has been revoked/);
  assert.equal(fake.keys.get(first)!.revoked, true);
});

test("login: cancelled in the browser is exit 1 and stores nothing", async () => {
  const env = freshEnv();
  fake.mode = "deny";
  try {
    await assert.rejects(signIn(env), (e: CliError) => e.exitCode === EXIT.failure && /cancelled in the browser/.test(e.message));
  } finally {
    fake.mode = "approve";
  }
  assert.equal((await cli(["whoami"], env)).code, EXIT.auth);
});

test("logout when Memtro is unreachable: removed here, said plainly, exit 4", async () => {
  // The profile's own host is used for logout; make it unreachable by pointing the profile elsewhere.
  const env2 = freshEnv();
  await signIn(env2);
  const cfgPath = join(env2.MEMTRO_CONFIG_DIR!, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.profiles.default.base_url = "http://127.0.0.1:9";
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const r2 = await cli(["logout"], { ...env2, MEMTRO_BASE_URL: "http://127.0.0.1:9" });
  assert.equal(r2.code, EXIT.unavailable);
  assert.match(r2.out, /Removed it from/);
  assert.match(r2.err, /Could not revoke the key on Memtro.*stays valid until it expires/s);
  assert.equal((await cli(["token"], env2)).code, EXIT.auth);
});

test("a stored key is never sent to a different host", async () => {
  const env = freshEnv();
  await signIn(env);
  const r = await cli(["whoami"], { ...env, MEMTRO_BASE_URL: "https://elsewhere.example" });
  assert.equal(r.code, EXIT.usage);
  assert.match(r.err, /not sending it to https:\/\/elsewhere.example/);

  // A key whose issuer was never recorded (config.json edited or lost) goes nowhere, not wherever --base-url says.
  const cfgPath = join(env.MEMTRO_CONFIG_DIR!, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  delete cfg.profiles.default.base_url;
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const sent = fake.requests.length;
  const r2 = await cli(["whoami", "--base-url", fake.base], env);
  assert.equal(r2.code, EXIT.usage);
  assert.match(r2.err, /no record of which Memtro issued it/);
  assert.equal(fake.requests.length, sent, "nothing was sent");
});

test("ask streams the answer to stdout and sends the project and session", async () => {
  const env = freshEnv({ MEMTRO_API_KEY: fake.mintKey() });
  const r = await cli(["ask", "hello?"], env, { cwd: process.cwd() });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "Hello, wörld\n");
  assert.doesNotMatch(r.out, /thinking/, "reasoning never reaches stdout");
  const sent = fake.requests.at(-1)!.body as { model: string; stream: boolean; memtro: { session: string } };
  assert.equal(sent.model, "auto:chat");
  assert.equal(sent.stream, true);
  assert.match(sent.memtro.session, /^cli-[0-9a-f]{12}$/);

  const agent = await cli(["ask", "--agent", "--json"], env, { stdin: "from a pipe" });
  assert.equal(agent.code, 0, agent.err);
  const doc = JSON.parse(agent.out);
  assert.equal(doc.content, "Hello, wörld");
  assert.equal(doc.finish_reason, "stop");
  assert.deepEqual(doc.memtro, { sources: 2 });
  assert.equal((fake.requests.at(-1)!.body as { model: string }).model, "auto:agent");
  assert.equal((fake.requests.at(-1)!.body as { messages: { content: string }[] }).messages[0]!.content, "from a pipe");
});

test("ask: an error mid-stream is exit 1; a stream that just stops is exit 4", async () => {
  const env = freshEnv({ MEMTRO_API_KEY: fake.mintKey() });
  const failed = await cli(["ask", "please fail"], env);
  assert.equal(failed.code, EXIT.failure);
  assert.match(failed.err, /provider fell over/);
  const cut = await cli(["ask", "cut it"], env);
  assert.equal(cut.code, EXIT.unavailable);
  assert.match(cut.err, /cut off/);
  assert.equal((await cli(["ask"], env)).code, EXIT.usage);
});

test("search: found, nothing found, and --json", async () => {
  const env = freshEnv({ MEMTRO_API_KEY: fake.mintKey() });
  const found = await cli(["search", "retry", "logic", "--limit", "3"], env);
  assert.equal(found.code, 0);
  assert.match(found.out, /• Remembered about retry logic/);
  assert.equal(new URL(`http://x${fake.requests.at(-1)!.path}`).pathname, "/v1/memory");
  const none = await cli(["search", "nothing"], env);
  assert.equal(none.code, 0);
  assert.equal(none.out, "");
  assert.match(none.err, /Nothing in memory matches "nothing"/);
  const json = JSON.parse((await cli(["search", "x1", "--json"], env)).out);
  assert.equal(json.object, "list");
  assert.equal((await cli(["search", "x"], env)).code, EXIT.usage);
});

test("remember, tools and call go through /api/mcp", async () => {
  const env = freshEnv({ MEMTRO_API_KEY: fake.mintKey() });
  const saved = await cli(["remember", "Ada", "prefers", "tea", "--personal"], env);
  assert.equal(saved.code, 0, saved.err);
  assert.match(saved.out, /Saved \(personal\)\. m9/);
  const rpc = fake.requests.at(-1)!;
  assert.equal(rpc.path, "/api/mcp");
  assert.match(String(rpc.headers.accept), /application\/json.*text\/event-stream/);
  assert.deepEqual((rpc.body as { params: unknown }).params, { name: "memtro_remember", arguments: { content: "Ada prefers tea", scope: "personal" } });

  const list = await cli(["tools"], env);
  assert.match(list.out, /memtro_remember\s+Save durable knowledge\.\n/);
  assert.equal(JSON.parse((await cli(["tools", "--json"], env)).out).tools.length, 2);

  const missing = await cli(["call", "nope_tool", "--arg", "a=1"], env);
  assert.equal(missing.code, EXIT.failure);
  assert.match(missing.err, /not found/);
  const ok = await cli(["call", "memtro_remember", "--input", '{"content":"x"}', "--json"], env);
  assert.equal(JSON.parse(ok.out).data.saved, true);
});
