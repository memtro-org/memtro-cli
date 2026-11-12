import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLD_MS } from "../src/tui/approval.js";
import { approvalGeometry, ApprovalPanel, drawApproval } from "../src/tui/full/app/approval.js";
import { enterAction, menuFor, tabAction } from "../src/tui/full/app/menu.js";
import { darkTheme } from "../src/tui/full/screen/colour.js";
import { diffFrame, initialWriterState } from "../src/tui/full/screen/diff.js";
import { createFrame } from "../src/tui/full/screen/frame.js";
import { clipboardText, FullApp, osc52 } from "../src/tui/full/run.js";
import { Editor } from "../src/tui/full/editor.js";
import { createTestScreen } from "../src/tui/full/screen/screen.js";
import type { Answer, Decision, PendingCall } from "../src/agent/types.js";
import type { Session } from "../src/session/start.js";
import { isControl } from "../src/tui/full/screen/width.js";
import type { Input } from "../src/tui/full/types.js";
import { parseSlash, SLASH_COMMANDS } from "../src/tui/slash.js";

/** Defects found in the 0.3.0 verification pass, each pinned. */

const ctx = {
  host: { model: () => "", models: () => null, mode: () => "auto" as const, sessions: () => [], actions: () => false, now: () => new Date(), theme: () => "dark" as const },
  files: [],
};

test("slash menu: a command that acts never runs from a description match or a shared prefix; Enter completes it first", () => {
  // "/rev" finds /logout only through its description ("Revoke this computer's key…").
  const rev = menuFor("/rev", ctx)!;
  assert.equal(rev.items[0]!.label, "/logout");
  assert.deepEqual(enterAction(rev, "/rev"), { kind: "complete", text: "/logout" });
  // "/lo" is a prefix of both /login and /logout.
  assert.deepEqual(enterAction(menuFor("/lo", ctx)!, "/lo"), { kind: "complete", text: "/login" });
  assert.deepEqual(enterAction(menuFor("/start", ctx)!, "/start"), { kind: "complete", text: "/new" });
  // Once completed, the name is exact and the next Enter runs exactly it.
  assert.deepEqual(enterAction(menuFor("/logout", ctx)!, "/logout"), { kind: "run", line: "/logout" });
  // A unique prefix of the name still runs, as the spec says; so does a command that only reads.
  assert.deepEqual(enterAction(menuFor("/upd", ctx)!, "/upd"), { kind: "run", line: "/update" });
  assert.deepEqual(enterAction(menuFor("/key", ctx)!, "/key"), { kind: "run", line: "/whoami" });
  // Every command typed exactly is the first row, and Enter runs that one and no other.
  for (const c of SLASH_COMMANDS) {
    const m = menuFor(`/${c.name}`, ctx)!;
    assert.equal(m.items[0]!.label, `/${c.name}`);
    assert.deepEqual(enterAction(m, `/${c.name}`), { kind: "run", line: `/${c.name}` });
    assert.notEqual(tabAction(m, `/${c.name}`).kind, "run", "Tab never runs anything");
  }
});

test("slash commands are one line: multi-line text that begins with a command's name is a message", () => {
  assert.equal(parseSlash("/logout\nwhy did the build fail?"), null);
  assert.equal(parseSlash("/actions on\nplease"), null);
  assert.deepEqual(parseSlash("/update\n"), { name: "update", args: "" }, "a trailing newline alone is still the one line");
  assert.deepEqual(parseSlash("/model  x "), { name: "model", args: "x" });
  // No menu opens for it either.
  assert.equal(menuFor("/logout\nmore", ctx), null);
});

