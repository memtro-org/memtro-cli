import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ApiClient } from "../src/api/client.js";
import { cheapestKnownModel, contextLimitFrom, explicitModelsUsable, listModels, parseModels, type ModelInfo } from "../src/api/models.js";
import { startFakePlatform, type FakePlatform } from "./fake-platform.js";

let fake: FakePlatform;
let client: ApiClient;
before(async () => {
  fake = await startFakePlatform();
  client = new ApiClient({ baseUrl: fake.base, key: fake.mintKey(), profile: "default", userAgent: "memtro-cli/test" });
});
after(() => fake.close());

const row = (id: string, limit?: { context: number; output: number }) => ({ id, object: "model", created: 0, owned_by: "memtro", ...(limit ? { limit } : {}), type: "model", display_name: id });

test("listModels: limits read, missing limits are null", async () => {
  fake.models = [row("memtro", { context: 200_000, output: 64_000 }), row("auto"), row("anthropic/claude-haiku-4-5-20251001", { context: 200_000, output: 64_000 })];
  const models = await listModels(client);
  assert.deepEqual(models, [
    { id: "memtro", context: 200_000, output: 64_000 },
    { id: "auto", context: null, output: null },
    { id: "anthropic/claude-haiku-4-5-20251001", context: 200_000, output: 64_000 },
  ]);
  assert.equal(fake.requests.at(-1)!.path, "/v1/models");
});

test("parseModels: junk rows skipped", () => {
  assert.deepEqual(parseModels({ data: [{ id: 3 }, null, { id: "x", limit: { context: -1, output: "9" } }] }), [{ id: "x", context: null, output: null }]);
  assert.deepEqual(parseModels(null), []);
});

const m = (id: string, context: number | null = null): ModelInfo => ({ id, context, output: null });

test("explicitModelsUsable: only auto*/memtro listed is the routing lock", () => {
  assert.equal(explicitModelsUsable([m("memtro"), m("auto"), m("auto/anthropic"), m("auto/openai")]), false);
  assert.equal(explicitModelsUsable([]), false);
  assert.equal(explicitModelsUsable([m("memtro"), m("openai/gpt-5.4")]), true);
});

test("cheapestKnownModel: the cheapest rung recognised, null under the lock or when none is known", () => {
  assert.equal(cheapestKnownModel([m("memtro"), m("auto")]), null);
  assert.equal(cheapestKnownModel([m("memtro"), m("anthropic/claude-sonnet-5"), m("anthropic/claude-opus-5")]), null);
  assert.equal(cheapestKnownModel([m("openai/gpt-5.4-mini"), m("openai/gpt-5.4-nano"), m("openai/gpt-5.5")]), "openai/gpt-5.4-nano");
  assert.equal(cheapestKnownModel([m("openai/gpt-5.4-nano"), m("anthropic/claude-haiku-4-5-20251001")]), "anthropic/claude-haiku-4-5-20251001");
  assert.equal(cheapestKnownModel([m("anthropic/claude-haiku-4-5-20251001"), m("anthropic/claude-haiku-5-0")]), "anthropic/claude-haiku-5-0");
  assert.equal(cheapestKnownModel([m("google/gemini-3.8-flash"), m("google/gemini-3.5-flash-lite")]), "google/gemini-3.5-flash-lite");
});

test("contextLimitFrom: suffix ignored, unknown is null", () => {
  const limit = contextLimitFrom([m("auto", 200_000), m("memtro")]);
  assert.equal(limit("auto:chat"), 200_000);
  assert.equal(limit("auto"), 200_000);
  assert.equal(limit("memtro:chat"), null);
  assert.equal(limit("openai/x"), null);
});
