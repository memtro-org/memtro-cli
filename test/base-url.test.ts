// Plain http only to this computer: every way a base URL arrives (flag, environment, a profile's stored host) and
// every spelling of "loopback" and of "not loopback". Nothing here reaches the network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.js";
import { checkBaseUrl, resolveProfile, type ConfigFile } from "../src/config.js";
import { EXIT, UsageError } from "../src/errors.js";
import { openStore } from "../src/store/index.js";
import { Capture, stdinFrom } from "./fake-platform.js";

const UNENCRYPTED = /plain http to another computer: a sign-in code and key would travel unencrypted\. Use https:\/\//;

test("https anywhere", () => {
  assert.equal(checkBaseUrl("https://platform.memtro.com"), "https://platform.memtro.com");
  assert.equal(checkBaseUrl("https://memtro.example.com:8443/"), "https://memtro.example.com:8443");
  assert.equal(checkBaseUrl("HTTPS://Memtro.Example.COM"), "https://memtro.example.com");
});

test("plain http to loopback, any port, however the parser spells it", () => {
  for (const [raw, want] of [
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["HTTP://LOCALHOST:3000", "http://localhost:3000"],
    ["http://LocalHost", "http://localhost"],
    ["http://[::1]:8080", "http://[::1]:8080"],
    ["http://[0:0:0:0:0:0:0:1]", "http://[::1]"],
    ["http://127.1:9", "http://127.0.0.1:9"],
  ]) {
    assert.equal(checkBaseUrl(raw!), want, raw);
  }
});

test("plain http anywhere else is a usage error that says why", () => {
  for (const raw of [
    "http://platform.memtro.com",
    "http://127.0.0.1.evil.example",
    "http://localhost.evil.example:3000",
    "http://localhost.",
    "http://127.0.0.2",
    "http://10.0.0.1",
    "http://0.0.0.0",
    "http://[::ffff:127.0.0.1]",
    "http://[::2]",
    "http://evil.example#@localhost",
    "HTTP://MEMTRO.EXAMPLE",
  ]) {
    assert.throws(() => checkBaseUrl(raw), (e: unknown) => e instanceof UsageError && UNENCRYPTED.test(e.message), raw);
  }
  // Credentials in the URL are refused whatever the host.
  for (const raw of ["http://user@localhost:3000", "http://user:pw@127.0.0.1", "http://localhost@evil.example", "https://user:pw@memtro.example"]) {
    assert.throws(() => checkBaseUrl(raw), UsageError, raw);
  }
});

test("flag, environment and a stored profile host all go through the rule", () => {
  const config: ConfigFile = { version: 1, profiles: { old: { base_url: "http://memtro.example" }, dev: { base_url: "http://localhost:3000" } } };
  assert.throws(() => resolveProfile({ baseUrlFlag: "http://memtro.example", env: {}, config }), UNENCRYPTED);
  assert.throws(() => resolveProfile({ env: { MEMTRO_BASE_URL: "http://memtro.example" }, config }), UNENCRYPTED);
  // A stored plain-http host is refused at use, with the same message, and not rewritten.
  assert.throws(() => resolveProfile({ profileFlag: "old", env: {}, config }), UNENCRYPTED);
  assert.equal(config.profiles.old!.base_url, "http://memtro.example");
  assert.equal(resolveProfile({ profileFlag: "dev", env: {}, config }).baseUrl, "http://localhost:3000");
});

test("a stored plain-http host is refused by a command, and logout never sends the key there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memtro-baseurl-"));
  try {
    const env: NodeJS.ProcessEnv = { MEMTRO_CONFIG_DIR: dir, MEMTRO_CREDENTIALS: "file", MEMTRO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
    const config = { version: 1, profiles: { default: { base_url: "http://memtro.example", store: "file" } } };
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    await openStore("file", dir, env).set("default", "sk-memtro-stored-key-0123456789");
    const cli = async (argv: string[], extra: NodeJS.ProcessEnv = {}) => {
      const stdout = new Capture(false);
      const stderr = new Capture(false);
      const code = await run({ argv, env: { ...env, ...extra }, stdout, stderr, stdin: stdinFrom(null), cwd: tmpdir() });
      return { code, err: stderr.text };
    };
    const who = await cli(["whoami"]);
    assert.equal(who.code, EXIT.usage);
    assert.match(who.err, UNENCRYPTED);
    // With a safe host for this run, logout still refuses the stored one rather than revoke over plain http.
    const out = await cli(["logout"], { MEMTRO_BASE_URL: "http://127.0.0.1:9" });
    assert.equal(out.code, EXIT.usage, out.err);
    assert.match(out.err, UNENCRYPTED);
    assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).profiles.default.base_url, "http://memtro.example", "not rewritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
