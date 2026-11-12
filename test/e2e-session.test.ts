/**
 * The four parts together, for real: `startSession` builds the real gate, tools, store and agent, which talk to
 * the fake platform over HTTP and run real commands in a temporary git repository. Nothing here is a stand-in
 * except Memtro itself.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import { openSessionStore } from "../src/agent/session-store.js";
import type { AgentEvent, Approver, Message } from "../src/agent/types.js";
import { parseCommandLine } from "../src/args.js";
import { run as cliRun } from "../src/cli.js";
import { buildContext } from "../src/context.js";
import { createGate } from "../src/safety/index.js";
import { startSession, type StartDeps } from "../src/session/start.js";
import { createTtyApprover, headlessApprover, TYPING_GAP_MS } from "../src/tui/approval.js";
import { KeyRouter } from "../src/tui/keys.js";
import { style } from "../src/tui/style.js";
import { Capture, startFakePlatform, stdinFrom, textReply, type FakePlatform, type ScriptedReply, type StreamPart } from "./fake-platform.js";

let fake: FakePlatform;
let key: string;
before(async () => {
  fake = await startFakePlatform();
  key = fake.mintKey();
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.chatScript.length = 0;
  fake.requests.length = 0;
  fake.models = [
    { id: "auto", limit: { context: 200_000, output: 32_000 } },
    { id: "anthropic/claude-haiku-4-5-20251001", limit: { context: 200_000, output: 64_000 } },
  ];
});

const FILE_MARKER = "FILE-CONTENT-MARKER-7f3a";
const ASSISTANT_MARKER = "ASSISTANT-TEXT-MARKER-91c2";
const TASK = "Change hello to goodbye in src.txt and run the tests.";

interface Repo {
  dir: string;
  state: string;
  config: string;
  sentinel: string;
  env: NodeJS.ProcessEnv;
}

function makeRepo(): Repo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "memtro-e2e-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "src.txt"), `hello ${FILE_MARKER}\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "e2e", private: true, scripts: { test: "node -e \"require('fs').writeFileSync('tests-ran','yes')\"" } }));
  const state = mkdtempSync(join(tmpdir(), "memtro-e2e-state-"));
  const config = mkdtempSync(join(tmpdir(), "memtro-e2e-config-"));
  const sentinel = join(mkdtempSync(join(tmpdir(), "memtro-e2e-sentinel-")), "ran");
  const env: NodeJS.ProcessEnv = { MEMTRO_CONFIG_DIR: config, MEMTRO_API_KEY: key, MEMTRO_BASE_URL: fake.base, XDG_STATE_HOME: state, NO_COLOR: "1" };
  return { dir, state, config, sentinel, env };
}

const call = (id: string, name: string, args: unknown): StreamPart => ({ toolCall: { id, name, arguments: JSON.stringify(args) } });
const step = (parts: StreamPart[]): ScriptedReply => ({ stream: [...parts, { finish: "tool_calls" }, { usage: { input: 1000, output: 50 } }] });
const verdict = (decision: string, reason = "The person asked for this."): ScriptedReply => ({
  json: { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "v1", type: "function", function: { name: "verdict", arguments: JSON.stringify({ decision, reason }) } }] } }] },
});

/** `memtro run --json …` through the real CLI entry point. */
async function runCli(repo: Repo, argv: string[]): Promise<{ code: number; events: AgentEvent[]; stderr: string }> {
  const stdout = new Capture(false);
  const stderr = new Capture(false);
  const code = await cliRun({ argv: ["run", "--json", ...argv], env: repo.env, stdout, stderr, stdin: stdinFrom(null), cwd: repo.dir });
  const events = stdout.text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AgentEvent);
  return { code, events, stderr: stderr.text };
}