test("approval panel: a body longer than the panel cannot be allowed until its end has been on screen", () => {
  const long = Array.from({ length: 80 }, (_, i) => `echo step ${i}`).join(" && ") + " && rm -rf ~/";
  const p = new ApprovalPanel(
    { id: "c1", tool: "bash", args: { command: long }, risk: "execute", summary: { title: "Run it", command: long } },
    { verdict: "ask", reason: "Ask mode: this is put to you.", source: "mode" },
    { kind: "command", command: long },
    true,
  );
  p.drawn(0);
  const key = (name: string): Input => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...(name.length === 1 ? { text: name } : {}) });
  // 40 body lines, 10 on screen: y and a allow nothing, and say why in the panel.
  assert.equal(p.input(key("y"), 1000, 1000, 10, 40).kind, "none");
  assert.equal(p.holding, false);
  assert.equal(p.input(key("a"), 3000, 1000, 10, 40).kind, "none");
  assert.equal(p.holding, false);
  const frame = createFrame(100, 30);
  const g = approvalGeometry(p.state, 2, 96, 24, 14);
  drawApproval(p.state, frame, g);
  assert.match(frame.rows().join("\n"), /↓ more below: read to the end to allow/);
  // Refusing needs no reading.
  const q = new ApprovalPanel(p.state.call, p.state.decision, null, true);
  q.drawn(0);
  q.input(key("n"), 1000, 1000, 10, 40);
  assert.equal(q.commit(1000 + HOLD_MS).kind, "answer");
  // Scrolled to the end (End), then after a pause, y allows.
  p.input(key("end"), 5000, 2000, 10, 40);
  assert.equal(p.state.endSeen, true);
  assert.equal(p.input(key("y"), 7000, 2000, 10, 40).kind, "none");
  assert.deepEqual(p.commit(7000 + HOLD_MS), { kind: "answer", answer: { kind: "once" }, interrupt: false });
  // A body that fits needs no scrolling.
  const r = new ApprovalPanel(p.state.call, p.state.decision, null, true);
  r.drawn(0);
  r.input(key("y"), 1000, 1000, 40, 40);
  assert.equal(r.commit(1000 + HOLD_MS).kind, "answer");
});

test("the screen writer never sends bidi controls or invisible format characters", () => {
  const f = createFrame(40, 1);
  f.text(0, 0, [{ text: "a‮b⁦c⁩d​e‏f؜g﻿h⁠i\u001b]52;c;eA==\u0007j" }], 40);
  const out = diffFrame(f, initialWriterState(), { theme: darkTheme, depth: "truecolor", sync: false });
  assert.doesNotMatch(out, /[‪-‮⁦-⁩​‎‏؜﻿⁠\u0007]/);
  assert.doesNotMatch(out, /\u001b\]52/);
  assert.match(f.rows()[0]!, /^abcdefghi\]52;c;eA==j/);
  // Joiners are kept: an emoji sequence still draws as one.
  assert.equal(isControl("‍"), false);
});

test("/copy never puts control characters on the clipboard (a pasted answer cannot end a bracketed paste and run)", () => {
  const hostile = "Run this:\n\n```sh\nls\u001b[201~rm -rf ~/\n```\r\nok\u0007\u009b\ttab\rhidden";
  const { text, removed } = clipboardText(hostile);
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.equal(text, "Run this:\n\n```sh\nls[201~rm -rf ~/\n```\nok\ttabhidden");
  assert.equal(removed, 4);
  assert.deepEqual(clipboardText("plain\n\ttext"), { text: "plain\n\ttext", removed: 0 });
  // The request itself carries only base64.
  assert.match(osc52(text), /^\u001b\]52;c;[A-Za-z0-9+/=]+\u0007$/);
});

