import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ApiClient } from "../src/api/client.js";
import { isSummaryMessage } from "../src/agent/compaction.js";
import { createAgent, INTERRUPTED_BEFORE, INTERRUPTED_DURING, type AgentOptions } from "../src/agent/loop.js";
import { openSessionStore } from "../src/agent/session-store.js";
import type { AgentEvent, Answer, Approver, Decision, Gate, GateContext, Message, PendingCall, SessionRule, SessionStore, Tool, ToolContext, ToolResult } from "../src/agent/types.js";
import { callsReply, startFakePlatform, textReply, type FakePlatform } from "./fake-platform.js";

let fake: FakePlatform;
let client: ApiClient;
let home: string;
before(async () => {
  fake = await startFakePlatform();
  client = new ApiClient({ baseUrl: fake.base, key: fake.mintKey(), profile: "default", userAgent: "memtro-cli/test" });
  home = mkdtempSync(join(tmpdir(), "memtro-loop-"));
});
after(async () => {
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  fake.chatScript.length = 0;
});

// ---- stand-ins for the other builders' parts, written against types.ts only ----

function fakeTool(name: string, run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> = async () => ({ content: `${name} ran` })): Tool {
  return {
    spec: { name, description: `The ${name} tool`, parameters: { type: "object", properties: { path: { type: "string" } } } },
    validate: (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) && !("bad" in raw) ? { ok: true, args: raw as Record<string, unknown> } : { ok: false, error: "`bad` is not allowed" }),
    risk: () => (name === "bash" ? "execute" : name === "write" ? "write" : "read"),
    summarise: (args) => ({ title: `${name} ${String(args.path ?? "")}`.trim() }),
    run,
  };
}

interface TestGate extends Gate {
  checks: { call: PendingCall; ctx: GateContext }[];
  remembered: SessionRule[];
}
function fakeGate(decide: (call: PendingCall) => Decision = () => ({ verdict: "allow", reason: "Fine.", source: "rule" })): TestGate {
  const g: TestGate = {
    mode: "auto",
    setMode() {},
    checks: [],
    remembered: [],
    async check(call, ctx) {
      g.checks.push({ call, ctx });
      return decide(call);
    },
    remember(rule) {
      g.remembered.push(rule);
    },
    suggestRule: (call) => ({ kind: "tool", tool: call.tool }),
  };
  return g;
}

function fakeApprover(answers: Answer[] = []): Approver & { asked: PendingCall[] } {
  const a = {
    asked: [] as PendingCall[],
    async ask(call: PendingCall) {
      a.asked.push(call);
      return answers.shift() ?? { kind: "deny" as const };
    },
  };
  return a;
}

let storeSeq = 0;
const freshStore = (): SessionStore => openSessionStore({ env: { XDG_STATE_HOME: join(home, `state-${storeSeq++}`) }, platform: "linux", home });

function agentWith(over: Partial<AgentOptions> = {}) {
  const store = over.store ?? freshStore();
  const agent = createAgent({
    client,
    model: "auto",
    tools: [fakeTool("read"), fakeTool("bash"), fakeTool("write")],
    gate: fakeGate(),
    approver: fakeApprover(),
    store,
    cwd: home,
    workspaceRoot: home,
    project: "acme/widgets",
    contextLimit: () => 10_000,
    now: () => new Date("2026-11-12T10:00:00Z"),
    ...over,
  });
  return { agent, store };
}

async function runTurn(agent: ReturnType<typeof createAgent>, text: string, signal = new AbortController().signal, onEvent?: (e: AgentEvent) => void): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of agent.run(text, signal)) {
    events.push(e);
    onEvent?.(e);
  }
  return events;
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const sent = (n = 1) => fake.requests.filter((r) => r.path === "/v1/chat/completions").at(-n)!.body as { model: string; messages: Message[] & { tool_calls?: unknown }[]; memtro: Record<string, unknown>; tools?: unknown[] };

/** Every assistant tool call is followed, before anything else, by exactly one result for each of its ids. */
function assertWellFormed(messages: readonly Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const ids = m.tool_calls.map((c) => c.id);
    const following = messages.slice(i + 1, i + 1 + ids.length);
    assert.deepEqual(
      following.map((f) => (f.role === "tool" ? f.tool_call_id : `(${f.role})`)),
      ids,
      `results for ${ids.join(",")} follow their call`,
    );
  }
}