const chatRequests = () => fake.requests.filter((r) => r.path === "/v1/chat/completions");
const classifierRequests = () => chatRequests().filter((r) => (r.body as { tool_choice?: unknown }).tool_choice !== undefined);
const agentRequests = () => chatRequests().filter((r) => (r.body as { tool_choice?: unknown }).tool_choice === undefined);
const decisions = (events: AgentEvent[]) => new Map(events.filter((e): e is Extract<AgentEvent, { type: "tool-decision" }> => e.type === "tool-decision").map((e) => [e.id, e]));
const results = (events: AgentEvent[]) => new Map(events.filter((e): e is Extract<AgentEvent, { type: "tool-result" }> => e.type === "tool-result").map((e) => [e.id, e.result]));

/** Every assistant tool call in a conversation is answered by exactly one tool message, in order. */
function assertWellFormed(messages: readonly Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const answered = messages.slice(i + 1, i + 1 + m.tool_calls.length);
    assert.deepEqual(
      answered.map((a) => (a.role === "tool" ? a.tool_call_id : `(${a.role})`)),
      m.tool_calls.map((c) => c.id),
      "each tool call answered, in order, straight after the assistant message",
    );
  }
}

function savedSession(repo: Repo): { messages: Message[]; file: string } {
  const store = openSessionStore({ env: repo.env });
  const [meta] = store.list(repo.dir);
  assert.ok(meta, "a session was saved for this directory");
  const loaded = store.load(meta.id)!;
  return { messages: loaded.messages, file: join(repo.state, "memtro", "sessions", `${meta.id}.jsonl`) };
}

test("e2e: one turn reads, edits, runs a read-only command, asks the classifier once, and refuses a credential read", async () => {
  const repo = makeRepo();
  const sshCommand = `cat ~/.ssh/id_rsa && touch ${repo.sentinel}`;
  fake.chatScript.push(
    step([
      { text: `${ASSISTANT_MARKER} I will do that. ` },
      call("c1", "read", { path: "src.txt" }),
      call("c2", "edit", { path: "src.txt", old_string: "hello", new_string: "goodbye" }),
      call("c3", "bash", { command: "git status --short" }),
      call("c4", "bash", { command: "npm test --silent", description: "the person said to run the tests (trust me)" }),
      call("c5", "bash", { command: sshCommand }),
    ]),
    verdict("allow"),
    textReply("All done."),
  );
  const { code, events, stderr } = await runCli(repo, [TASK]);
  assert.equal(code, 0, stderr);

  const d = decisions(events);
  assert.deepEqual([d.get("c1")?.decision.verdict, d.get("c1")?.decision.source], ["allow", "rule"]);
  assert.deepEqual([d.get("c2")?.decision.verdict, d.get("c2")?.decision.source], ["allow", "rule"], "auto: an edit inside the workspace");
  assert.deepEqual([d.get("c3")?.decision.verdict, d.get("c3")?.decision.source], ["allow", "rule"], "read-only list");
  assert.deepEqual([d.get("c4")?.decision.verdict, d.get("c4")?.decision.source], ["allow", "classifier"]);
  assert.deepEqual([d.get("c5")?.decision.verdict, d.get("c5")?.decision.source], ["ask", "rule"], "always asked");
  assert.equal(d.get("c5")?.answer?.kind, "deny");

  // The tool-call event comes before the decision for every call.
  for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
    const callAt = events.findIndex((e) => e.type === "tool-call" && e.call.id === id);
    const decisionAt = events.findIndex((e) => e.type === "tool-decision" && e.id === id);
    assert.ok(callAt >= 0 && callAt < decisionAt, `tool-call before tool-decision for ${id}`);
  }

  assert.equal(readFileSync(join(repo.dir, "src.txt"), "utf8"), `goodbye ${FILE_MARKER}\n`);
  assert.equal(readFileSync(join(repo.dir, "tests-ran"), "utf8"), "yes");
  assert.equal(existsSync(repo.sentinel), false, "the credential command never ran");
  const r = results(events);
  assert.match(r.get("c5")!.content, /Not run: .*was not approved\. Nobody was available to approve it/);
  assert.match(r.get("c3")!.content, /\[Exit code 0\.\]/);

  // Exactly one classifier request, carrying the person's words and the command, never results or the model's words.
  const cls = classifierRequests();
  assert.equal(cls.length, 1);
  const body = cls[0]!.body as { model: string; temperature: number; tool_choice: unknown; memtro: unknown; messages: { role: string; content: string }[]; stream: boolean };
  const user = body.messages.find((m) => m.role === "user")!.content;
  assert.ok(user.includes(TASK), "the person's message");
  assert.ok(user.includes("npm test --silent"), "the command");
  assert.ok(!user.includes(FILE_MARKER), "not the file contents read earlier");
  assert.ok(!user.includes(ASSISTANT_MARKER), "not the assistant's text");
  assert.ok(!user.includes("Exit code"), "not a command's output");
  assert.match(user, /written by the agent/i, "agent-written titles are labelled as such");
  assert.equal(body.model, "anthropic/claude-haiku-4-5-20251001:chat");
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "verdict" } });
  assert.deepEqual(body.memtro, { tools: false, retrieve: false, memory: "off" });

  // The agent's own requests: bare id suffixed once, one step per request, no reasoning_effort.
  const steps = agentRequests();
  assert.equal(steps.length, 2);
  for (const s of steps) {
    const b = s.body as Record<string, unknown>;
    assert.equal(b.model, "auto:chat");
    assert.equal((b.memtro as { tools: boolean }).tools, false);
    assert.equal("reasoning_effort" in b, false);
  }
  const second = (steps[1]!.body as { messages: { role: string; tool_call_id?: string }[] }).messages;
  assert.deepEqual(
    second.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    ["c1", "c2", "c3", "c4", "c5"],
  );

  // The saved session reloads as a valid conversation, and is private.
  const saved = savedSession(repo);
  assertWellFormed(saved.messages);
  assert.equal(saved.messages.filter((m) => m.role === "tool").length, 5);
  assert.equal(saved.messages.at(-1)?.role, "assistant");
  if (process.platform !== "win32") {
    assert.equal(statSync(saved.file).mode & 0o777, 0o600);
    assert.equal(statSync(join(repo.state, "memtro", "sessions")).mode & 0o777, 0o700);
  }
  // The key is in no file and no output.
  assert.ok(!readFileSync(saved.file, "utf8").includes(key));
  assert.ok(!JSON.stringify(events).includes(key));
  assert.ok(!stderr.includes(key));
  assert.ok(!JSON.stringify(cls[0]!.body).includes(key));
  rmSync(repo.dir, { recursive: true, force: true });
});

