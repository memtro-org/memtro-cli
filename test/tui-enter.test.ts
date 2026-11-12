/**
 * An unmarked paste ending in a newline does not send: the Enter rule (src/tui/enter.ts) at the decoder and editor
 * level of both interfaces, with an injected clock throughout.
 */
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { Decision, PendingCall } from "../src/agent/types.js";
import { HOLD_MS } from "../src/tui/approval.js";
import { applyEnterRule, BURST_NEWLINE, ChunkArrivals, EnterRule, PASTE_ENTER_MS, type Arrival } from "../src/tui/enter.js";
import { ApprovalPanel } from "../src/tui/full/app/approval.js";
import { dialogInput, openDialog } from "../src/tui/full/app/dialog.js";
import { handleInput, type Effect, type KeyContext } from "../src/tui/full/app/keys.js";
import { createState, type AppState } from "../src/tui/full/app/state.js";
import { Editor } from "../src/tui/full/editor.js";
import { InputDecoder } from "../src/tui/full/screen/input.js";
import { createTestScreen } from "../src/tui/full/screen/screen.js";
import type { Input } from "../src/tui/full/types.js";
import { Composer, readOneLine } from "../src/tui/input.js";

const ENTER: Input = { type: "key", name: "enter", ctrl: false, alt: false, shift: false };
const ch = (c: string): Input => (c === " " ? { type: "key", name: "space", text: " ", ctrl: false, alt: false, shift: false } : { type: "key", name: c.toLowerCase(), text: c, ctrl: false, alt: false, shift: c !== c.toLowerCase() });

// ---------------------------------------------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------------------------------------------

/** [what happens, chunks as (arrivals, ms since the previous chunk), the expected verdicts per chunk] */
const RULE: [string, [Arrival[], number][], boolean[][]][] = [
  ["a lone Enter sends", [[["enter"], 0]], [[true]]],
  ["typed text, then Enter on its own later, sends", [[["text", "text"], 0], [["enter"], 200]], [[], [true]]],
  ["Enter in the same chunk after text is a newline", [[["text", "text", "enter"], 0]], [[false]]],
  ["Enter in the same chunk before text is a newline", [[["enter", "text"], 0]], [[false]]],
  ["two Enters in one chunk are newlines", [[["enter", "enter"], 0]], [[false, false]]],
  ["Enter within the window after text is a newline", [[["text"], 0], [["enter"], PASTE_ENTER_MS - 1]], [[], [false]]],
  ["Enter at the window's end sends", [[["text"], 0], [["enter"], PASTE_ENTER_MS]], [[], [true]]],
  ["a paste in chunks: the burst carries on through an Enter-only chunk", [[["text", "enter"], 0], [["enter"], 5], [["enter"], 5]], [[false], [false], [false]]],
  ["after a burst, a second Enter on its own sends", [[["text", "text", "enter"], 0], [["enter"], 400]], [[false], [true]]],
  ["other input (an arrow, a resize) does not make a burst", [[["other"], 0], [["enter"], 1]], [[], [true]]],
  ["other input in the same chunk does not either", [[["other", "enter"], 0]], [[true]]],
];

