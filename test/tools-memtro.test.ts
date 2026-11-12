import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { Tool, ToolContext } from "../src/agent/types.js";
import { ApiClient } from "../src/api/client.js";
import { surfaceQuery } from "../src/api/mcp.js";
import { AuthError, UnavailableError } from "../src/errors.js";
import { loadMemtroTools } from "../src/tools/memtro.js";

/**
 * A tiny stand-in for `/api/mcp`: stateless JSON-RPC over POST, shaped like brain src/app/api/mcp/route.ts —
 * folded system tools with `{operation, input}`, `ACTION:` descriptions, no annotations, blocked actions as
 * `isError` text.
 */

interface Seen {
  query: URLSearchParams;
  method: string;
  params: Record<string, unknown>;
  auth: string | undefined;
}

const githubGroup = (withActions: boolean) => ({
  name: "github",
  description: [
    "github. Run one operation on this connected system.",
    "- list_issues: List issues in a repository.",
    ...(withActions ? ["- create_issue: ACTION: Create an issue in a repository."] : []),
    '- describe: the parameters an operation takes. Call this first when unsure, with input {"operation":"<name>"}.',
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["describe", "list_issues", ...(withActions ? ["create_issue"] : [])] },
      input: { type: "object" },
    },
    required: ["operation"],
  },
});

