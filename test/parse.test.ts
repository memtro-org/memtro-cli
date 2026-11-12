import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { serverMessage } from "../src/api/client.js";
import { parseArgPairs, parseInputJson, parseRpcBody } from "../src/api/mcp.js";
import { SseParser } from "../src/api/sse.js";
import { intFlag, parseCommandLine } from "../src/args.js";
import { chatBody, composeQuestion } from "../src/commands/ask.js";
import { checkBaseUrl, configDir, resolveProfile } from "../src/config.js";
import { UsageError } from "../src/errors.js";
import { ownerRepo } from "../src/git.js";
import { colourAllowed, expiryPhrase } from "../src/output.js";
import { userAgent, VERSION } from "../src/version.js";

test("arguments: global options either side of the command", () => {
  const g = parseCommandLine(["--profile", "work", "search", "the", "retry", "--limit", "5"]);
  assert.equal(g.command, "search");
  assert.deepEqual({ ...g.flags }, { profile: "work", limit: "5" });
  assert.deepEqual(g.positionals, ["the", "retry"]);
  const p = parseCommandLine(["ask", "--agent", "why?", "--json"]);
  assert.equal(p.command, "ask");
  assert.equal(p.flags.agent, true);
  assert.equal(p.flags.json, true);
  assert.deepEqual(p.positionals, ["why?"]);
  assert.deepEqual(parseCommandLine(["call", "x", "--arg", "a=1", "--arg", "b:=2"]).flags.arg, ["a=1", "b:=2"]);
  assert.equal(parseCommandLine(["--version"]).flags.version, true);
  assert.equal(parseCommandLine([]).command, null);
});

test("arguments: mistakes are usage errors", () => {
  assert.throws(() => parseCommandLine(["serach", "x"]), UsageError);
  assert.throws(() => parseCommandLine(["search", "--lmit", "5", "x"]), /Unknown option/);
  assert.throws(() => parseCommandLine(["whoami", "extra"]), UsageError);
  assert.throws(() => parseCommandLine(["call"]), UsageError);
  assert.throws(() => parseCommandLine(["call", "a", "b"]), UsageError);
  assert.throws(() => intFlag("0", "limit", 1, 100), UsageError);
  assert.throws(() => intFlag("5x", "limit", 1, 100), UsageError);
  assert.equal(intFlag("100", "limit", 1, 100), 100);
});

test("--arg: key=value is a string, key:=json is JSON", () => {
  assert.deepEqual(parseArgPairs(["id=123", "limit:=5", "flags:=[1,2]", "q=a=b"]), { id: "123", limit: 5, flags: [1, 2], q: "a=b" });
  assert.throws(() => parseArgPairs(["novalue"]), UsageError);
  assert.throws(() => parseArgPairs(["x:={bad"]), UsageError);
  assert.throws(() => parseArgPairs(["=x"]), UsageError);
  assert.deepEqual(parseInputJson('{"a":1}'), { a: 1 });
  assert.throws(() => parseInputJson("[1]"), UsageError);
});

test("SSE: events reassembled from arbitrary chunk boundaries", () => {
  const stream = 'data: {"a":1}\n\n: comment\n\nevent: x\ndata: line1\ndata: line2\n\ndata: ü\r\n\r\ndata: [DONE]\n\n';
  const bytes = Buffer.from(stream, "utf8");
  for (const size of [1, 2, 3, 7, 1000]) {
    const p = new SseParser();
    const events = [];
    for (let i = 0; i < bytes.length; i += size) events.push(...p.push(bytes.subarray(i, i + size)));
    assert.deepEqual(events, [
      { event: "message", data: '{"a":1}' },
      { event: "x", data: "line1\nline2" },
      { event: "message", data: "ü" },
      { event: "message", data: "[DONE]" },
    ], `chunk size ${size}`);
  }
});

test("SSE: an event with no terminating blank line is not emitted", () => {
  const p = new SseParser();
  assert.deepEqual(p.push("data: half"), []);
  assert.deepEqual(p.end(), []);
});

