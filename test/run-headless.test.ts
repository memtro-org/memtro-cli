import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent, AgentEvent, Approver, Gate, Message, SessionMeta, SessionStore, Tool } from "../src/agent/types.js";
import { parseCommandLine } from "../src/args.js";
import { run as cliRun } from "../src/cli.js";
import { driveHeadless, exitCodeFor, run } from "../src/commands/run.js";
import { harnessSettings } from "../src/config.js";
import { buildContext } from "../src/context.js";
import { EXIT, UsageError } from "../src/errors.js";
import { chooseClassifier, initialRules, normaliseModel, resolveMode, startSession, type StartDeps } from "../src/session/start.js";
import { headlessApprover } from "../src/tui/approval.js";
import { parseSlash, runSlash, type SlashHost } from "../src/tui/slash.js";
import { style } from "../src/tui/style.js";
import { Capture, stdinFrom } from "./fake-platform.js";

/** A scripted agent: yields the events it was given; asks the approver when an event says to. */
function scripted(events: AgentEvent[], model = "auto"): Agent & { tasks: string[] } {
  const tasks: string[] = [];
  return {
    tasks,
    sessionId: "cli-test",
    model,
    setModel() {},
    async *run(text: string) {
      tasks.push(text);
      for (const e of events) yield e;
    },
    async *compact() {},
    messages: () => [],
  };
}