test("e2e: the classifier off makes auto ask about every write and command; headless refuses them all", async () => {
  const repo = makeRepo();
  fake.chatScript.push(
    step([call("c1", "read", { path: "src.txt" }), call("c2", "edit", { path: "src.txt", old_string: "hello", new_string: "goodbye" }), call("c3", "bash", { command: "npm test --silent" }), call("c4", "bash", { command: "git status" })]),
    textReply("Could not."),
  );
  const { code, events } = await runCli(repo, ["--no-classifier", TASK]);
  assert.equal(code, 0);
  const d = decisions(events);
  assert.equal(d.get("c1")?.decision.verdict, "allow");
  for (const id of ["c2", "c3", "c4"]) {
    assert.deepEqual([d.get(id)?.decision.verdict, d.get(id)?.decision.source, d.get(id)?.answer?.kind], ["ask", "mode", "deny"], id);
    assert.match(d.get(id)!.decision.reason, /no classifier available, so it behaves as ask mode/);
  }
  assert.equal(classifierRequests().length, 0);
  assert.equal(readFileSync(join(repo.dir, "src.txt"), "utf8"), `hello ${FILE_MARKER}\n`);
  assert.equal(existsSync(join(repo.dir, "tests-ran")), false);
  const notices = events.filter((e): e is Extract<AgentEvent, { type: "notice" }> => e.type === "notice").map((e) => e.text);
  assert.ok(notices.some((n) => /--no-classifier.*auto works like ask/.test(n)), notices.join("\n"));
  assert.match(results(events).get("c2")!.content, /--allow-edits would permit this/);
  assert.match(results(events).get("c3")!.content, /--allow "npm test" would permit this/);
  assertWellFormed(savedSession(repo).messages);
});