test("MCP: the reply for our id, from JSON or SSE", () => {
  assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":"a","result":{"x":1}}', "application/json", "a")?.result, { x: 1 });
  assert.equal(parseRpcBody('{"jsonrpc":"2.0","id":"b","result":{}}', "application/json", "a"), null);
  assert.deepEqual(parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":"a","result":{"y":2}}\n\n', "text/event-stream", "a")?.result, { y: 2 });
  assert.equal(parseRpcBody('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Not Acceptable"}}', "application/json", "a")?.error?.message, "Not Acceptable");
  assert.equal(parseRpcBody("<html>", "text/html", "a"), null);
});

test("ask: question composition and the body pi-memtro's way", () => {
  assert.equal(composeQuestion("review this", "diff --git"), "review this\n\ndiff --git");
  assert.equal(composeQuestion("", "from stdin\n"), "from stdin");
  assert.equal(composeQuestion("  ", null), "");
  assert.deepEqual(chatBody("q", { agent: false, project: "acme/api", session: "cli-1" }), {
    model: "auto:chat",
    messages: [{ role: "user", content: "q" }],
    memtro: { session: "cli-1", project: "acme/api" },
  });
  assert.equal(chatBody("q", { agent: true, project: null, session: "s" }).model, "auto:agent");
  assert.deepEqual(chatBody("q", { agent: false, project: null, session: "s" }).memtro, { session: "s" });
  assert.equal(chatBody("q", { model: "openai/gpt-5:chat", agent: false, project: null, session: "s" }).model, "openai/gpt-5:chat");
});

test("git remotes to owner/name", () => {
  assert.equal(ownerRepo("git@github.com:memtro-org/pi-memtro.git"), "memtro-org/pi-memtro");
  assert.equal(ownerRepo("https://github.com/memtro-org/memtro-cli"), "memtro-org/memtro-cli");
  assert.equal(ownerRepo("ssh://git@gitlab.example.com/group/sub/repo.git"), "sub/repo");
  assert.equal(ownerRepo("nonsense"), null);
});

test("profile and base URL precedence: flag, env, profile, default", () => {
  const config = { version: 1 as const, profiles: { work: { base_url: "https://memtro.work.example" } } };
  assert.deepEqual(resolveProfile({ env: {}, config }), { profile: "default", baseUrl: "https://platform.memtro.com", baseUrlFrom: "default" });
  assert.equal(resolveProfile({ env: { MEMTRO_PROFILE: "work" }, config }).baseUrl, "https://memtro.work.example");
  assert.equal(resolveProfile({ env: { MEMTRO_PROFILE: "work", MEMTRO_BASE_URL: "http://localhost:3000/" }, config }).baseUrl, "http://localhost:3000");
  assert.equal(resolveProfile({ profileFlag: "work", baseUrlFlag: "https://x.example", env: { MEMTRO_BASE_URL: "https://y.example" }, config }).baseUrlFrom, "flag");
  assert.throws(() => resolveProfile({ profileFlag: "Work!", env: {}, config }), UsageError);
  assert.throws(() => checkBaseUrl("ftp://x"), UsageError);
  assert.throws(() => checkBaseUrl("https://user:pw@x.example"), UsageError);
  assert.equal(checkBaseUrl("https://memtro.example.com/memtro/"), "https://memtro.example.com/memtro");
});

test("config directory per platform", () => {
  assert.equal(configDir({}, "linux", "/home/a"), "/home/a/.config/memtro");
  assert.equal(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/a"), "/x/memtro");
  assert.match(configDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32", "C:\\Users\\a"), /AppData.Roaming.memtro$/);
  assert.equal(configDir({ MEMTRO_CONFIG_DIR: "/tmp/m" }, "linux", "/home/a"), "/tmp/m");
});

test("colour: only on a terminal, never with NO_COLOR or TERM=dumb", () => {
  assert.equal(colourAllowed({ isTTY: true }, {}), true);
  assert.equal(colourAllowed({ isTTY: false }, {}), false);
  assert.equal(colourAllowed({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(colourAllowed({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(colourAllowed({ isTTY: true }, {}, true), false);
});

test("server error messages from every shape Memtro uses", () => {
  assert.equal(serverMessage('{"error":{"message":"nope","type":"x"}}'), "nope");
  assert.equal(serverMessage('{"jsonrpc":"2.0","error":{"code":-32001,"message":"bad key"},"id":null}'), "bad key");
  assert.equal(serverMessage('{"error":"invalid_grant","error_description":"expired"}'), "expired");
  assert.equal(serverMessage("<html>502</html>"), null);
});

test("version and User-Agent", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.equal(userAgent("darwin", "24.15.0"), `memtro-cli/${VERSION} (darwin; node 24.15.0)`);
});

test("expiry phrasing", () => {
  const now = new Date("2026-11-12T00:00:00Z");
  assert.equal(expiryPhrase(null, now), "never expires");
  assert.equal(expiryPhrase("2027-02-10T00:00:00Z", now), "expires 10 Feb 2027 (in 90 days)");
  assert.equal(expiryPhrase("2026-01-01T00:00:00Z", now), "expired 1 Jan 2026");
});
