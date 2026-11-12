import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, Answer, PendingCall } from "../src/agent/types.js";
import { parseCommandLine } from "../src/args.js";
import { chooseInterface } from "../src/commands/chat.js";
import { mainHelp } from "../src/commands/help.js";
import { interfaceSettings } from "../src/config.js";
import type { Session } from "../src/session/start.js";
import { normaliseModel } from "../src/session/start.js";
import { runSlash, SLASH_COMMANDS, type SlashHost } from "../src/tui/slash.js";
import { style } from "../src/tui/style.js";
import { Editor } from "../src/tui/full/editor.js";
import { FullApp, itemsFromMessages, osc52, osc52Support } from "../src/tui/full/run.js";
import { createTestScreen } from "../src/tui/full/screen/screen.js";
import type { Input } from "../src/tui/full/types.js";

test("full screen or inline: the terminal, its size, TERM, --inline and ui decide", () => {
  const base = { inlineFlag: false, stdinTTY: true, stdoutTTY: true, columns: 120, rows: 36, term: "xterm-256color" };
  assert.equal(chooseInterface(base), "full");
  assert.equal(chooseInterface({ ...base, inlineFlag: true }), "inline");
  assert.equal(chooseInterface({ ...base, configured: "inline" }), "inline");
  assert.equal(chooseInterface({ ...base, configured: "full", columns: 49 }), "inline", "smaller than 50 wide");
  assert.equal(chooseInterface({ ...base, rows: 11 }), "inline", "smaller than 12 high");
  assert.equal(chooseInterface({ ...base, columns: 50, rows: 12 }), "full");
  assert.equal(chooseInterface({ ...base, term: "dumb" }), "inline");
  assert.equal(chooseInterface({ ...base, term: undefined }), "inline");
  assert.equal(chooseInterface({ ...base, stdoutTTY: false }), "inline");
  assert.equal(chooseInterface({ ...base, stdinTTY: false }), "inline");
});

test("settings and flags: ui, theme, mouse; a wrong value names the key", () => {
  assert.deepEqual(interfaceSettings({ version: 1, profiles: {}, ui: "inline", theme: "light", mouse: false }), { ui: "inline", theme: "light", mouse: false });
  assert.deepEqual(interfaceSettings({ version: 1, profiles: {} }), {});
  assert.throws(() => interfaceSettings({ version: 1, profiles: {}, ui: "fullscreen" }), /ui must be "full" or "inline"/);
  assert.throws(() => interfaceSettings({ version: 1, profiles: {}, theme: "blue" }), /theme must be/);
  assert.throws(() => interfaceSettings({ version: 1, profiles: {}, mouse: "no" }), /mouse must be true or false/);
  const p = parseCommandLine(["--inline", "--theme", "light", "--no-mouse"]);
  assert.equal(p.command, null);
  assert.equal(p.flags.inline, true);
  assert.equal(p.flags.theme, "light");
  assert.equal(p.flags["no-mouse"], true);
  assert.throws(() => parseCommandLine(["run", "--inline", "x"]), /Unknown option '--inline'/, "not an option of memtro run");
  assert.match(mainHelp(), /--inline +The plain interface/);
  assert.match(mainHelp(), /--no-mouse/);
});

test("slash commands carry an argument hint, whether they act, and their choices; /theme and /copy are there", () => {
  const by = Object.fromEntries(SLASH_COMMANDS.map((c) => [c.name, c]));
  for (const name of ["logout", "update", "new", "login", "quit", "compact", "resume", "actions"]) assert.equal(by[name]!.acts, true, name);
  for (const name of ["help", "model", "tools", "whoami", "copy", "theme", "mode"]) assert.equal(by[name]!.acts, false, name);
  assert.equal(by.model!.hint, "[id]");
  assert.deepEqual(by.theme!.choices!({ model: () => "", models: () => null, mode: () => "auto", sessions: () => [], actions: () => false, now: () => new Date(), theme: () => "dark" }).map((c) => [c.value, Boolean(c.current)]), [
    ["auto", false],
    ["dark", true],
    ["light", false],
  ]);
});

test("the inline interface's host has no /theme or /copy, and says so", async () => {
  const said: string[] = [];
  const host = { style: style(false), say: (t: string) => said.push(t) } as unknown as SlashHost;
  await runSlash({ name: "theme", args: "dark" }, host);
  assert.match(said.at(-1)!, /full-screen interface/);
  await runSlash({ name: "copy", args: "" }, host);
  assert.match(said.at(-1)!, /select the text/);
});