function context(argv: string[], opts: { stdin?: string | null; env?: NodeJS.ProcessEnv; stderrTTY?: boolean } = {}) {
  const parsed = parseCommandLine(argv);
  const stdout = new Capture(false);
  const stderr = new Capture(opts.stderrTTY ?? false);
  // Never the real keychain or the real platform: the file store, and a base URL nothing answers on.
  const env = opts.env ?? { MEMTRO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memtro-run-")), XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "memtro-run-state-")), MEMTRO_NO_UPDATE_CHECK: "1", NO_COLOR: "1", MEMTRO_API_KEY: "sk-memtro-test", MEMTRO_CREDENTIALS: "file", MEMTRO_BASE_URL: "http://127.0.0.1:9" };
  const ctx = buildContext({ stdout, stderr, stdin: stdinFrom(opts.stdin ?? null), env, flags: parsed.flags, positionals: parsed.positionals, cwd: tmpdir() });
  return { ctx, stdout, stderr, env };
}

const turn: AgentEvent[] = [
  { type: "turn-start", session: "cli-test", model: "auto" },
  { type: "text", delta: "Running the tests. " },
  {
    type: "tool-call",
    call: { id: "c1", tool: "bash", args: { command: "rm -rf build" }, risk: "execute", summary: { title: "Run `rm -rf build`", command: "rm -rf build" } },
  },
  { type: "tool-decision", id: "c1", decision: { verdict: "ask", reason: "Deletes files.", source: "classifier" }, answer: { kind: "deny", note: "nobody was available" } },
  { type: "tool-result", id: "c1", tool: "bash", result: { content: "Not run", isError: true } },
  { type: "usage", step: { input: 10, output: 5 }, session: { input: 10, output: 5 }, contextUsed: 10, contextLimit: null },
  { type: "text", delta: "Done." },
  { type: "turn-end", reason: "stop" },
];

test("run --json: one AgentEvent per line on stdout and nothing else there", async () => {
  const { ctx, stdout, stderr } = context(["run", "--json", "do it"]);
  const code = await driveHeadless(scripted(turn), "do it", { ctx, json: true, notices: ["Tool calls are judged by x."], mode: "auto", signal: new AbortController().signal });
  assert.equal(code, 0);
  const lines = stdout.text.trimEnd().split("\n").map((l) => JSON.parse(l) as AgentEvent);
  assert.deepEqual(lines[0], { type: "notice", text: "Tool calls are judged by x." });
  assert.deepEqual(lines.slice(1), turn, "the events, unchanged");
  assert.equal(stderr.text, "");
});

test("run: the answer on stdout, tool lines on stderr; a refused call is not a failure", async () => {
  const { ctx, stdout, stderr } = context(["run", "do it"]);
  const code = await driveHeadless(scripted(turn), "do it", { ctx, json: false, notices: [], mode: "auto", signal: new AbortController().signal });
  assert.equal(code, 0);
  assert.equal(stdout.text, "Running the tests. \nDone.\n");
  assert.match(stderr.text, /▶ Run `rm -rf build`\n {2}✗ not run: nobody was available/);
  assert.doesNotMatch(stdout.text, /rm -rf/);
});

test("run: exit codes follow the turn's end", async () => {
  assert.equal(exitCodeFor("stop", null), EXIT.ok);
  assert.equal(exitCodeFor("length", null), EXIT.failure);
  assert.equal(exitCodeFor("step-limit", null), EXIT.failure);
  assert.equal(exitCodeFor("error", { retryable: false }), EXIT.failure);
  assert.equal(exitCodeFor("error", { retryable: true }), EXIT.unavailable);
  assert.equal(exitCodeFor("interrupted", null), 130);
  const { ctx } = context(["run", "x"]);
  const failing = scripted([{ type: "error", message: "provider fell over", retryable: false }, { type: "turn-end", reason: "error" }]);
  assert.equal(await driveHeadless(failing, "x", { ctx, json: true, notices: [], mode: "auto", signal: new AbortController().signal }), EXIT.failure);
});

test("headless approver always refuses, saying why and what would have allowed it", async () => {
  const a = headlessApprover("/repo");
  const answer = await a.ask(
    { id: "1", tool: "edit", args: {}, risk: "write", summary: { title: "Edit", paths: ["/repo/a.ts"] } },
    { verdict: "ask", reason: "ask mode", source: "mode" },
    { kind: "write-under", dir: "/repo" },
  );
  assert.equal(answer.kind, "deny");
  assert.match((answer as { note: string }).note, /Nobody was available.*--allow-edits/);
});

/** Fakes for everything startSession builds, recording what it was given. */
function fakeDeps(over: Partial<StartDeps> = {}) {
  const seen: { gate?: Parameters<StartDeps["createGate"]>[0]; agent?: Parameters<StartDeps["createAgent"]>[0]; memtro: boolean[] } = { memtro: [] };
  const sessions = new Map<string, { meta: SessionMeta; messages: Message[] }>();
  const store: SessionStore = {
    create: (meta) => void sessions.set(meta.id, { meta, messages: [] }),
    appendMessage: () => {},
    appendCompaction: () => {},
    list: (cwd) => [...sessions.values()].map((s) => s.meta).filter((m) => m.cwd === cwd),
    load: (id) => sessions.get(id) ?? null,
  };
  const gate = (mode: Gate["mode"]): Gate => ({ mode, setMode() {}, check: async () => ({ verdict: "allow", reason: "", source: "rule" }), remember() {}, suggestRule: () => null });
  const local: Tool = { spec: { name: "read", description: "Read", parameters: {} }, validate: () => ({ ok: true, args: {} }), risk: () => "read", summarise: () => ({ title: "Read" }), run: async () => ({ content: "" }) };
  const deps: Partial<StartDeps> = {
    listModels: async () => [
      { id: "auto", context: 200_000, output: 32_000 },
      { id: "anthropic/claude-haiku-4-5-20251001", context: 200_000, output: 64_000 },
      { id: "anthropic/claude-sonnet-5", context: 1_000_000, output: 64_000 },
    ],
    forcedCallVia: () => async () => null,
    loadMemtroTools: async (_c, o) => {
      seen.memtro.push(o.actions);
      return [];
    },
    createLocalTools: () => [local],
    createGate: (g) => {
      seen.gate = g;
      return gate(g.mode);
    },
    openSessionStore: () => store,
    createAgent: (a) => {
      seen.agent = a;
      return scripted([{ type: "turn-end", reason: "stop" }], a.model);
    },
    home: "/home/test",
    platform: "linux",
    ...over,
  };
  return { deps, seen, sessions };
}

const approver: Approver = { ask: async () => ({ kind: "deny" }) };

test("startSession: flags and models become the gate, classifier, rules and agent", async () => {
  const { ctx, stderr } = context(["run", "--allow", "npm test", "--allow-edits", "--model", "anthropic/claude-sonnet-5:chat", "x"]);
  const { deps, seen } = fakeDeps();
  const s = await startSession(ctx, { approver, interactive: false, deps });
  assert.equal(seen.gate!.mode, "auto");
  assert.equal(seen.gate!.classifier!.model, "anthropic/claude-haiku-4-5-20251001");
  assert.equal(seen.gate!.home, "/home/test");
  assert.equal(seen.gate!.configDir, ctx.dir);
  assert.deepEqual(seen.gate!.initialRules, [{ kind: "write-under", dir: s.workspaceRoot }, { kind: "command-prefix", words: ["npm", "test"] }]);
  assert.equal(seen.agent!.model, "anthropic/claude-sonnet-5");
  assert.equal(seen.agent!.contextLimit("anthropic/claude-sonnet-5:chat"), 1_000_000);
  assert.equal(seen.agent!.contextLimit("unknown"), null);
  assert.deepEqual(seen.memtro, [false]);
  assert.match(s.notices.join("\n"), /judged by anthropic\/claude-haiku/);
  assert.equal(stderr.text, "", "no warning without --unchecked");
});

test("startSession: unreachable parts are notices; --unchecked warns every start; a refused key is fatal", async () => {
  const { ctx, stderr } = context(["run", "--unchecked", "x"]);
  const { deps, seen } = fakeDeps({
    listModels: async () => {
      throw new Error("timed out");
    },
    loadMemtroTools: async () => {
      throw new Error("connection refused");
    },
  });
  const s = await startSession(ctx, { approver, interactive: false, deps });
  assert.equal(seen.gate!.mode, "unchecked");
  assert.equal(seen.gate!.classifier, null);
  assert.match(stderr.text, /--unchecked: no tool call is checked/);
  assert.match(s.notices.join("\n"), /Could not list models \(timed out\)/);
  assert.match(s.notices.join("\n"), /local tools only/);

  const { AuthError } = await import("../src/errors.js");
  const refused = fakeDeps({
    listModels: async () => {
      throw new AuthError("Memtro refused the key");
    },
  });
  await assert.rejects(startSession(context(["run", "x"]).ctx, { approver, interactive: false, deps: refused.deps }), AuthError);
});

test("startSession: an unknown model, conflicting flags and --resume without an id in a run are usage errors", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(startSession(context(["run", "--model", "nope/model", "x"]).ctx, { approver, interactive: false, deps }), /not a model this account offers/);
  await assert.rejects(startSession(context(["run", "--mode", "ask", "--unchecked", "x"]).ctx, { approver, interactive: false, deps }), UsageError);
  await assert.rejects(startSession(context(["run", "--resume", "--", "x"]).ctx, { approver, interactive: false, deps }), /needs a session id/);
  await assert.rejects(startSession(context(["run", "--resume", "cli-missing", "x"]).ctx, { approver, interactive: false, deps }), /No session "cli-missing"/);
});