test("EnterRule: a lone Enter sends; one with text in its chunk, with another Enter, or just after text, is a newline", () => {
  for (const [what, chunks, expected] of RULE) {
    const rule = new EnterRule();
    let at = 1000;
    const got = chunks.map(([events, gap]) => {
      at += gap;
      return rule.judge(events, at);
    });
    assert.deepEqual(got, expected, what);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Full screen: the decoder's inputs, then the application
// ---------------------------------------------------------------------------------------------------------------

/** Each chunk through the real decoder and the rule, at the given gaps; the inputs the application would get. */
function decode(chunks: [string, number][]): Input[][] {
  const decoder = new InputDecoder();
  const rule = new EnterRule();
  let at = 1000;
  return chunks.map(([bytes, gap]) => {
    at += gap;
    return applyEnterRule(rule, [...decoder.feed(bytes), ...decoder.flush()], at);
  });
}

const names = (inputs: Input[]) => inputs.map((i) => (i.type === "key" ? `${i.ctrl ? "C-" : ""}${i.shift ? "S-" : ""}${i.name}` : i.type)).join(" ");

test("full screen decoder: every form of Enter is judged alike, and CR LF is one line end", () => {
  const cases: [string, [string, number][], string[]][] = [
    ["lone CR", [["\r", 0]], ["enter"]],
    ["typed text and CR in one chunk", [["ls\r", 0]], ["l s C-j"]],
    ["kitty keyboard protocol Enter, alone and after text", [["\x1b[13u", 0], ["ab\x1b[13u", 500]], ["enter", "a b C-j"]],
    ["kitty keypad Enter after text", [["1\x1b[57414u", 0]], ["1 C-j"]],
    ["modifyOtherKeys Enter, alone and after text", [["\x1b[27;1;13~", 0], ["x\x1b[27;1;13~", 500]], ["enter", "x C-j"]],
    ["application keypad Enter after text", [["x\x1bOM", 0]], ["x C-j"]],
    ["Shift+Enter is already a newline and is left alone", [["a\x1b[13;2u", 0]], ["a S-enter"]],
    ["a CR LF paste: one newline per line", [["a\r\nb\r\n", 0]], ["a C-j b C-j"]],
    ["a bare CR paste", [["a\rb\r", 0]], ["a C-j b C-j"]],
    ["a paste that is only newlines", [["\r\r", 0]], ["C-j C-j"]],
    ["a lone CR LF is one Enter, not an Enter and a newline", [["\r\n", 0]], ["enter"]],
    ["the Enter of a paste split across chunks", [["some text", 0], ["\r", 3]], ["s o m e space t e x t", "C-j"]],
    ["a marked paste is unchanged, and an Enter in its chunk is a newline", [["\x1b[200~x\ny\x1b[201~", 0], ["\x1b[200~z\x1b[201~\r", 500]], ["paste", "paste C-j"]],
    ["an Enter long after a marked paste sends", [["\x1b[200~x\x1b[201~", 0], ["\r", 500]], ["paste", "enter"]],
  ];
  for (const [what, chunks, expected] of cases) assert.deepEqual(decode(chunks).map(names), expected, what);
  assert.deepEqual(BURST_NEWLINE, { type: "key", name: "j", ctrl: true, alt: false, shift: false });
});

const kctx = (now: number): KeyContext => ({
  now,
  menu: {
    host: { model: () => "auto", models: () => [{ id: "auto", context: 200_000, output: null }], mode: () => "auto", sessions: () => [], actions: () => false, now: () => new Date() },
    files: [],
  },
});

function appState(): AppState {
  return createState({
    editor: new Editor(),
    width: 100,
    height: 30,
    status: { model: "auto", mode: "auto", organisation: null, tokens: null, contextUsed: null, contextLimit: null },
    version: "0.3.0",
    cwd: "/w",
  });
}

/** Raw chunks through the test screen (the real decoder and the rule, on its fake clock) into the application. */
function app(start: AppState = appState()) {
  const screen = createTestScreen(100, 30);
  let state = start;
  const effects: Effect[] = [];
  let clock = 0;
  screen.onInput((input) => {
    const r = handleInput(state, input, kctx(clock));
    state = r.state;
    effects.push(...r.effects);
  });
  return {
    type(bytes: string, after: number) {
      clock += after;
      screen.advance(after);
      screen.feedBytes(bytes);
    },
    get state() {
      return state;
    },
    effects,
  };
}

test("full screen: a pasted line ending in a newline is not sent; Enter on its own then sends it without the newline", () => {
  const a = app();
  a.type("ls -la\r", 1000);
  assert.deepEqual(a.effects, [], "nothing sent");
  assert.equal(a.state.editor.text, "ls -la\n", "the newline is in the input");
  a.type("\r", 400);
  assert.deepEqual(a.effects, [{ kind: "send", text: "ls -la" }]);
  // A fast typist whose Enter arrives just after the last key (a coalescing link) gets the same: Enter again sends.
  const b = app();
  for (const c of "hi") b.type(c, 120);
  b.type("\r", PASTE_ENTER_MS - 1);
  assert.deepEqual(b.effects, []);
  b.type("\r", 300);
  assert.deepEqual(b.effects, [{ kind: "send", text: "hi" }]);
  // Typed at a person's speed, Enter sends at once.
  const c = app();
  for (const x of "ok") c.type(x, 120);
  c.type("\r", 150);
  assert.deepEqual(c.effects, [{ kind: "send", text: "ok" }]);
});

test("full screen: a paste in the slash menu never runs a command", () => {
  const a = app();
  a.type("/new\r", 1000);
  assert.deepEqual(a.effects, [], "the menu's choice did not run");
  assert.equal(a.state.editor.text, "/new\n");
  // A CR LF paste of several commands: nothing runs.
  const b = app();
  b.type("/logout\r\n/new\r\n", 1000);
  assert.deepEqual(b.effects, []);
});

test("full screen: a paste while a turn runs is not queued; Enter on its own queues it", () => {
  const a = app({ ...appState(), running: true });
  a.type("next thing\r", 1000);
  assert.equal(a.state.queued, null);
  a.type("\r", 500);
  assert.equal(a.state.queued, "next thing");
});

test("full screen: a paste into a dialog's search field never chooses a row", () => {
  const rows = [{ id: "a", label: "alpha" }, { id: "b", label: "beta" }];
  let d = openDialog({ kind: "choice", title: "Pick", rows });
  for (const input of decode([["alp\r", 0]])[0]!) {
    const r = dialogInput(d, input, 10);
    assert.equal(r.result.kind, "none", `${names([input])} chose nothing`);
    d = r.dialog;
  }
  assert.equal(d.query, "alp");
  assert.equal(dialogInput(d, decode([["\r", 0]])[0]![0]!, 10).result.kind, "choose", "Enter on its own chooses");
});

test("full screen: a paste into the approval note never sends it", () => {
  const call: PendingCall = { id: "c1", tool: "bash", args: { command: "npm test" }, risk: "execute", summary: { title: "Run `npm test`", command: "npm test" } };
  const ask: Decision = { verdict: "ask", reason: "x", source: "classifier" };
  const p = new ApprovalPanel(call, ask, null, true);
  p.drawn(0);
  p.input(ch("e"), 2000, 2000, 10, 10);
  assert.equal(p.commit(2000 + HOLD_MS).kind, "none");
  assert.equal(p.state.note, "");
  const [burst, lone] = decode([["use pnpm\r", 0], ["\r", 500]]);
  for (const input of burst!) assert.equal(p.input(input, 3000, 0, 10, 10).kind, "none", `${names([input])} sent nothing`);
  assert.equal(p.state.note, "use pnpm");
  assert.deepEqual(p.input(lone![0]!, 3500, 500, 10, 10), { kind: "answer", answer: { kind: "deny", note: "The person's note: use pnpm" }, interrupt: false });
});

// ---------------------------------------------------------------------------------------------------------------
// Inline: raw chunks to arrivals, then the readline prompt
// ---------------------------------------------------------------------------------------------------------------

test("inline chunks: line ends counted the way readline counts them; paste marks and escape sequences are not Enters", () => {
  const c = new ChunkArrivals();
  assert.deepEqual(c.of("\r"), ["enter"]);
  assert.deepEqual(c.of("\n"), ["enter"]);
  assert.deepEqual(c.of("a\r\nb"), ["text", "enter", "text"]);
  assert.deepEqual(c.of("\r\r"), ["enter", "enter"]);
  assert.deepEqual(c.of("\t"), ["text"]);
  assert.deepEqual(c.of("\x1b[A\r"), ["other", "enter"]);
  assert.deepEqual(c.of("\x1b"), ["other"]);
  assert.deepEqual(c.of("\x1b[200~a\nb"), ["text"], "inside a paste");
  assert.equal(c.touchedPaste, true);
  assert.deepEqual(c.of("c\r"), ["text"], "still inside it");
  assert.deepEqual(c.of("d\x1b[201~\r"), ["text", "enter"], "after its end mark");
  assert.deepEqual(c.of("\r"), ["enter"]);
  assert.equal(c.touchedPaste, false);
});

function tty() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new Writable({ write: (_c, _e, cb) => cb() });
  return { input, output };
}
const delivered = () => new Promise<void>((r) => setImmediate(r));

/** An inline prompt on a fake terminal and clock: `type` writes a chunk `after` ms after the last one. */
function inline() {
  const { input, output } = tty();
  let clock = 1000;
  const composer = new Composer({ input, output, historyPath: null, prompt: "› ", continuation: "… ", hint: (t) => t, now: () => clock });
  return {
    composer,
    async type(bytes: string, after: number) {
      clock += after;
      input.write(bytes);
      await delivered();
    },
  };
}

test("inline: a pasted line ending in a newline is not sent; Enter on its own sends it without the newline", async () => {
  const p = inline();
  let sent: string | null | undefined;
  void p.composer.read().then((v) => (sent = v));
  await p.type("ls -la\r", 1000);
  assert.equal(sent, undefined, "nothing sent");
  await p.type("\r", 400);
  assert.equal(sent, "ls -la");

  // CR LF and bare CR pastes keep their lines.
  let second: string | null | undefined;
  void p.composer.read().then((v) => (second = v));
  await p.type("a\r\nb\r\n", 1000);
  await p.type("c\rd\r", 2);
  assert.equal(second, undefined);
  await p.type("\r", 500);
  assert.equal(second, "a\nb\nc\nd");

  // A fast typist: Enter just after the last key is a newline; Enter again sends.
  let third: string | null | undefined;
  void p.composer.read().then((v) => (third = v));
  await p.type("h", 1000);
  await p.type("i", 120);
  await p.type("\r", PASTE_ENTER_MS - 1);
  assert.equal(third, undefined);
  await p.type("\r", 300);
  assert.equal(third, "hi");

  // Typed at a person's speed, Enter sends at once; a marked paste is as before.
  let fourth: string | null | undefined;
  void p.composer.read().then((v) => (fourth = v));
  await p.type("ok", 1000);
  await p.type("\r", 150);
  assert.equal(fourth, "ok");
  let fifth: string | null | undefined;
  void p.composer.read().then((v) => (fifth = v));
  await p.type("\x1b[200~x\ny\x1b[201~", 1000);
  await p.type("\r", 300);
  assert.equal(fifth, "x\ny");
});

test("inline: a one-line field (the approval note, a number from a list) is not sent by a paste; piped input is unchanged", async () => {
  const { input, output } = tty();
  let clock = 1000;
  let note: string | undefined;
  void readOneLine(input, output, "note: ", () => clock).then((v) => (note = v));
  input.write("use pnpm\r");
  await delivered();
  assert.equal(note, undefined, "the pasted line did not send the note");
  input.write("\x1b[200~instead\nof npm\x1b[201~");
  await delivered();
  assert.equal(note, undefined, "nor did a marked paste's newline");
  clock += 500;
  input.write("\r");
  await delivered();
  assert.equal(note, "use pnpm instead of npm");

  const piped = new PassThrough();
  let line: string | undefined;
  void readOneLine(piped, output, "").then((v) => (line = v));
  piped.write("2\nmore\n");
  await delivered();
  assert.equal(line, "2", "not a terminal: the first line, as before");
});