test("OSC 52: the sequence, and the terminals that would not take it", () => {
  assert.equal(osc52("hi"), "\u001b]52;c;aGk=\u0007");
  assert.equal(osc52Support({ TERM: "xterm-256color" }).ok, true);
  assert.equal(osc52Support({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" }).ok, false);
  assert.equal(osc52Support({ TERM: "linux" }).ok, false);
});

test("a saved conversation becomes transcript items", () => {
  const items = itemsFromMessages(
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "looking", tool_calls: [{ id: "c1", name: "read", arguments: "{}" }] },
      { role: "tool", tool_call_id: "c1", content: "file" },
      { role: "assistant", content: "done" },
    ],
    1,
  );
  assert.deepEqual(items.map((i) => i.kind), ["user", "assistant", "tool", "assistant"]);
});

// ---------------------------------------------------------------------------------------------------------------
// The whole application against an in-memory screen and a scripted agent
// ---------------------------------------------------------------------------------------------------------------

const k = (name: string, m: { ctrl?: boolean; alt?: boolean } = {}): Input => ({ type: "key", name, ctrl: Boolean(m.ctrl), alt: Boolean(m.alt), shift: false, ...(name.length === 1 && !m.ctrl && !m.alt ? { text: name } : {}) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test("the application: a turn with Markdown, a tool call put to the person and allowed with one key, a queued message, /copy, and leaving", async () => {
  const screen = createTestScreen(100, 30);
  let clock = 100_000;
  const tick = (ms: number) => {
    clock += ms;
    screen.advance(ms);
  };
  const runs: string[] = [];
  let app!: FullApp;
  const call: PendingCall = { id: "c1", tool: "bash", args: { command: "npm test" }, risk: "execute", summary: { title: "Run `npm test`", command: "npm test" } };
  let answer: Answer | null = null;
  const agent = {
    sessionId: "cli-test",
    model: "auto",
    setModel() {},
    messages: () => [],
    async *compact(): AsyncIterable<AgentEvent> {},
    async *run(text: string): AsyncIterable<AgentEvent> {
      runs.push(text);
      yield { type: "turn-start", session: "cli-test", model: "auto" };
      if (runs.length === 1) {
        yield { type: "text", delta: "## Plan\n\nRun the **tests**, then report.\n" };
        yield { type: "tool-call", call };
        answer = await app.ask(call, { verdict: "ask", reason: "Runs the test suite.", source: "classifier" }, null);
        yield { type: "tool-decision", id: "c1", decision: { verdict: "ask", reason: "Runs the test suite.", source: "classifier" }, answer };
        yield { type: "tool-result", id: "c1", tool: "bash", result: { content: "ok", display: { kind: "command", command: "npm test", exitCode: 0, output: "ok" } } };
        yield { type: "text", delta: "All **green**." };
      } else yield { type: "text", delta: `You said: ${text}` };
      yield { type: "usage", step: { input: 900, output: 100 }, session: { input: 900, output: 100 }, contextUsed: 20_000, contextLimit: 200_000 };
      yield { type: "turn-end", reason: "stop" };
    },
  };
  const session = {
    agent,
    gate: { mode: "auto", setMode() {} },
    models: [{ id: "auto", context: 200_000, output: null }],
    classifier: { model: "small" },
    contextLimit: () => 200_000,
    store: { list: () => [], load: () => null },
    cwd: "/w",
    tools: () => [],
    actions: () => false,
    newAgent() {},
  } as unknown as Session;
  const raw: string[] = [];
  app = new FullApp({
    screen,
    editor: new Editor(),
    session: () => session,
    host: () => ({
      model: () => agent.model,
      setModel() {},
      models: () => session.models,
      normaliseModel,
      mode: () => "auto",
      setMode() {},
      classifierOn: () => true,
      newSession() {},
      sessions: () => [],
      resume: () => false,
      tools: () => [],
      actions: () => false,
      setActions: async () => "",
      login: async () => {},
      logout: async () => false,
      update: async () => {},
      whoami: async () => {},
      now: () => new Date(),
    }),
    version: "0.2.1",
    cwd: "/w",
    organisation: "Analytical Engines",
    verbose: false,
    startNotices: ["memtro 9.1.0 is available (you have 0.2.1). Type /update."],
    pickResume: false,
    theme: "dark",
    noColour: false,
    listFiles: async () => ["a.ts"],
    writeRaw: (s) => raw.push(s),
    env: { TERM: "xterm-256color" },
    now: () => clock,
  });
  const done = app.run();
  assert.ok(screen.rows().some((r) => r.includes("Type /update.")), "the start screen's notice");
  tick(1000);
  for (const ch of "please test") screen.feed(ch === " " ? { type: "key", name: "space", text: " ", ctrl: false, alt: false, shift: false } : k(ch));
  tick(1000);
  screen.feed(k("enter"));
  await until(() => app.state.overlay.kind === "approval", "the approval panel");
  let rows = screen.rows();
  assert.ok(rows.some((r) => r.includes("Allow this?")));
  assert.ok(rows.some((r) => r.includes("$ npm test")));
  assert.ok(rows.some((r) => r.includes("waiting for you")));
  // Typed straight away (before the settle time): ignored.
  tick(10);
  screen.feed(k("y"));
  tick(60);
  await sleep(60);
  assert.equal(answer, null);
  // A deliberate key, later.
  tick(500);
  screen.feed(k("y"));
  tick(200);
  await until(() => answer !== null, "the answer");
  assert.deepEqual(answer, { kind: "once" });
  // While the turn finishes, a next message is queued (if it is still running) or sent.
  await until(() => !app.state.running, "the turn to end");
  rows = screen.rows();
  assert.ok(rows.some((r) => /\$ npm test +✓/.test(r)), rows.join("\n"));
  assert.ok(rows.some((r) => r.includes("All green.")));
  assert.ok(rows.some((r) => r.includes("▣ auto · 1k tokens")));
  assert.ok(!rows.some((r) => r.includes("**")), "Markdown is rendered, not shown");
  // /copy puts the last answer's source on the clipboard through the terminal.
  for (const ch of "/copy") screen.feed(k(ch));
  tick(100);
  screen.feed(k("enter"));
  await until(() => raw.length > 0, "the OSC 52 write");
  assert.equal(raw[0], osc52("All **green**."));
  // Leave with Ctrl-D at an empty prompt.
  screen.feed(k("d", { ctrl: true }));
  await done;
  assert.deepEqual(runs, ["please test"]);
});