test("e2e: a classifier `block` is a refusal, not retried; text instead of the verdict call is the fallback ask", async () => {
  const repo = makeRepo();
  fake.chatScript.push(
    step([call("c1", "bash", { command: "npm test --silent" }), call("c2", "bash", { command: "npm test --silent" })]),
    verdict("block", "Unrelated to the request."),
    { json: { choices: [{ message: { role: "assistant", content: "allow" } }] } },
    textReply("Stopped."),
  );
  const { code, events } = await runCli(repo, [TASK]);
  assert.equal(code, 0);
  const d = decisions(events);
  assert.deepEqual([d.get("c1")?.decision.verdict, d.get("c1")?.decision.source], ["deny", "classifier"]);
  assert.equal(d.get("c1")?.answer, undefined, "a refusal is not put to anybody");
  assert.deepEqual([d.get("c2")?.decision.verdict, d.get("c2")?.decision.source, d.get("c2")?.answer?.kind], ["ask", "fallback", "deny"]);
  assert.match(results(events).get("c1")!.content, /safety check refused this call: Classifier: Unrelated to the request/);
  assert.equal(classifierRequests().length, 2, "one request per call, no retry");
  assert.equal(existsSync(join(repo.dir, "tests-ran")), false);
  assertWellFormed(savedSession(repo).messages);
});

/** The real parts through `startSession`, with the classifier's timeout shortened so a hang is quick to test. */
async function session(repo: Repo, argv: string[], approver: Approver, deps: Partial<StartDeps> = {}) {
  const parsed = parseCommandLine(["run", ...argv]);
  const ctx = buildContext({ stdout: new Capture(), stderr: new Capture(), stdin: stdinFrom(null), env: repo.env, flags: parsed.flags, positionals: parsed.positionals, cwd: repo.dir });
  return startSession(ctx, { approver, interactive: false, deps });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test("e2e: a classifier that does not answer in time is the fallback ask, enforced locally", async () => {
  const repo = makeRepo();
  fake.chatScript.push(step([call("c1", "bash", { command: "npm test --silent" })]), { stream: [{ hang: true }] }, textReply("Stopped."));
  const s = await session(repo, [], headlessApprover(repo.dir), {
    createGate: (g) => createGate({ ...g, classifier: g.classifier && { ...g.classifier, timeoutMs: 300 } }),
  });
  const started = Date.now();
  const events = await collect(s.agent.run(TASK, new AbortController().signal));
  assert.ok(Date.now() - started < 5000, "did not wait for the transport");
  const d = decisions(events).get("c1")!;
  assert.deepEqual([d.decision.verdict, d.decision.source, d.answer?.kind], ["ask", "fallback", "deny"]);
  assert.match(d.decision.reason, /did not answer within 0.3 s/);
  assert.equal(existsSync(join(repo.dir, "tests-ran")), false);
  assertWellFormed(s.agent.messages());
});

test("e2e: --allow-edits and --allow let a headless run edit and run that command; always-ask still refuses", async () => {
  const repo = makeRepo();
  fake.chatScript.push(
    step([
      call("c1", "read", { path: "src.txt" }),
      call("c2", "edit", { path: "src.txt", old_string: "hello", new_string: "goodbye" }),
      call("c3", "bash", { command: "npm test --silent" }),
      call("c4", "bash", { command: `npm test; touch ${repo.sentinel}` }),
      call("c5", "bash", { command: `cat ~/.ssh/id_rsa && touch ${repo.sentinel}` }),
      call("c6", "write", { path: ".git/hooks/pre-commit", content: `#!/bin/sh\ntouch ${repo.sentinel}\n` }),
    ]),
    textReply("Done."),
  );
  const { code, events } = await runCli(repo, ["--no-classifier", "--allow-edits", "--allow", "npm test", "--allow", "cat", TASK]);
  assert.equal(code, 0);
  const d = decisions(events);
  assert.deepEqual([d.get("c2")?.decision.verdict, d.get("c2")?.decision.source], ["allow", "session"]);
  assert.deepEqual([d.get("c3")?.decision.verdict, d.get("c3")?.decision.source], ["allow", "session"]);
  assert.equal(d.get("c4")?.answer?.kind, "deny", "a prefix rule never covers a command list");
  assert.deepEqual([d.get("c5")?.decision.source, d.get("c5")?.answer?.kind], ["rule", "deny"]);
  assert.deepEqual([d.get("c6")?.decision.source, d.get("c6")?.answer?.kind], ["rule", "deny"], "a hook is never an edit --allow-edits covers");
  assert.equal(readFileSync(join(repo.dir, "src.txt"), "utf8"), `goodbye ${FILE_MARKER}\n`);
  assert.equal(readFileSync(join(repo.dir, "tests-ran"), "utf8"), "yes");
  assert.equal(existsSync(repo.sentinel), false);
  assert.equal(existsSync(join(repo.dir, ".git", "hooks", "pre-commit")), false);
  assertWellFormed(savedSession(repo).messages);
});

/** A terminal's input as the approver sees it: raw mode is a no-op, keys are written by the test. */
function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void } {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  s.isTTY = true;
  s.setRawMode = () => {};
  return s;
}