test("full screen: a second approval while one is open is refused, never shown in place of the first", async () => {
  const screen = createTestScreen(100, 30);
  const agent = { sessionId: "cli-t", model: "auto", setModel() {}, messages: () => [], async *compact() {}, async *run() {} };
  const session = {
    agent,
    gate: { mode: "ask", setMode() {} },
    models: [],
    classifier: { model: null },
    contextLimit: () => 200_000,
    store: { list: () => [], load: () => null },
    cwd: "/w",
    tools: () => [],
    actions: () => false,
    newAgent() {},
  } as unknown as Session;
  const app = new FullApp({
    screen,
    editor: new Editor(),
    session: () => session,
    host: () => ({
      model: () => "auto", setModel() {}, models: () => [], normaliseModel: (x: string) => x, mode: () => "ask", setMode() {}, classifierOn: () => false,
      newSession() {}, sessions: () => [], resume: () => false, tools: () => [], actions: () => false, setActions: async () => "",
      login: async () => {}, logout: async () => false, update: async () => {}, whoami: async () => {}, now: () => new Date(),
    }),
    version: "0.3.0", cwd: "/w", organisation: null, verbose: false, startNotices: [], pickResume: false, theme: "dark", noColour: false,
    listFiles: async () => [], writeRaw: () => {}, env: { TERM: "xterm-256color" },
  });
  const done = app.run();
  const first: PendingCall = { id: "c1", tool: "bash", args: { command: "npm test" }, risk: "execute", summary: { title: "Run `npm test`", command: "npm test" } };
  const second: PendingCall = { id: "c2", tool: "bash", args: { command: "rm -rf ~/" }, risk: "execute", summary: { title: "Run `rm -rf ~/`", command: "rm -rf ~/" } };
  const ask: Decision = { verdict: "ask", reason: "Ask mode: this is put to you.", source: "mode" };
  let firstAnswer: Answer | null = null;
  void app.ask(first, ask, null).then((a) => (firstAnswer = a));
  const secondAnswer = await app.ask(second, ask, null);
  assert.equal(secondAnswer.kind, "deny");
  assert.ok(screen.rows().some((r) => r.includes("$ npm test")), `the first call is still the one shown:\n${screen.rows().join("\n")}`);
  assert.ok(!screen.rows().some((r) => r.includes("rm -rf")));
  screen.feed({ type: "key", name: "escape", ctrl: false, alt: false, shift: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(firstAnswer, { kind: "deny" });
  // A screen too small to show the whole panel: y allows nothing (Escape still refuses).
  screen.resize(40, 7);
  let third: Answer | null = null;
  void app.ask(first, ask, null).then((a) => (third = a));
  screen.rows();
  screen.advance(2000);
  await new Promise((r) => setTimeout(r, 400));
  screen.feed({ type: "key", name: "y", text: "y", ctrl: false, alt: false, shift: false });
  await new Promise((r) => setTimeout(r, HOLD_MS + 60));
  assert.equal(third, null, "not allowed on a panel the screen cannot show");
  screen.feed({ type: "key", name: "escape", ctrl: false, alt: false, shift: false });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(third, { kind: "deny" });
  app.leave();
  await done;
});

test("full screen: a message queued behind a turn the person stops is not sent by itself; it goes back into the input", async () => {
  const screen = createTestScreen(100, 30);
  const runs: string[] = [];
  const agent = {
    sessionId: "cli-q",
    model: "auto",
    setModel() {},
    messages: () => [],
    async *compact() {},
    async *run(text: string, signal: AbortSignal) {
      runs.push(text);
      yield { type: "turn-start" as const, session: "cli-q", model: "auto" };
      yield { type: "text" as const, delta: "working on it" };
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      yield { type: "turn-end" as const, reason: "interrupted" as const };
    },
  };
  const session = { agent, gate: { mode: "ask", setMode() {} }, models: [], classifier: { model: null }, contextLimit: () => 200_000, store: { list: () => [], load: () => null }, cwd: "/w", tools: () => [], actions: () => false, newAgent() {} } as unknown as Session;
  const editor = new Editor();
  const app = new FullApp({
    screen, editor, session: () => session,
    host: () => ({
      model: () => "auto", setModel() {}, models: () => [], normaliseModel: (x: string) => x, mode: () => "ask", setMode() {}, classifierOn: () => false,
      newSession() {}, sessions: () => [], resume: () => false, tools: () => [], actions: () => false, setActions: async () => "",
      login: async () => {}, logout: async () => false, update: async () => {}, whoami: async () => {}, now: () => new Date(),
    }),
    version: "0.3.0", cwd: "/w", organisation: null, verbose: false, startNotices: [], pickResume: false, theme: "dark", noColour: false,
    listFiles: async () => [], writeRaw: () => {}, env: { TERM: "xterm-256color" },
  });
  const done = app.run();
  const k = (name: string, text?: string): Input => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...(text ? { text } : {}) });
  for (const ch of "first") screen.feed(k(ch, ch));
  screen.feed(k("enter"));
  await new Promise((r) => setTimeout(r, 20));
  for (const ch of "second") screen.feed(k(ch, ch));
  screen.feed(k("enter"));
  assert.equal(app.state.queued, "second");
  screen.feed(k("escape"));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(runs, ["first"], "the queued message was not sent");
  assert.equal(editor.text, "second", "it is back in the input");
  assert.equal(app.state.queued, null);
  app.leave();
  await done;
});

