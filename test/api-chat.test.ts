import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chatModelId, forcedArguments, forcedCallVia, streamTurn, wireMessage, type TurnChunk } from "../src/api/chat.js";
import { ApiClient, PlatformError, retryAfter } from "../src/api/client.js";
import { CliError, UnavailableError } from "../src/errors.js";
import { startFakePlatform, textReply, type FakePlatform } from "./fake-platform.js";

let fake: FakePlatform;
let client: ApiClient;
before(async () => {
  fake = await startFakePlatform();
  client = new ApiClient({ baseUrl: fake.base, key: fake.mintKey(), profile: "default", userAgent: "memtro-cli/test" });
});
after(() => fake.close());
beforeEach(() => {
  fake.chatScript.length = 0;
});

const turn = (over: Partial<Parameters<typeof streamTurn>[1]> = {}) => ({
  model: "auto",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  memtro: { tools: false, session: "cli-abc" },
  signal: new AbortController().signal,
  ...over,
});

async function collect(gen: AsyncGenerator<TurnChunk>): Promise<TurnChunk[]> {
  const out: TurnChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

test("chatModelId: always one :chat, never :agent, never doubled", () => {
  assert.equal(chatModelId("auto"), "auto:chat");
  assert.equal(chatModelId("auto:chat"), "auto:chat");
  assert.equal(chatModelId("auto:agent"), "auto:chat");
  assert.equal(chatModelId("openrouter/x:free"), "openrouter/x:free:chat");
  assert.equal(chatModelId(""), "memtro:chat");
});

test("wireMessage: tool calls go out in OpenAI's spelling, content null kept", () => {
  assert.deepEqual(wireMessage({ role: "assistant", content: null, tool_calls: [{ id: "c1", name: "read", arguments: '{"path":"a"}' }] }), {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
  });
});

test("streamTurn: the request body, and text, thinking, routing, usage, calls and finish in order", async () => {
  fake.chatScript.push({
    stream: [
      { routing: { model: "anthropic/claude-sonnet-5", detail: { requested: "auto", model: "anthropic/claude-sonnet-5", complexity: 3 } } },
      { thinking: "hmm" },
      { text: "Looking." },
      { toolCall: { id: "c1", name: "read", arguments: '{"path":"a.ts"}' } },
      { toolCall: { id: "c2", name: "grep", arguments: '{"pattern":"x"}' } },
      { finish: "tool_calls" },
      { usage: { input: 1200, output: 40, cached: 1000 } },
    ],
  });
  const chunks = await collect(streamTurn(client, turn({ maxTokens: 4000 })));
  assert.deepEqual(chunks, [
    { type: "routing", model: "anthropic/claude-sonnet-5", detail: { requested: "auto", model: "anthropic/claude-sonnet-5", complexity: 3 } },
    { type: "thinking", delta: "hmm" },
    { type: "text", delta: "Looking." },
    { type: "usage", usage: { input: 1200, output: 40, cached: 1000 } },
    { type: "tool-call", call: { id: "c1", name: "read", arguments: '{"path":"a.ts"}' } },
    { type: "tool-call", call: { id: "c2", name: "grep", arguments: '{"pattern":"x"}' } },
    { type: "finish", reason: "tool_calls", model: "anthropic/claude-sonnet-5" },
  ]);
  const body = fake.requests.at(-1)!.body as Record<string, unknown>;
  assert.equal(body.model, "auto:chat");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_completion_tokens, 4000);
  assert.equal("reasoning_effort" in body, false, "never sent (facts B)");
  assert.deepEqual(body.memtro, { tools: false, session: "cli-abc" });
  assert.deepEqual(body.tools, [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }]);
});

test("streamTurn: a fallback that answered is reported, and named in finish", async () => {
  fake.chatScript.push({ stream: [{ text: "ok" }, { answeredBy: "openai/gpt-5.4" }, { finish: "stop" }] });
  const chunks = await collect(streamTurn(client, turn()));
  assert.deepEqual(chunks.find((c) => c.type === "routing"), { type: "routing", model: "openai/gpt-5.4", detail: { answered_by: "openai/gpt-5.4" } });
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: "stop", model: "openai/gpt-5.4" });
});

test("streamTurn: no tools means no tools key", async () => {
  fake.chatScript.push(textReply("x"));
  await collect(streamTurn(client, turn({ tools: [] })));
  assert.equal("tools" in (fake.requests.at(-1)!.body as object), false);
});

test("streamTurn: an error chunk part-way through is an error, not an answer", async () => {
  fake.chatScript.push({ stream: [{ text: "partial" }, { error: "provider fell over" }] });
  const got: TurnChunk[] = [];
  await assert.rejects(
    async () => {
      for await (const c of streamTurn(client, turn())) got.push(c);
    },
    (err: unknown) => err instanceof CliError && !(err instanceof UnavailableError) && /provider fell over/.test(err.message),
  );
  assert.equal(got.some((c) => c.type === "finish"), false);
});