test("a full turn: text, an allowed tool call, the result, and the answer; saved in order", async () => {
  const { agent, store } = agentWith();
  fake.chatScript.push(
    {
      stream: [
        { routing: { model: "anthropic/claude-sonnet-5", detail: { requested: "auto" } } },
        { thinking: "Let me look." },
        { text: "Reading it." },
        { toolCall: { id: "c1", name: "read", arguments: '{"path":"a.ts"}' } },
        { finish: "tool_calls" },
        { usage: { input: 1000, output: 20, cached: 800 } },
      ],
    },
    textReply("It exports one function.", { input: 1100, output: 8 }),
  );
  const events = await runTurn(agent, "What does a.ts do?");
  assert.deepEqual(types(events), ["turn-start", "routing", "thinking", "text", "usage", "tool-call", "tool-decision", "tool-result", "text", "usage", "turn-end"]);
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "stop" });
  const usage = events.filter((e) => e.type === "usage");
  assert.deepEqual(usage[1], { type: "usage", step: { input: 1100, output: 8, cached: 0 }, session: { input: 2100, output: 28, cached: 800 }, contextUsed: 1100, contextLimit: 10_000 });

  // The second request carries the call and its result, the system prompt first, and the session's memtro options.
  const body = sent();
  assert.equal(body.model, "auto:chat");
  assert.deepEqual(body.memtro, { tools: false, session: agent.sessionId, project: "acme/widgets" });
  assert.equal(body.messages[0]!.role, "system");
  assert.match(String(body.messages[0]!.content), /coding agent/);
  assert.deepEqual(body.messages.slice(1), [
    { role: "user", content: "What does a.ts do?" },
    { role: "assistant", content: "Reading it.", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "read ran" },
  ]);
  assert.equal(JSON.stringify(body).includes("Let me look."), false, "thinking is never sent back");
  assert.equal(sent(2).memtro.session, agent.sessionId, "one session id for every step");

  const saved = store.load(agent.sessionId)!;
  assert.deepEqual(saved.messages, agent.messages());
  assert.equal(saved.meta.title, "What does a.ts do?");
  assert.equal(saved.meta.cwd, home);
});

test("refusals, bad arguments, unknown tools and a throwing tool are all results, never missing", async () => {
  const gate = fakeGate((call) =>
    call.tool === "bash" && call.args.path === "rm" ? { verdict: "deny", reason: "Deletes the repository." , source: "classifier" } : call.tool === "bash" || call.tool === "write" ? { verdict: "ask", reason: "Runs a command.", source: "mode" } : { verdict: "allow", reason: "Read.", source: "rule" },
  );
  const approver = fakeApprover([{ kind: "deny", note: "use pnpm, not npm" }, { kind: "session", rule: { kind: "tool", tool: "write" } }]);
  const boom = fakeTool("read", async () => {
    throw new Error("disk on fire");
  });
  const { agent } = agentWith({ gate, approver, tools: [boom, fakeTool("bash"), fakeTool("write")] });
  fake.chatScript.push(
    callsReply([
      { id: "j", name: "read", args: "{not json" },
      { id: "u", name: "teleport", args: {} },
      { id: "v", name: "read", args: { bad: 1 } },
      { id: "d", name: "bash", args: { path: "rm" } },
      { id: "n", name: "bash", args: { path: "npm test" } },
      { id: "s", name: "write", args: { path: "x.ts" } },
      { id: "t", name: "read", args: { path: "y.ts" } },
    ]),
    textReply("Done."),
  );
  const events = await runTurn(agent, "Fix the tests");
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "stop" });
  const results = Object.fromEntries(events.filter((e): e is Extract<AgentEvent, { type: "tool-result" }> => e.type === "tool-result").map((e) => [e.id, e.result]));
  assert.deepEqual(Object.keys(results), ["j", "u", "v", "d", "n", "s", "t"]);
  assert.match(results.j!.content, /not valid JSON/);
  assert.match(results.u!.content, /no tool named "teleport".*read, bash, write/);
  assert.match(results.v!.content, /Invalid arguments for read: `bad` is not allowed/);
  assert.match(results.d!.content, /safety check refused.*Deletes the repository.*Do not retry the same call unchanged/);
  assert.match(results.n!.content, /was not approved\. use pnpm, not npm\..*Do not retry the same call unchanged; follow the note/);
  assert.equal(results.s!.content, "write ran");
  assert.match(results.t!.content, /The read tool failed: disk on fire/);
  for (const id of ["j", "u", "v", "d", "n", "t"]) assert.equal(results[id]!.isError, true, `${id} is an error`);

  // Only validated calls reach the gate; the person's words are the only context, earlier titles in order.
  assert.deepEqual(gate.checks.map((c) => c.call.id), ["d", "n", "s", "t"]);
  assert.deepEqual(gate.checks[0]!.ctx.userMessages, ["Fix the tests"]);
  assert.deepEqual(gate.checks[3]!.ctx.earlierCalls, ["bash rm", "bash npm test", "write x.ts"]);
  assert.deepEqual(approver.asked.map((c) => c.id), ["n", "s"]);
  assert.deepEqual(gate.remembered, [{ kind: "tool", tool: "write" }]);
  const decisions = events.filter((e): e is Extract<AgentEvent, { type: "tool-decision" }> => e.type === "tool-decision");
  assert.deepEqual(decisions.find((d) => d.id === "n")!.answer, { kind: "deny", note: "use pnpm, not npm" });
  assert.equal(decisions.find((d) => d.id === "d")!.answer, undefined);
  assertWellFormed(agent.messages());
  assertWellFormed(sent().messages as Message[]);
});