test("run end to end with fakes: the task from arguments and stdin", async () => {
  const { ctx, stdout } = context(["run", "review", "this"], { stdin: "diff --git a b" });
  const { deps } = fakeDeps({ createAgent: (a) => scripted([{ type: "text", delta: `model ${a.model}` }, { type: "turn-end", reason: "stop" }], a.model) });
  assert.equal(await run(ctx, deps), 0);
  assert.equal(stdout.text, "model auto\n");
  await assert.rejects(run(context(["run"]).ctx, deps), /No task/);
});

test("classifier choice, mode and rules", () => {
  const models = [{ id: "auto", context: null, output: null }];
  const locked = chooseClassifier({ off: null, models, mode: "auto" });
  assert.equal(locked.model, "memtro");
  assert.equal(locked.orgDefault, true);
  assert.match(locked.notice, /organisation's default model.*administrator can allow explicit model choice/);
  assert.equal(chooseClassifier({ off: null, models: null, mode: "auto" }).model, "memtro");
  assert.equal(chooseClassifier({ off: null, configured: "openai/gpt-5.4-nano:chat", models, mode: "auto" }).model, "openai/gpt-5.4-nano");
  const off = chooseClassifier({ off: "flag", models, mode: "auto" });
  assert.equal(off.model, null);
  assert.match(off.notice, /--no-classifier.*auto works like ask/);
  assert.equal(resolveMode({}, { classifier: {} }), "auto");
  assert.equal(resolveMode({}, { classifier: {}, mode: "ask" }), "ask");
  assert.equal(resolveMode({ mode: "auto" }, { classifier: {}, mode: "ask" }), "auto");
  assert.throws(() => resolveMode({ mode: "yolo" }, { classifier: {} }), UsageError);
  assert.throws(() => initialRules({ allow: ["  "] }, "/r"), UsageError);
  assert.equal(normaliseModel("auto:chat"), "auto");
  assert.throws(() => normaliseModel("auto:agent"), /Memtro's own agent/);
});

test("config: harness settings are read strictly and survive a rewrite", async () => {
  assert.deepEqual(harnessSettings({ version: 1, profiles: {}, mode: "ask", classifier: { model: "x", enabled: false }, actions: true }), {
    mode: "ask",
    classifier: { model: "x", enabled: false },
    actions: true,
  });
  assert.throws(() => harnessSettings({ version: 1, profiles: {}, mode: "auto " }), /mode must be/);
  assert.throws(() => harnessSettings({ version: 1, profiles: {}, classifier: { enabled: "no" } }), /classifier.enabled/);
  assert.equal(harnessSettings({ version: 1, profiles: {}, classifier: { timeoutMs: 20_000 } }).classifier.timeoutMs, 20_000);
  for (const bad of [0, -1, 1.5, "8000", null]) {
    assert.throws(() => harnessSettings({ version: 1, profiles: {}, classifier: { timeoutMs: bad } }), /classifier.timeoutMs/, String(bad));
  }
  const { readConfig, updateProfile } = await import("../src/config.js");
  const dir = mkdtempSync(join(tmpdir(), "memtro-cfg-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, profiles: {}, mode: "ask", classifier: { model: "m" } }));
  updateProfile(dir, "default", () => ({ base_url: "https://x.example" }));
  const after = readConfig(dir);
  assert.equal(after.mode, "ask");
  assert.deepEqual(after.classifier, { model: "m" });
});

test("dispatch: a typo is not a task; no terminal and no task is a usage error; -p is headless", async () => {
  assert.throws(() => parseCommandLine(["fix", "the", "build"]), /Unknown command "fix".*memtro run "fix the build"/s);
  const flags = parseCommandLine(["--model", "auto", "--allow", "npm test", "--allow", "make", "-p", "task"]);
  assert.equal(flags.command, null);
  assert.deepEqual(flags.flags.allow, ["npm test", "make"]);
  assert.equal(flags.flags.prompt, "task");
  assert.equal(parseCommandLine(["--resume"]).flags.resume, "");
  assert.equal(parseCommandLine(["--resume", "cli-abc"]).flags.resume, "cli-abc");
  assert.equal(parseCommandLine(["run", "--resume", "--json", "x"]).flags.resume, "");
  const env = { MEMTRO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memtro-d-")), XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "memtro-d-state-")), MEMTRO_NO_UPDATE_CHECK: "1", NO_COLOR: "1", MEMTRO_CREDENTIALS: "file", MEMTRO_BASE_URL: "http://127.0.0.1:9" };
  const stdout = new Capture(false);
  const stderr = new Capture(false);
  assert.equal(await cliRun({ argv: [], env, stdout, stderr, stdin: stdinFrom(null) }), EXIT.usage);
  const help = new Capture(false);
  assert.equal(await cliRun({ argv: ["--help"], env, stdout: help, stderr, stdin: stdinFrom(null) }), 0);
  assert.match(help.text.split("Commands:")[0]!, /memtro run "<task>"/, "the harness is described first");
  assert.equal(await cliRun({ argv: ["-p", "do it"], env, stdout, stderr: new Capture(false), stdin: stdinFrom(null) }), EXIT.auth, "headless needs a key");
});

test("slash commands against a fake host", async () => {
  const said: string[] = [];
  let model = "auto";
  let mode: "ask" | "auto" | "unchecked" = "auto";
  let logoutEnds = true;
  const host: SlashHost = {
    style: style(false),
    say: (t) => said.push(t),
    model: () => model,
    setModel: (m) => (model = m),
    models: () => [{ id: "auto", context: 200_000, output: null }, { id: "anthropic/claude-sonnet-5", context: null, output: null }],
    normaliseModel,
    mode: () => mode,
    setMode: (m) => (mode = m),
    classifierOn: () => true,
    newSession: () => said.push("(new)"),
    sessions: () => [{ id: "cli-1", cwd: "/r", started: new Date(Date.now() - 7_200_000).toISOString(), model: "auto", title: "fix the build" }],
    resume: (id) => id === "cli-1",
    pick: async () => "1",
    compact: async () => {},
    tools: () => [],
    actions: () => false,
    setActions: async (on) => `actions ${on}`,
    login: async () => {},
    logout: async () => logoutEnds,
    update: async () => void said.push("(update)"),
    whoami: async () => {},
    now: () => new Date(),
  };
  assert.equal(parseSlash("/usr/bin/env is broken"), null, "a path is a message");
  assert.equal(parseSlash(" /help"), null);
  assert.deepEqual(parseSlash("/model  x "), { name: "model", args: "x" });
  assert.equal(await runSlash({ name: "quit", args: "" }, host), "quit");
  await runSlash({ name: "model", args: "nope" }, host);
  assert.match(said.at(-1)!, /not a model this account offers/);
  assert.equal(model, "auto");
  await runSlash({ name: "model", args: "anthropic/claude-sonnet-5:chat" }, host);
  assert.equal(model, "anthropic/claude-sonnet-5");
  await runSlash({ name: "model", args: "" }, host);
  assert.match(said.at(-1)!, /● anthropic\/claude-sonnet-5/);
  await runSlash({ name: "mode", args: "unchecked" }, host);
  assert.equal(mode, "auto");
  await runSlash({ name: "mode", args: "ask" }, host);
  assert.equal(mode, "ask");
  await runSlash({ name: "resume", args: "" }, host);
  assert.match(said.join("\n"), /1 {2}fix the build {2}2 h ago · auto/);
  assert.match(said.at(-1)!, /Resumed: fix the build/);
  await runSlash({ name: "actions", args: "on" }, host);
  assert.equal(said.at(-1), "actions true");
  await runSlash({ name: "frob", args: "" }, host);
  assert.match(said.at(-1)!, /Unknown command \/frob/);
  await runSlash({ name: "update", args: "" }, host);
  assert.equal(said.at(-1), "(update)");
  assert.equal(await runSlash({ name: "logout", args: "" }, host), "quit", "a removed key ends the session");
  logoutEnds = false;
  assert.equal(await runSlash({ name: "logout", args: "" }, host), "ok", "a key that could not be removed does not");
  await runSlash({ name: "help", args: "" }, host);
  assert.match(said.at(-1)!, /\/logout.*\n.*\/update/s);
});

test("startSession: an --allow that names an always-asked command is said to be ignored", async () => {
  const { ctx } = context(["run", "--allow", "cat ~/.ssh/id_rsa", "--allow", "npm test", "x"]);
  const { deps } = fakeDeps();
  const s = await startSession(ctx, { approver, interactive: false, deps });
  assert.match(s.notices.join("\n"), /--allow "cat ~\/\.ssh\/id_rsa" is ignored/);
  assert.doesNotMatch(s.notices.join("\n"), /--allow "npm test" is ignored/);
});