const searchTool = { name: "memtro_search", description: "Search the organisation's memory.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } };
const collidingTool = { name: "read", description: "A remote tool that must never shadow the local read.", inputSchema: { type: "object", properties: {} } };

let server: Server;
let base: string;
const seen: Seen[] = [];
let status = 200;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => resolve(text));
  });
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const msg = JSON.parse(await body(req)) as { id: string; method: string; params: Record<string, unknown> };
    seen.push({ query: url.searchParams, method: msg.method, params: msg.params, auth: req.headers.authorization });
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "nope" } }));
      return;
    }
    const actions = url.searchParams.get("actions") !== "none";
    let result: unknown;
    if (msg.method === "tools/list") {
      result = {
        tools: [
          searchTool,
          githubGroup(actions),
          collidingTool,
          ...(actions ? [{ name: "memtro_remember", description: "Remember a fact.", inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } }, { name: "hubspot_create_note", description: "ACTION: Create a note on a contact.", inputSchema: { type: "object", properties: {} } }] : []),
        ],
      };
    } else if (msg.method === "tools/call") {
      const name = msg.params.name as string;
      const args = msg.params.arguments as Record<string, unknown>;
      if (name === "github" && args.operation === "create_issue") result = { content: [{ type: "text", text: JSON.stringify({ error: "This action needs approval in Memtro.", blocked: true }) }], isError: true };
      else if (name === "memtro_search" && args.query === "big") result = { content: [{ type: "text", text: Array.from({ length: 10_000 }, (_, i) => `result line ${i} ${"x".repeat(40)}`).join("\n") }], isError: false };
      else result = { content: [{ type: "text", text: `ran ${name} ${JSON.stringify(args)}` }, { type: "image", data: "…" }], isError: false };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const client = (url = base) => new ApiClient({ baseUrl: url, key: "sk-memtro-testtesttesttest", profile: "default", userAgent: "test" });
const ctx = (signal = new AbortController().signal): ToolContext => ({ cwd: "/", workspaceRoot: "/", signal });
const where = { cwd: "/", workspaceRoot: "/" };
const byName = (tools: Tool[]) => new Map(tools.map((t) => [t.spec.name, t]));

test("without actions: listed read-only on the system shape, every call a remote read, local names never shadowed", async () => {
  seen.length = 0;
  const tools = byName(await loadMemtroTools(client(), { actions: false }));
  assert.equal(seen[0]!.method, "tools/list");
  assert.equal(seen[0]!.query.get("shape"), "system");
  assert.equal(seen[0]!.query.get("actions"), "none");
  assert.deepEqual([...tools.keys()], ["memtro_search", "github"]);
  assert.equal(tools.get("github")!.risk({ operation: "list_issues" }, where), "remote-read");
  assert.equal(tools.get("memtro_search")!.risk({ query: "q" }, where), "remote-read");
  assert.equal((await tools.get("memtro_search")!.summarise({ query: "release notes" }, where)).title, 'Search memory: "release notes"');
  assert.equal((await tools.get("github")!.summarise({ operation: "list_issues", input: { query: "bug" } }, where)).title, 'Ask Github: list_issues "bug"');
  assert.equal((await tools.get("github")!.summarise({ operation: "describe", input: { operation: "list_issues" } }, where)).title, "Ask Github: describe list_issues");
  assert.equal(tools.get("github")!.spec.parameters.type, "object");

  seen.length = 0;
  const r = await tools.get("memtro_search")!.run({ query: "q" }, ctx());
  assert.equal(r.isError, undefined);
  assert.match(r.content, /^ran memtro_search \{"query":"q"\}\n\[1 non-text part of the result not shown\.\]$/);
  assert.equal(seen[0]!.method, "tools/call");
  assert.equal(seen[0]!.query.get("actions"), "none", "called on the surface it was listed from");
  assert.equal(seen[0]!.query.get("shape"), "system");
});

test("with actions: an ACTION: operation, an ACTION: tool and Memtro's writes are remote-act; reads stay remote-read", async () => {
  seen.length = 0;
  const tools = byName(await loadMemtroTools(client(), { actions: true }));
  assert.equal(seen[0]!.query.get("actions"), null);
  assert.equal(seen[0]!.query.get("shape"), "system");
  const gh = tools.get("github")!;
  assert.equal(gh.risk({ operation: "create_issue", input: {} }, where), "remote-act");
  assert.equal(gh.risk({ operation: "github_create_issue" }, where), "remote-act");
  assert.equal(gh.risk({ operation: "list_issues" }, where), "remote-read");
  assert.equal(gh.risk({ operation: "describe", input: { operation: "create_issue" } }, where), "remote-read");
  assert.equal(gh.risk({ operation: "not_listed" }, where), "remote-act", "an operation that cannot be shown to be a read");
  assert.equal(tools.get("memtro_remember")!.risk({ content: "x" }, where), "remote-act");
  assert.equal(tools.get("hubspot_create_note")!.risk({}, where), "remote-act");
  assert.equal(tools.get("memtro_search")!.risk({ query: "x" }, where), "remote-read");
  assert.equal((await tools.get("hubspot_create_note")!.summarise({}, where)).title, "Ask Hubspot: create note");
  assert.equal((await tools.get("memtro_remember")!.summarise({ content: "We ship on Tuesdays" }, where)).title, 'Save to memory: "We ship on Tuesdays"');
});

test("a blocked action comes back as an error result for the model", async () => {
  const gh = byName(await loadMemtroTools(client(), { actions: true })).get("github")!;
  const r = await gh.run({ operation: "create_issue", input: { title: "t" } }, ctx());
  assert.equal(r.isError, true);
  assert.match(r.content, /needs approval in Memtro/);
});

test("an oversized result is cut to 50 KB with a closing line", async () => {
  const search = byName(await loadMemtroTools(client(), { actions: false })).get("memtro_search")!;
  const r = await search.run({ query: "big" }, ctx());
  assert.ok(Buffer.byteLength(r.content) < 51 * 1024);
  assert.match(r.content, /\n\[Output cut: \d+ more lines \([\d.]+ KB\) not shown\. Ask for less: a narrower query, a filter, or a smaller limit\.\]$/);
});

test("arguments are checked against the tool's schema before Memtro is asked", async () => {
  const tools = byName(await loadMemtroTools(client(), { actions: false }));
  const search = tools.get("memtro_search")!;
  assert.deepEqual(search.validate({}), { ok: false, error: '"query" is required.' });
  assert.deepEqual(search.validate({ query: 3 }), { ok: false, error: '"query" must be string, not the number 3.' });
  assert.deepEqual(search.validate({ query: "x", limit: 1.5 }), { ok: false, error: '"limit" must be integer, not the number 1.5.' });
  assert.equal(search.validate({ query: "x", extra: true }).ok, true, "unknown fields are ignored");
  assert.equal(search.validate([]).ok, false);
  assert.match((tools.get("github")!.validate({ operation: "create_issue" }) as { error: string }).error, /must be one of/);
});

test("an interrupted call says nothing ran", async () => {
  const search = byName(await loadMemtroTools(client(), { actions: false })).get("memtro_search")!;
  const r = await search.run({ query: "q" }, ctx(AbortSignal.abort()));
  assert.equal(r.isError, true);
  assert.match(r.content, /Interrupted before Memtro was asked/);
});

test("loading rejects with the client's own errors: refused key, unreachable", async () => {
  status = 401;
  try {
    await assert.rejects(loadMemtroTools(client(), { actions: false }), AuthError);
  } finally {
    status = 200;
  }
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const port = (dead.address() as AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));
  await assert.rejects(loadMemtroTools(client(`http://127.0.0.1:${port}`), { actions: false }), UnavailableError);
});

test("a call that cannot reach Memtro is an error result, not a throw", async () => {
  const search = byName(await loadMemtroTools(client(), { actions: false })).get("memtro_search")!;
  status = 503;
  try {
    const r = await search.run({ query: "q" }, ctx());
    assert.equal(r.isError, true);
    assert.match(r.content, /unavailable/);
  } finally {
    status = 200;
  }
});

test("surfaceQuery keeps the old spellings and adds the new options", () => {
  assert.equal(surfaceQuery("all"), undefined);
  assert.deepEqual(surfaceQuery("memory"), { tools: "memory" });
  assert.deepEqual(surfaceQuery({ shape: "system", actions: false }), { actions: "none", shape: "system" });
  assert.deepEqual(surfaceQuery({ actions: true, connectors: ["github", "xero"] }), { connectors: "github,xero" });
});
