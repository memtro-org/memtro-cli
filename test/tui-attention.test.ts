import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { AgentEvent, Answer, PendingCall, Risk } from "../src/agent/types.js";
import { parseCommandLine } from "../src/args.js";
import { notifySetting } from "../src/commands/chat.js";
import { mainHelp } from "../src/commands/help.js";
import { interfaceSettings } from "../src/config.js";
import { normaliseModel, type Session } from "../src/session/start.js";
import {
  approvalMessage,
  Attention,
  attentionBytes,
  attentionChannel,
  BEL,
  FINISHED_MESSAGE,
  ITERM_CLEAR,
  ITERM_WAITING,
  LONG_TURN_MS,
  NOTIFY_MAX,
  notificationText,
  UNKNOWN_FOCUS_MS,
  type Channel,
} from "../src/tui/attention.js";
import { createTtyApprover } from "../src/tui/approval.js";
import { Editor } from "../src/tui/full/editor.js";
import { KeyRouter } from "../src/tui/keys.js";
import { style } from "../src/tui/style.js";
import { FullApp } from "../src/tui/full/run.js";
import { createTestScreen } from "../src/tui/full/screen/screen.js";
import type { Input } from "../src/tui/full/types.js";

const ESC = "\u001b";

test("the channel: chosen from the environment and the setting", () => {
  const cases: Array<[string, NodeJS.ProcessEnv, "auto" | "bell" | "off", Channel]> = [
    ["iTerm2 by TERM_PROGRAM", { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }, "auto", "iterm2"],
    ["iTerm2 by LC_TERMINAL (also over ssh)", { TERM: "xterm-256color", LC_TERMINAL: "iTerm2" }, "auto", "iterm2"],
    ["iTerm2 by ITERM_SESSION_ID", { TERM: "xterm-256color", ITERM_SESSION_ID: "w0t0p0:1" }, "auto", "iterm2"],
    ["iTerm2, bell asked for", { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }, "bell", "bell"],
    ["iTerm2, off", { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }, "off", "none"],
    ["tmux inside iTerm2: the bell (tmux swallows OSC 9)", { TERM: "tmux-256color", TERM_PROGRAM: "tmux", LC_TERMINAL: "iTerm2", TMUX: "/tmp/tmux-1/default,1,0" }, "auto", "bell"],
    ["GNU screen", { TERM: "screen-256color", STY: "1.pts", KITTY_WINDOW_ID: "1" }, "auto", "bell"],
    ["kitty", { TERM: "xterm-kitty", KITTY_WINDOW_ID: "1" }, "auto", "kitty"],
    ["Ghostty", { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" }, "auto", "osc9"],
    ["WezTerm", { TERM: "xterm-256color", TERM_PROGRAM: "WezTerm" }, "auto", "osc9"],
    ["Terminal.app", { TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" }, "auto", "bell"],
    ["VS Code", { TERM: "xterm-256color", TERM_PROGRAM: "vscode", VSCODE_INJECTION: "1" }, "auto", "bell"],
    ["Windows Terminal (OSC 9 there is ConEmu's: progress, cwd)", { TERM: "xterm-256color", WT_SESSION: "x" }, "auto", "bell"],
    ["anything else", { TERM: "xterm-256color" }, "auto", "bell"],
    ["TERM=dumb", { TERM: "dumb", TERM_PROGRAM: "iTerm.app" }, "auto", "none"],
  ];
  for (const [what, env, setting, want] of cases) assert.equal(attentionChannel(env, setting), want, what);
});

test("the bytes: exactly what each terminal is sent", () => {
  const msg = approvalMessage("execute");
  assert.equal(msg, "memtro needs you: allow it to run a command?");
  assert.equal(attentionBytes("iterm2", msg, { waiting: true }), `${ESC}]9;memtro needs you: allow it to run a command?${ESC}\\${ESC}]21337;status=waiting;indicator=#5f87ff;status-color=#5f87ff${ESC}\\`);
  assert.equal(attentionBytes("iterm2", FINISHED_MESSAGE), `${ESC}]9;memtro has finished and is waiting for you${ESC}\\`);
  assert.equal(attentionBytes("kitty", msg), `${ESC}]99;;memtro needs you: allow it to run a command?${ESC}\\`);
  assert.equal(attentionBytes("osc9", msg), `${ESC}]9;memtro needs you: allow it to run a command?${ESC}\\`);
  assert.equal(attentionBytes("bell", msg), "\u0007");
  assert.equal(attentionBytes("none", msg), "");
  assert.equal(ITERM_CLEAR, `${ESC}]21337;status=;indicator=;status-color=${ESC}\\`);
  const what: Record<Risk, string> = { execute: "run a command", write: "change a file", read: "read a file", "remote-read": "read from Memtro", "remote-act": "act in a connected system" };
  for (const [risk, words] of Object.entries(what)) assert.equal(approvalMessage(risk as Risk), `memtro needs you: allow it to ${words}?`);
});

/** One OSC sequence, whole: starts with ESC ], ends with ST, and has no other ESC, BEL or C1 control in it. */
function assertOneSequence(bytes: string, prefix: string): void {
  assert.ok(bytes.startsWith(`${ESC}]${prefix}`), JSON.stringify(bytes));
  assert.ok(bytes.endsWith(`${ESC}\\`), JSON.stringify(bytes));
  const body = bytes.slice(2, -2);
  assert.doesNotMatch(body, /[\u0000-\u001f\u007f-\u009f]/, `a control inside the sequence: ${JSON.stringify(bytes)}`);
}

test("injection: a BEL, ESC \\, an 8-bit ST or a whole OSC in the text cannot end our sequence or start one", () => {
  const hostile = [
    "rm -rf ~\u0007\u001b]9;pwned\u0007",
    "a\u001b\\\u001b]52;c;cHduZWQ=\u001b\\",
    "8-bit ST \u009c and OSC \u009d 9;x \u009c",
    "line one\nline two\r\u001b[2J\u001b[H",
    "bidi ‮ gnp.exe and zero​width",
    "DEL\u007f and NUL\u0000",
  ];
  for (const h of hostile) {
    const text = notificationText(h);
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/, JSON.stringify(text));
    for (const [channel, prefix] of [["iterm2", "9;"], ["kitty", "99;;"], ["osc9", "9;"]] as const) {
      const bytes = attentionBytes(channel, `memtro needs you: ${h}`);
      assertOneSequence(bytes, prefix);
      assert.equal(bytes.split(ESC).length - 1, 2, `exactly one ESC ] and one ESC \\: ${JSON.stringify(bytes)}`);
      assert.ok(!bytes.includes(BEL), "no BEL anywhere: it would end the string");
    }
  }
  // The controls are shown, not dropped silently: a person can see something was there.
  assert.match(notificationText("a\u0007b"), /a␇b/);
  // Long text is cut.
  const long = notificationText("x".repeat(500));
  assert.equal(Array.from(long).length, NOTIFY_MAX);
  assert.ok(long.endsWith("…"));
  // OSC 9 whose text starts with a number is read as ConEmu's progress (9;4) or other numbered commands; ours
  // always starts with "memtro".
  for (const risk of ["execute", "write", "read", "remote-read", "remote-act"] as Risk[]) assert.match(attentionBytes("iterm2", approvalMessage(risk)), /^\u001b\]9;memtro /);
});

/** An Attention with a fake timer and everything it writes. */
function harness(env: NodeJS.ProcessEnv, setting: "auto" | "bell" | "off" = "auto") {
  const written: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const a = new Attention({
    setting,
    env,
    write: (b) => written.push(b),
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
  });
  const fire = () => {
    for (const t of timers.splice(0)) if (t.live) t.fn();
  };
  return { a, written, timers, fire };
}

const ITERM = { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" };
const ITERM_APPROVAL = attentionBytes("iterm2", approvalMessage("execute"), { waiting: true });

test("when: unfocused signals at once, once; answering takes the status off the tab", () => {
  const { a, written } = harness(ITERM);
  a.setFocus(false);
  a.approvalOpened("execute");
  assert.deepEqual(written, [ITERM_APPROVAL]);
  // Focus going back and forth, while the same approval stays open, signals nothing more.
  a.setFocus(true);
  a.setFocus(false);
  assert.deepEqual(written, [ITERM_APPROVAL]);
  a.approvalClosed();
  assert.deepEqual(written, [ITERM_APPROVAL, ITERM_CLEAR]);
  a.approvalClosed();
  assert.equal(written.length, 2, "cleared once");
});

test("when: focused, nothing until the person looks away while it is still open; answered first, nothing at all", () => {
  const { a, written, timers } = harness(ITERM);
  a.setFocus(true);
  a.approvalOpened("write");
  assert.deepEqual(written, []);
  assert.equal(timers.length, 0, "no timer when the terminal says it is focused");
  a.setFocus(false);
  assert.deepEqual(written, [attentionBytes("iterm2", approvalMessage("write"), { waiting: true })]);
  a.approvalClosed();
  assert.equal(written.at(-1), ITERM_CLEAR);

  const b = harness(ITERM);
  b.a.setFocus(true);
  b.a.approvalOpened("execute");
  b.a.approvalClosed();
  b.a.setFocus(false);
  assert.deepEqual(b.written, [], "answered while looking: no signal, and no status to clear");
});

test("when: focus never reported, the approval signals after it has waited a while, and not if it was answered first", () => {
  const { a, written, timers, fire } = harness(ITERM);
  a.approvalOpened("execute");
  assert.deepEqual(written, []);
  assert.equal(timers[0]!.ms, UNKNOWN_FOCUS_MS);
  fire();
  assert.deepEqual(written, [ITERM_APPROVAL]);
  fire();
  assert.equal(written.length, 1);
  a.dispose();
  assert.deepEqual(written, [ITERM_APPROVAL, ITERM_CLEAR], "leaving clears the status");

  const b = harness(ITERM);
  b.a.approvalOpened("execute");
  b.a.approvalClosed();
  b.fire();
  assert.deepEqual(b.written, []);

  const c = harness(ITERM);
  c.a.approvalOpened("execute");
  c.a.setFocus(true);
  c.fire();
  assert.deepEqual(c.written, [], "the terminal said it is focused after all");
});

test("when: the bell terminals get one bell and nothing to clear; off sends nothing", () => {
  const { a, written } = harness({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" });
  a.setFocus(false);
  a.approvalOpened("execute");
  a.approvalClosed();
  assert.deepEqual(written, ["\u0007"]);

  const off = harness(ITERM, "off");
  off.a.setFocus(false);
  off.a.approvalOpened("execute");
  off.a.turnFinished(60_000);
  off.a.approvalClosed();
  off.fire();
  assert.deepEqual(off.written, []);
});

test("when: a finished turn signals only when long and the terminal said it is not focused", () => {
  const { a, written } = harness(ITERM);
  a.turnFinished(LONG_TURN_MS * 3);
  assert.deepEqual(written, [], "focus unknown");
  a.setFocus(true);
  a.turnFinished(LONG_TURN_MS * 3);
  assert.deepEqual(written, [], "focused");
  a.setFocus(false);
  a.turnFinished(LONG_TURN_MS - 1);
  assert.deepEqual(written, [], "short");
  a.turnFinished(LONG_TURN_MS);
  assert.deepEqual(written, [attentionBytes("iterm2", FINISHED_MESSAGE)]);
});

test("the setting: notify in config.json, --no-notify, and --help", () => {
  assert.deepEqual(interfaceSettings({ version: 1, profiles: {}, notify: "bell" }), { notify: "bell" });
  assert.deepEqual(interfaceSettings({ version: 1, profiles: {}, notify: "off" }), { notify: "off" });
  assert.throws(() => interfaceSettings({ version: 1, profiles: {}, notify: false }), /notify must be "auto", "bell" or "off"; got false/);
  assert.throws(() => interfaceSettings({ version: 1, profiles: {}, notify: "on" }), /notify must be/);
  const p = parseCommandLine(["--no-notify"]);
  assert.equal(p.flags["no-notify"], true);
  assert.equal(notifySetting({ flags: p.flags }, { notify: "bell" }), "off", "the flag wins");
  assert.equal(notifySetting({ flags: {} }, { notify: "bell" }), "bell");
  assert.equal(notifySetting({ flags: {} }, {}), "auto");
  assert.throws(() => parseCommandLine(["run", "--no-notify", "x"]), /Unknown option '--no-notify'/, "not an option of memtro run");
  assert.match(mainHelp(), /--no-notify/);
});

// ---------------------------------------------------------------------------------------------------------------
// The full-screen application: the bytes go out through writeRaw, once, and the panel's rules are unchanged
// ---------------------------------------------------------------------------------------------------------------

const k = (name: string): Input => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...(name.length === 1 ? { text: name } : {}) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test("the full screen: an approval while the terminal is unfocused writes the signal once, outside the frames, and answering clears it", async () => {
  const screen = createTestScreen(100, 30);
  let clock = 100_000;
  const tick = (ms: number) => {
    clock += ms;
    screen.advance(ms);
  };
  let app!: FullApp;
  const call: PendingCall = { id: "c1", tool: "bash", args: { command: "echo \u0007\u001b\\hi" }, risk: "execute", summary: { title: "Run `echo \u0007\u001b\\hi`", command: "echo \u0007\u001b\\hi" } };
  let answer: Answer | null = null;
  const agent = {
    sessionId: "cli-test",
    model: "auto",
    setModel() {},
    messages: () => [],
    async *compact(): AsyncIterable<AgentEvent> {},
    async *run(): AsyncIterable<AgentEvent> {
      yield { type: "turn-start", session: "cli-test", model: "auto" };
      yield { type: "tool-call", call };
      answer = await app.ask(call, { verdict: "ask", reason: "Echoes.", source: "classifier" }, null);
      yield { type: "tool-decision", id: "c1", decision: { verdict: "ask", reason: "Echoes.", source: "classifier" }, answer };
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
    version: "0.3.0",
    cwd: "/w",
    organisation: null,
    verbose: false,
    startNotices: [],
    pickResume: false,
    theme: "dark",
    noColour: false,
    listFiles: async () => [],
    writeRaw: (s) => raw.push(s),
    env: { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" },
    now: () => clock,
  });
  const done = app.run();
  tick(1000);
  screen.feed(k("x"));
  tick(1000);
  screen.feed(k("enter"));
  // The person looks away (the terminal reports focus out) while it works.
  screen.feed({ type: "focus", focused: false });
  await until(() => app.state.overlay.kind === "approval", "the approval panel");
  assert.deepEqual(raw, [ITERM_APPROVAL], "signalled once, with no part of the command in it");
  const framesBefore = screen.output;
  assert.ok(!framesBefore.includes("]9;"), "never part of a frame");
  // Redraws, a resize and focus coming and going while the same panel is open: nothing more.
  screen.frame();
  screen.resize(90, 28);
  screen.frame();
  screen.feed({ type: "focus", focused: true });
  screen.feed({ type: "focus", focused: false });
  screen.frame();
  assert.deepEqual(raw, [ITERM_APPROVAL]);
  // The panel's own rules are untouched: a deliberate key, after the wait the focus and resize events restarted, answers.
  tick(1000);
  screen.feed(k("y"));
  tick(200);
  await until(() => answer !== null, "the answer");
  assert.deepEqual(answer, { kind: "once" });
  assert.deepEqual(raw, [ITERM_APPROVAL, ITERM_CLEAR]);
  await until(() => !app.state.running, "the turn to end");
  assert.equal(raw.length, 2, "a short turn ending signals nothing");
  screen.feed({ type: "key", name: "d", ctrl: true, alt: false, shift: false });
  await done;
});

test("the inline approval: the signal after the prompt, the status cleared when it is answered, the key rules unchanged", async () => {
  let clock = 10_000;
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const order: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      order.push(`prompt:${String(chunk).includes("Allow this?")}`);
      cb();
    },
  });
  const h = harness(ITERM);
  const attention = { approvalOpened: (r: Risk) => (order.push("opened"), h.a.approvalOpened(r)), approvalClosed: () => (order.push("closed"), h.a.approvalClosed()) } as unknown as Attention;
  h.a.setFocus(false);
  const router = new KeyRouter(input, () => clock);
  const holds: Array<() => void> = [];
  const approver = createTtyApprover({ output, router, style: style(false), classifierOn: () => true, readNote: async () => "", now: () => clock, setTimer: (fn) => (holds.push(fn), () => {}), attention });
  const call: PendingCall = { id: "c1", tool: "bash", args: { command: "x" }, risk: "execute", summary: { title: "Run `x`", command: "x" } };
  const pending = approver.ask(call, { verdict: "ask", reason: "r", source: "classifier" }, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order.slice(0, 2), ["prompt:true", "opened"]);
  assert.deepEqual(h.written, [ITERM_APPROVAL]);
  // Typed within the settle time: ignored as before.
  clock += 10;
  input.write("y");
  await new Promise((r) => setImmediate(r));
  assert.equal(holds.length, 0);
  clock += 1000;
  input.write("n");
  await new Promise((r) => setImmediate(r));
  holds.shift()!();
  assert.deepEqual(await pending, { kind: "deny" });
  assert.deepEqual(h.written, [ITERM_APPROVAL, ITERM_CLEAR]);
  router.detach();
});