test("streamTurn: a stream cut off with no finish and no [DONE] is an error, and its calls are never yielded", async () => {
  fake.chatScript.push({ stream: [{ text: "half" }, { toolCall: { id: "c1", name: "read", arguments: "{}" } }], cut: true });
  const got: TurnChunk[] = [];
  await assert.rejects(
    async () => {
      for await (const c of streamTurn(client, turn())) got.push(c);
    },
    (err: unknown) => err instanceof UnavailableError && /cut off/.test(err.message),
  );
  assert.equal(got.some((c) => c.type === "tool-call" || c.type === "finish"), false);
});

test("streamTurn: aborting part-way throws an AbortError", async () => {
  fake.chatScript.push({ stream: [{ text: "start" }, { hang: true }] });
  const ac = new AbortController();
  await assert.rejects(
    async () => {
      for await (const c of streamTurn(client, turn({ signal: ac.signal }))) if (c.type === "text") ac.abort();
    },
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
});

test("errors: 402, quota 429, plain 429, provider_not_configured, 500 each say what to do", async () => {
  const cases: [number, unknown, Record<string, string> | undefined, RegExp, boolean, string | null][] = [
    [402, { error: { message: "Subscription inactive", type: "invalid_request_error", code: "subscription_inactive" } }, undefined, /subscription is not active.*administrator/, false, "subscription_inactive"],
    [429, { error: { message: "This month's allowance is used up", type: "insufficient_quota", code: "allowance_exhausted" } }, undefined, /allowance.*administrator/, false, "allowance_exhausted"],
    [429, "<html><body>429 Too Many Requests</body></html>", { "Retry-After": "2" }, /limiting how fast.*Wait/, true, null],
    [400, { error: { message: "No Anthropic API key configured.", type: "invalid_request_error", code: "provider_not_configured" } }, undefined, /no provider key.*Pick another model/, false, "provider_not_configured"],
    [500, { error: { message: "boom", type: "server_error", code: "upstream_error" } }, undefined, /failed to answer \(HTTP 500\): boom/, true, "upstream_error"],
  ];
  for (const [status, body, headers, message, retry, code] of cases) {
    fake.chatScript.push({ status, body, headers });
    await assert.rejects(collect(streamTurn(client, turn())), (err: unknown) => {
      assert.ok(err instanceof PlatformError, `${status} is a PlatformError`);
      assert.match(err.message, message);
      assert.equal(err.retryable, retry, `${status} retryable`);
      assert.equal(err.code, code);
      if (status === 429 && retry) assert.equal(err.retryAfterMs, 2000);
      return true;
    });
  }
});

test("retryAfter: seconds or a date", () => {
  assert.equal(retryAfter("3"), 3000);
  assert.equal(retryAfter(null), null);
  assert.equal(retryAfter(new Date(10_000).toUTCString(), 4000), 6000);
  assert.equal(retryAfter("soon"), null);
});

test("forcedCallVia: the body is bare and forced, and the arguments come back", async () => {
  fake.chatScript.push({ json: { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "verdict", arguments: '{"decision":"allow","reason":"Read-only."}' } }] }, finish_reason: "tool_calls" }] } });
  const call = forcedCallVia(client);
  const tool = { name: "verdict", description: "Judge", parameters: { type: "object" } };
  const args = await call({ model: "anthropic/claude-haiku-4-5", system: "S", user: "U", tool, maxTokens: 200, timeoutMs: 5000, signal: new AbortController().signal });
  assert.deepEqual(args, { decision: "allow", reason: "Read-only." });
  const body = fake.requests.at(-1)!.body as Record<string, unknown>;
  assert.equal(body.model, "anthropic/claude-haiku-4-5:chat");
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 200);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "verdict" } });
  assert.deepEqual(body.memtro, { tools: false, retrieve: false, memory: "off" });
  assert.deepEqual(body.messages, [
    { role: "system", content: "S" },
    { role: "user", content: "U" },
  ]);
});

test("forcedCallVia: text instead of the call is null; a refusal rejects", async () => {
  fake.chatScript.push({ json: { choices: [{ message: { role: "assistant", content: "I think it is fine" }, finish_reason: "stop" }] } });
  const call = forcedCallVia(client);
  const req = { model: "m", system: "S", user: "U", tool: { name: "verdict", description: "", parameters: {} }, maxTokens: 50, timeoutMs: 5000, signal: new AbortController().signal };
  assert.equal(await call(req), null);
  fake.chatScript.push({ status: 400, body: { error: { message: "no key", type: "invalid_request_error", code: "provider_not_configured" } } });
  await assert.rejects(call(req));
});

test("forcedArguments: other tools, bad JSON and arrays are null", () => {
  const body = (name: string, args: string) => ({ choices: [{ message: { tool_calls: [{ function: { name, arguments: args } }] } }] });
  assert.equal(forcedArguments(body("other", "{}"), "verdict"), null);
  assert.equal(forcedArguments(body("verdict", "{nope"), "verdict"), null);
  assert.equal(forcedArguments(body("verdict", "[1]"), "verdict"), null);
  assert.equal(forcedArguments(null, "verdict"), null);
});