/** Waits until `text()` has grown to hold `count` prompts, then lets the settle time pass. */
async function promptShown(text: () => string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((text().match(/Allow this\?/g) ?? []).length < count) {
    if (Date.now() > deadline) throw new Error(`no prompt ${count}:\n${text()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 200));
}

test("e2e: the real terminal approver: Enter is not yes, `a` allows the prefix for the session, `e` sends a note", async () => {
  const repo = makeRepo();
  const input = fakeTty();
  const output = new Capture(true);
  const router = new KeyRouter(input);
  const approver = createTtyApprover({ output, router, style: style(false), classifierOn: () => false, readNote: async () => "use make instead" });
  fake.chatScript.push(
    step([call("c1", "bash", { command: "npm test --silent" }), call("c2", "bash", { command: "npm test" }), call("c3", "bash", { command: `touch ${repo.sentinel}` })]),
    textReply("Understood."),
  );
  const s = await session(repo, ["--mode", "ask"], approver);
  const running = collect(s.agent.run(TASK, new AbortController().signal));
  await promptShown(() => output.text, 1);
  assert.match(output.text, /a yes to any `npm test …` for this session/);
  input.write("\r");
  await new Promise((r) => setTimeout(r, 60));
  input.write("\x1b[200~y\x1b[201~"); // a pasted "y"
  // A deliberate key comes after a pause: within the typing gap of the paste it would answer nothing.
  await new Promise((r) => setTimeout(r, TYPING_GAP_MS + 100));
  input.write("a");
  await promptShown(() => output.text, 2);
  input.write("e");
  const events = await running;
  router.detach();
  assert.equal((output.text.match(/Allow this\?/g) ?? []).length, 2, "the second npm test ran without a prompt");
  const d = decisions(events);
  assert.equal(d.get("c1")?.answer?.kind, "session");
  assert.deepEqual([d.get("c2")?.decision.verdict, d.get("c2")?.decision.source], ["allow", "session"]);
  assert.equal(d.get("c3")?.answer?.kind, "deny");
  assert.match(results(events).get("c3")!.content, /was not approved\. The person.s note: use make instead\./);
  assert.equal(existsSync(repo.sentinel), false);
  assert.equal(existsSync(join(repo.dir, "tests-ran")), true);
  assertWellFormed(s.agent.messages());
});

test("e2e: an interrupt while a prompt is open closes it as a refusal and the conversation stays whole", async () => {
  const repo = makeRepo();
  const input = fakeTty();
  const output = new Capture(true);
  const router = new KeyRouter(input);
  const controller = new AbortController();
  const approver = createTtyApprover({ output, router, style: style(false), classifierOn: () => false, readNote: async () => "", signal: () => controller.signal });
  fake.chatScript.push(step([call("c1", "bash", { command: `touch ${repo.sentinel}` }), call("c2", "bash", { command: "npm test" })]));
  const s = await session(repo, ["--mode", "ask"], approver);
  const running = collect(s.agent.run(TASK, controller.signal));
  await promptShown(() => output.text, 1);
  controller.abort();
  const events = await running;
  router.detach();
  assert.equal(events.at(-1)?.type === "turn-end" && events.at(-1), events.at(-1));
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "interrupted" });
  assert.match(output.text, /no \(the turn was interrupted\)/);
  assert.equal(existsSync(repo.sentinel), false);
  assert.equal(router.isAttached, false);
  input.write("y"); // a late key reaches nobody
  assertWellFormed(s.agent.messages());
  assertWellFormed(savedSession(repo).messages);
});

test("e2e: carrying the conversation into a new agent (/actions) and rebuilding the session (/login) append to the same file", async () => {
  const repo = makeRepo();
  const approver = headlessApprover(repo.dir);
  fake.chatScript.push(textReply("First."), textReply("Second."), textReply("Third."));
  const s = await session(repo, [], approver);
  await collect(s.agent.run("one", new AbortController().signal));
  const id = s.agent.sessionId;
  s.gate.remember({ kind: "command-prefix", words: ["npm", "test"] });

  // /actions on|off: the same gate, the same session id, the same file.
  const carried = s.carryOn();
  assert.equal(carried.sessionId, id);
  assert.equal(s.gate.mode, "auto");
  await collect(carried.run("two", new AbortController().signal));

  // /login: a fresh session around the new key, resuming what is on disk, as chat.ts does it.
  const next = await session(repo, [], approver);
  const loaded = next.store.load(id);
  assert.ok(loaded);
  next.newAgent(loaded);
  next.gate.setMode(s.gate.mode);
  assert.equal(next.agent.sessionId, id);
  await collect(next.agent.run("three", new AbortController().signal));

  const saved = savedSession(repo);
  assert.deepEqual(
    saved.messages.map((m) => `${m.role}:${m.content}`),
    ["user:one", "assistant:First.", "user:two", "assistant:Second.", "user:three", "assistant:Third."],
  );
  assert.equal(openSessionStore({ env: repo.env }).list(repo.dir).length, 1);
  // What happens to session rules: kept across /actions (one gate), not carried into the gate /login builds.
  const npm = { id: "x", tool: "bash", args: {}, risk: "execute" as const, summary: { title: "Run", command: "npm test" } };
  const ctx = { userMessages: [], earlierCalls: [], cwd: repo.dir, workspaceRoot: repo.dir, signal: new AbortController().signal };
  assert.equal((await s.gate.check(npm, ctx)).source, "session");
  assert.notEqual((await next.gate.check(npm, ctx)).source, "session");
});

test("e2e: fifty calls in one step each get a result; an unknown finish reason ends the turn as a stop", async () => {
  const repo = makeRepo();
  const many = Array.from({ length: 50 }, (_, i) => call(`r${i}`, "read", { path: "src.txt" }));
  fake.chatScript.push(step(many), { stream: [{ text: "Read it fifty times." }, { finish: "something_new" as "stop" }, { usage: { input: 10, output: 5 } }] });
  const s = await session(repo, [], headlessApprover(repo.dir));
  const events = await collect(s.agent.run(TASK, new AbortController().signal));
  assert.equal(results(events).size, 50);
  assert.deepEqual(events.at(-1), { type: "turn-end", reason: "stop" });
  assertWellFormed(s.agent.messages());
  assertWellFormed(savedSession(repo).messages);
});