test("full screen: a command queued behind a running turn runs as a command when the turn ends, never as a message", async () => {
  const screen = createTestScreen(100, 30);
  const runs: string[] = [];
  let finish = () => {};
  const agent = {
    sessionId: "cli-s",
    model: "auto",
    setModel() {},
    messages: () => [],
    async *compact() {},
    async *run(text: string) {
      runs.push(text);
      yield { type: "turn-start" as const, session: "cli-s", model: "auto" };
      await new Promise<void>((r) => (finish = r));
      yield { type: "turn-end" as const, reason: "stop" as const };
    },
  };
  const session = { agent, gate: { mode: "ask", setMode() {} }, models: [], classifier: { model: null }, contextLimit: () => 200_000, store: { list: () => [], load: () => null }, cwd: "/w", tools: () => [], actions: () => false, newAgent() {} } as unknown as Session;
  const app = new FullApp({
    screen, editor: new Editor(), session: () => session,
    host: () => ({
      model: () => "auto", setModel() {}, models: () => [], normaliseModel: (x: string) => x, mode: () => "ask", setMode() {}, classifierOn: () => false,
      newSession() {}, sessions: () => [], resume: () => false, tools: () => [], actions: () => false, setActions: async () => "",
      login: async () => {}, logout: async () => false, update: async () => {}, whoami: async () => {}, now: () => new Date(),
    }),
    version: "0.3.0", cwd: "/w", organisation: null, verbose: false, startNotices: [], pickResume: false, theme: "dark", noColour: false,
    listFiles: async () => [], writeRaw: () => {}, env: { TERM: "xterm-256color" },
  });
  const done = app.run();
  const k = (name: string, text?: string): Input => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...(text ? { text } : {}) });
  for (const ch of "go") screen.feed(k(ch, ch));
  screen.feed(k("enter"));
  await new Promise((r) => setTimeout(r, 20));
  for (const ch of "/help") screen.feed(k(ch, ch));
  screen.feed(k("escape")); // hide the menu, keep the text
  screen.feed(k("enter"));
  assert.equal(app.state.queued, "/help");
  finish();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(runs, ["go"], "/help was not sent to the model");
  assert.equal(app.state.overlay.kind, "dialog", "it opened the help");
  app.leave();
  await done;
});

test("full screen: started with --continue or --resume, the conversation carried on is on screen", async () => {
  const screen = createTestScreen(100, 30);
  const messages = [
    { role: "user" as const, content: "fix the build please" },
    { role: "assistant" as const, content: "The build is fixed: a missing import." },
  ];
  const agent = { sessionId: "cli-r", model: "auto", setModel() {}, messages: () => messages, async *compact() {}, async *run() {} };
  const session = { agent, gate: { mode: "ask", setMode() {} }, models: [], classifier: { model: null }, contextLimit: () => 200_000, store: { list: () => [], load: () => null }, cwd: "/w", tools: () => [], actions: () => false, newAgent() {} } as unknown as Session;
  const app = new FullApp({
    screen, editor: new Editor(), session: () => session,
    host: () => ({
      model: () => "auto", setModel() {}, models: () => [], normaliseModel: (x: string) => x, mode: () => "ask", setMode() {}, classifierOn: () => false,
      newSession() {}, sessions: () => [], resume: () => false, tools: () => [], actions: () => false, setActions: async () => "",
      login: async () => {}, logout: async () => false, update: async () => {}, whoami: async () => {}, now: () => new Date(),
    }),
    version: "0.3.0", cwd: "/w", organisation: null, verbose: false, startNotices: [], pickResume: false, theme: "dark", noColour: false,
    listFiles: async () => [], writeRaw: () => {}, env: { TERM: "xterm-256color" },
  });
  const done = app.run();
  assert.equal(app.state.view, "conversation");
  const rows = screen.rows().join("\n");
  assert.match(rows, /fix the build please/);
  assert.match(rows, /The build is fixed: a missing import\./);
  app.leave();
  await done;
});