test("interrupt during the model stream: turn ends interrupted, partial text kept, next request is valid", async () => {
  const { agent, store } = agentWith();
  fake.chatScript.push({ stream: [{ text: "I will start by" }, { hang: true }] });
  const ac = new AbortController();
  const events = await runTurn(agent, "Refactor it", ac.signal, (e) => {
    if (e.type === "text") ac.abort();
  });
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "interrupted" });
  assert.deepEqual(agent.messages(), [
    { role: "user", content: "Refactor it" },
    { role: "assistant", content: "I will start by" },
  ]);
  fake.chatScript.push(textReply("Stopped; what next?"));
  const again = await runTurn(agent, "Never mind");
  assert.deepEqual(again.at(-1), { type: "turn-end", reason: "stop" });
  assert.deepEqual(sent().messages.slice(1).map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(store.load(agent.sessionId)!.messages, agent.messages());
});

test("interrupt during a tool: the running call and every later one get a result, and the saved conversation goes back out valid", async () => {
  let ran = 0;
  const slow = fakeTool("bash", (_args, ctx) => {
    ran++;
    ctx.onProgress?.("compiling…");
    return new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ content: "partial output", isError: true }), { once: true }));
  });
  const { agent, store } = agentWith({ tools: [fakeTool("read"), slow] });
  fake.chatScript.push(
    callsReply([
      { id: "a", name: "bash", args: { path: "make" } },
      { id: "b", name: "read", args: { path: "out.log" } },
    ]),
  );
  const ac = new AbortController();
  const events = await runTurn(agent, "Build it", ac.signal, (e) => {
    if (e.type === "tool-progress") ac.abort();
  });
  assert.equal(ran, 1);
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "interrupted" });
  const results = events.filter((e): e is Extract<AgentEvent, { type: "tool-result" }> => e.type === "tool-result");
  assert.deepEqual(results.map((r) => r.id), ["a", "b"]);
  assert.match(results[0]!.result.content, new RegExp(`^${INTERRUPTED_DURING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(results[0]!.result.content, /partial output/);
  assert.equal(results[1]!.result.content, INTERRUPTED_BEFORE);
  assertWellFormed(agent.messages());

  // Resume from disk in a new agent and send it: the platform gets a well-formed conversation.
  const loaded = store.load(agent.sessionId)!;
  assert.deepEqual(loaded.messages, agent.messages());
  const { agent: resumed } = agentWith({ store, resume: loaded });
  assert.equal(resumed.sessionId, agent.sessionId);
  fake.chatScript.push(textReply("The build was stopped."));
  const again = await runTurn(resumed, "What happened?");
  assert.deepEqual(again.at(-1), { type: "turn-end", reason: "stop" });
  const body = sent();
  assertWellFormed(body.messages as Message[]);
  assert.deepEqual(body.messages.slice(1).map((m) => (m.role === "tool" ? `tool:${(m as { tool_call_id: string }).tool_call_id}` : m.role)), ["user", "assistant", "tool:a", "tool:b", "user"]);
  assert.equal(body.memtro.session, agent.sessionId);
});

test("interrupt while waiting for approval: the call is answered as not run", async () => {
  const ac = new AbortController();
  const approver: Approver = { ask: () => new Promise(() => ac.abort()) };
  const { agent } = agentWith({ approver, gate: fakeGate(() => ({ verdict: "ask", reason: "Runs a command.", source: "mode" })) });
  fake.chatScript.push(callsReply([{ id: "a", name: "bash", args: { path: "ls" } }]));
  const events = await runTurn(agent, "List", ac.signal);
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "interrupted" });
  assert.deepEqual(agent.messages().at(-1), { role: "tool", tool_call_id: "a", content: INTERRUPTED_BEFORE });
});

test("a mid-stream error ends the turn as an error, without a retry", async () => {
  const { agent } = agentWith();
  const before = fake.requests.length;
  fake.chatScript.push({ stream: [{ text: "Part" }, { error: "provider fell over" }]});
  const events = await runTurn(agent, "Go");
  assert.deepEqual(types(events).slice(-2), ["error", "turn-end"]);
  const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
  assert.match(err.message, /provider fell over/);
  assert.equal(err.retryable, false);
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "error" });
  assert.equal(fake.requests.length - before, 1);
});

test("a plain rate limit is retried with notice; a quota is not", async () => {
  const { agent } = agentWith();
  fake.chatScript.push({ status: 429, body: "<html>429</html>", headers: { "Retry-After": "0" } }, textReply("Fine now."));
  const events = await runTurn(agent, "Go");
  assert.equal(events.filter((e) => e.type === "notice").length, 1);
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "stop" });

  fake.chatScript.push({ status: 429, body: { error: { message: "Allowance used up", type: "insufficient_quota", code: "allowance_exhausted" } } }, textReply("never"));
  const quota = await runTurn(agent, "Again");
  assert.deepEqual(quota.at(-1), { type: "turn-end", reason: "error" });
  assert.equal(quota.some((e) => e.type === "notice"), false);
  assert.equal(fake.chatScript.length, 1, "no second attempt");
  fake.chatScript.length = 0;
});

test("a cut-off stream before any output is retried; it is never taken as an answer", async () => {
  const { agent } = agentWith();
  fake.chatScript.push({ stream: [{ toolCall: { id: "x", name: "read", arguments: "{}" } }], cut: true }, textReply("Complete."));
  const events = await runTurn(agent, "Go");
  assert.equal(events.some((e) => e.type === "tool-call"), false);
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "stop" });
  assert.deepEqual(agent.messages().at(-1), { role: "assistant", content: "Complete." });
});

test("finish_reason length ends the turn with a notice and does not loop", async () => {
  const { agent } = agentWith();
  fake.chatScript.push({ stream: [{ text: "A very long" }, { finish: "length" }, { usage: { input: 10, output: 4000 } }] }, textReply("never"));
  const events = await runTurn(agent, "Write a novel");
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "length" });
  assert.ok(events.some((e) => e.type === "notice" && /output limit/.test(e.text)));
  assert.equal(fake.chatScript.length, 1);
  fake.chatScript.length = 0;
});

test("the step limit stops a model that keeps calling tools, with every call answered", async () => {
  const { agent } = agentWith({ maxSteps: 2 });
  fake.chatScript.push(callsReply([{ id: "1", name: "read", args: {} }]), callsReply([{ id: "2", name: "read", args: {} }]), textReply("never"));
  const events = await runTurn(agent, "Loop");
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "step-limit" });
  assertWellFormed(agent.messages());
  fake.chatScript.length = 0;
});

test("compaction: past 80% of the context the older turns become one summary, saved and restored", async () => {
  const store = freshStore();
  const { agent } = agentWith({ store, contextLimit: () => 1000 });
  fake.chatScript.push(textReply(`First answer. ${"detail ".repeat(400)}`, { input: 300, output: 5 }));
  await runTurn(agent, `First question ${"context ".repeat(400)}`);
  fake.chatScript.push(callsReply([{ id: "r", name: "read", args: { path: "a" } }], { input: 500, output: 5 }), textReply("Second answer.", { input: 850, output: 5 }));
  await runTurn(agent, "Second question");
  // The last step used 850 of 1000: the next turn compacts first.
  fake.chatScript.push(textReply("## Goal\nAnswer questions."), textReply("Third answer."));
  const events = await runTurn(agent, "Third question");
  const compacted = events.find((e) => e.type === "compacted") as Extract<AgentEvent, { type: "compacted" }>;
  assert.ok(compacted, "compacted");
  assert.ok(compacted.after < compacted.before);

  const summaryReq = sent(2);
  assert.deepEqual(summaryReq.memtro, { tools: false, retrieve: false, memory: "off", session: agent.sessionId });
  assert.equal(summaryReq.tools, undefined);
  assert.match(String(summaryReq.messages[1]!.content), /\[User\]:\nFirst question/);
  assert.doesNotMatch(String(summaryReq.messages[1]!.content), /Second question/, "the newest turn is kept whole, not summarised");

  const messages = agent.messages();
  assert.ok(isSummaryMessage(messages[0]!));
  assert.match(messages[0]!.content as string, /Answer questions/);
  assert.deepEqual(messages.slice(1).map((m) => m.role), ["user", "assistant", "tool", "assistant", "user", "assistant"]);
  assertWellFormed(messages);
  assert.deepEqual(store.load(agent.sessionId)!.messages, messages);

  // The summary is not something the person said: the gate never sees it as intent.
  const gate = fakeGate();
  const { agent: resumed } = agentWith({ store, gate, resume: store.load(agent.sessionId)! });
  fake.chatScript.push(callsReply([{ id: "z", name: "read", args: {} }]), textReply("ok"));
  await runTurn(resumed, "Fourth");
  assert.deepEqual(gate.checks[0]!.ctx.userMessages, ["Second question", "Third question", "Fourth"]);
});

test("a failed compaction leaves the conversation as it was and says so", async () => {
  const { agent } = agentWith();
  fake.chatScript.push(textReply("One."), textReply("Two."));
  await runTurn(agent, "One?");
  await runTurn(agent, "Two?");
  const before = agent.messages();
  fake.chatScript.push({ stream: [{ error: "summariser down" }] });
  const events: AgentEvent[] = [];
  for await (const e of agent.compact(new AbortController().signal)) events.push(e);
  assert.equal(events.length, 1);
  assert.ok(events[0]!.type === "notice" && /Compaction failed.*summariser down.*as it was/.test(events[0]!.text));
  assert.deepEqual(agent.messages(), before);
});

test("/compact with only one turn has nothing to do", async () => {
  const { agent } = agentWith();
  fake.chatScript.push(textReply("Hi."));
  await runTurn(agent, "Hello");
  const events: AgentEvent[] = [];
  for await (const e of agent.compact(new AbortController().signal)) events.push(e);
  assert.ok(events.length === 1 && events[0]!.type === "notice" && /Nothing to compact/.test(events[0]!.text));
});

test("setModel changes the model sent, still with one :chat", async () => {
  const { agent } = agentWith();
  agent.setModel("anthropic/claude-sonnet-5:chat");
  fake.chatScript.push(textReply("ok"));
  const events = await runTurn(agent, "hi");
  assert.equal(sent().model, "anthropic/claude-sonnet-5:chat");
  assert.deepEqual(events[0], { type: "turn-start", session: agent.sessionId, model: "anthropic/claude-sonnet-5:chat" });
});

test("a tool that ignores the interrupt: the turn still ends, and the call is answered", async () => {
  const stuck = fakeTool("bash", (_args, ctx) => {
    ctx.onProgress?.("working");
    return new Promise(() => {}); // never settles, whatever the signal says
  });
  const { agent } = agentWith({ tools: [stuck] });
  fake.chatScript.push(callsReply([{ id: "s", name: "bash", args: { path: "x" } }]));
  const ac = new AbortController();
  const started = Date.now();
  const events = await runTurn(agent, "Go", ac.signal, (e) => {
    if (e.type === "tool-progress") ac.abort();
  });
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "interrupted" });
  assert.equal(agent.messages().at(-1)?.role, "tool");
  assertWellFormed(agent.messages());
});
