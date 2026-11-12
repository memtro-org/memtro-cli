import assert from "node:assert/strict";
import { test } from "node:test";
import { handleInput, type Effect, type KeyContext } from "../src/tui/full/app/keys.js";
import { createState, type AppState } from "../src/tui/full/app/state.js";
import { addUser, applyEvent, buildLayout, topLine } from "../src/tui/full/app/transcript.js";
import { draw, geometry, transcriptLayout } from "../src/tui/full/app/views.js";
import { Editor } from "../src/tui/full/editor.js";
import { createFrame } from "../src/tui/full/screen/frame.js";
import type { Input } from "../src/tui/full/types.js";

const kctx = (now = 10_000): KeyContext => ({
  now,
  menu: {
    host: {
      model: () => "auto",
      models: () => [{ id: "auto", context: 200_000, output: null }, { id: "anthropic/claude-sonnet-5", context: null, output: null }],
      mode: () => "auto",
      sessions: () => [],
      actions: () => false,
      now: () => new Date(),
    },
    files: ["src/cli.ts", "docs/a file.md"],
  },
});

function state(width = 100, height = 30): AppState {
  return createState({
    editor: new Editor(),
    width,
    height,
    status: { model: "auto", mode: "auto", organisation: null, tokens: null, contextUsed: null, contextLimit: null },
    version: "0.2.1",
    cwd: "/w",
  });
}

const key = (name: string, m: { ctrl?: boolean; alt?: boolean; shift?: boolean; text?: string } = {}): Input => ({
  type: "key",
  name,
  ctrl: Boolean(m.ctrl),
  alt: Boolean(m.alt),
  shift: Boolean(m.shift),
  ...(m.text !== undefined ? { text: m.text } : name.length === 1 && !m.ctrl && !m.alt ? { text: name } : {}),
});

/** Feeds inputs in order; returns the last state and every effect. */
function feed(s: AppState, inputs: (Input | string)[], now = 10_000): { state: AppState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const i of inputs) {
    const list: Input[] = typeof i === "string" ? Array.from(i).map((c) => (c === " " ? key("space", { text: " " }) : key(c))) : [i];
    for (const inp of list) {
      const r = handleInput(s, inp, kctx(now));
      s = r.state;
      effects.push(...r.effects);
    }
  }
  return { state: s, effects };
}

test("typing / opens the menu; Escape hides it and keeps the text; typing reopens it; Backspace over / closes it", () => {
  let { state: s } = feed(state(), ["/"]);
  assert.equal(s.overlay.kind, "menu");
  s = feed(s, [key("escape")]).state;
  assert.equal(s.menuDismissed, true);
  assert.equal(s.editor.text, "/");
  s = feed(s, ["m"]).state;
  assert.equal(s.menuDismissed, false);
  assert.equal(s.overlay.kind, "menu");
  s = feed(s, [key("backspace"), key("backspace")]).state;
  assert.equal(s.editor.text, "");
  assert.equal(s.overlay.kind, "none");
});

test("Tab completes the name (with a space when it takes an argument) and never runs anything", () => {
  let r = feed(state(), ["/mo", key("tab")]);
  assert.equal(r.state.editor.text, "/mode ");
  assert.deepEqual(r.effects, []);
  // With the argument's choices now listed, Tab completes the choice.
  r = feed(r.state, [key("down"), key("tab")]);
  assert.equal(r.state.editor.text, "/mode auto");
  assert.deepEqual(r.effects, []);
  // Commands that act never run from Tab.
  for (const name of ["logout", "update", "new", "quit"]) {
    const t = feed(state(), [`/${name}`, key("tab"), key("tab")]);
    assert.deepEqual(t.effects, [], `/${name} does not run from Tab`);
    assert.equal(t.state.editor.text, `/${name}`);
  }
});

test("Enter runs an exact command, or the single command a prefix names; otherwise completes one that takes an argument", () => {
  let r = feed(state(), ["/help", key("enter")]);
  assert.deepEqual(r.effects, [{ kind: "slash", line: "/help" }]);
  assert.equal(r.state.editor.text, "");
  r = feed(state(), ["/he", key("enter")]);
  assert.deepEqual(r.effects, [{ kind: "slash", line: "/help" }], "a prefix of a single command");
  r = feed(state(), ["/mo", key("enter")]);
  assert.deepEqual(r.effects, [], "/mo is a prefix of two: /mode takes an argument, so it is completed");
  assert.equal(r.state.editor.text, "/mode ");
  r = feed(r.state, [key("enter")]);
  assert.deepEqual(r.effects, [{ kind: "slash", line: "/mode ask" }], "Enter on a choice runs it");
  r = feed(state(), ["/model", key("enter")]);
  assert.deepEqual(r.effects, [{ kind: "slash", line: "/model" }]);
  r = feed(state(), ["/zzq", key("enter")]);
  assert.deepEqual(r.effects, [{ kind: "slash", line: "/zzq" }], "no match: sent as typed, and the command says it is unknown");
});

test("selection moves with Up/Down and Ctrl-P/Ctrl-N, wraps, and the window scrolls one row at a time", () => {
  let { state: s } = feed(state(), ["/"]);
  const menu = () => (s.overlay.kind === "menu" ? s.overlay.menu : null)!;
  s = feed(s, [key("up")]).state;
  assert.equal(menu().selected, menu().items.length - 1, "wraps to the last");
  assert.equal(menu().top, menu().items.length - 10);
  s = feed(s, [key("n", { ctrl: true })]).state;
  assert.equal(menu().selected, 0);
  assert.equal(menu().top, 0);
  for (let i = 0; i < 10; i++) s = feed(s, [key("down")]).state;
  assert.equal(menu().selected, 10);
  assert.equal(menu().top, 1, "one row at a time");
  s = feed(s, ["o"]).state;
  assert.equal(menu().selected, 0, "the first row is selected whenever the filter changes");
});

test("@ inserts a path; a path with a space is quoted", () => {
  let r = feed(state(), ["see @cl", key("tab")]);
  assert.equal(r.state.editor.text, "see src/cli.ts ");
  r = feed(state(), ["see @afile", key("enter")]);
  assert.equal(r.state.editor.text, 'see "docs/a file.md" ');
  assert.deepEqual(r.effects, []);
});

test("a message is sent; a leading space sends one starting with /", () => {
  assert.deepEqual(feed(state(), ["hello", key("enter")]).effects, [{ kind: "send", text: "hello" }]);
  const r = feed(state(), [key("space", { text: " " }), "/usr/bin is odd", key("escape"), key("enter")]);
  assert.deepEqual(r.effects, [{ kind: "send", text: " /usr/bin is odd" }]);
});

test("while a turn runs: Enter queues; Escape interrupts, a second Escape takes the queued message back", () => {
  let s: AppState = { ...state(), running: true };
  let r = feed(s, ["next thing", key("enter")]);
  assert.equal(r.state.queued, "next thing");
  assert.deepEqual(r.effects, []);
  const rows = (() => {
    const f = createFrame(r.state.width, r.state.height);
    draw(r.state, f);
    return f.rows();
  })();
  assert.ok(rows.some((row) => /esc interrupt.*queued/.test(row)), "the hint row says queued");
  r = feed(r.state, [key("escape")]);
  assert.deepEqual(r.effects, [{ kind: "interrupt" }]);
  assert.equal(r.state.queued, "next thing");
  r = feed(r.state, [key("escape")]);
  assert.equal(r.state.queued, null);
  assert.equal(r.state.editor.text, "next thing", "kept in the editor, not lost");
  s = r.state;
});

test("Ctrl-C: interrupts a turn; clears text; twice within two seconds at an empty prompt quits; Ctrl-D at an empty prompt quits", () => {
  assert.deepEqual(feed({ ...state(), running: true }, [key("c", { ctrl: true })]).effects, [{ kind: "interrupt" }]);
  let r = feed(state(), ["abc", key("c", { ctrl: true })]);
  assert.equal(r.state.editor.text, "");
  assert.deepEqual(r.effects, []);
  r = handleInput(r.state, key("c", { ctrl: true }), kctx(11_000)) as { state: AppState; effects: Effect[] };
  assert.deepEqual(r.effects, [{ kind: "quit" }]);
  r = handleInput(state(), key("c", { ctrl: true }), kctx(10_000)) as { state: AppState; effects: Effect[] };
  assert.deepEqual(r.effects, []);
  r = handleInput(r.state, key("c", { ctrl: true }), kctx(12_500)) as { state: AppState; effects: Effect[] };
  assert.deepEqual(r.effects, [], "too late: asks again");
  assert.deepEqual(feed(state(), [key("d", { ctrl: true })]).effects, [{ kind: "quit" }]);
  assert.deepEqual(feed(state(), ["x", key("d", { ctrl: true })]).effects, [], "Ctrl-D with text is not quit");
  assert.deepEqual(feed(state(), [key("l", { ctrl: true })]).effects, [{ kind: "repaint" }]);
});

function conversation(n: number, width = 100, height = 30): AppState {
  let s = state(width, height);
  for (let i = 0; i < n; i++) {
    s = addUser(s, `question ${i}`);
    s = applyEvent(s, { type: "text", delta: `answer ${i}\n\nwith a second paragraph that is long enough to wrap when the terminal is narrow, which it may be.` });
    s = applyEvent(s, { type: "turn-end", reason: "stop" });
  }
  return s;
}

test("scrolling: pinned to the bottom follows new content; scrolled up stays put and says newer is below; End returns", () => {
  let s = conversation(20);
  const g = geometry(s);
  const h = g.transcript!.height;
  let layout = transcriptLayout(s);
  assert.equal(topLine(layout, s.scroll, h), layout.total - h);
  s = feed(s, [key("pageup")]).state;
  assert.equal(s.scroll.pinned, false);
  layout = transcriptLayout(s);
  const before = topLine(layout, s.scroll, h);
  assert.equal(before, layout.total - h - (h - 1));
  s = applyEvent(addUser(s, "more"), { type: "text", delta: "more" });
  layout = transcriptLayout(s);
  assert.equal(topLine(layout, s.scroll, h), before, "new content does not move a view that was scrolled up");
  const f = createFrame(s.width, s.height);
  draw(s, f);
  assert.ok(f.rows().some((r) => r.includes("↓ newer")));
  s = feed(s, [key("end")]).state;
  assert.equal(s.scroll.pinned, true);
  s = feed(s, [key("g", { ctrl: true })]).state;
  assert.equal(topLine(transcriptLayout(s), s.scroll, h), 0);
  s = feed(s, [key("g", { ctrl: true, alt: true })]).state;
  assert.equal(s.scroll.pinned, true);
  s = feed(s, [key("u", { ctrl: true, alt: true })]).state;
  assert.equal(topLine(transcriptLayout(s), s.scroll, h), transcriptLayout(s).total - h - Math.floor(h / 2));
  s = feed(s, [{ type: "wheel", direction: "down", x: 1, y: 1 }]).state;
  assert.equal(topLine(transcriptLayout(s), s.scroll, h), transcriptLayout(s).total - h - Math.floor(h / 2) + 3);
});

test("resizing keeps the same item at the top of the view", () => {
  let s = conversation(30, 100, 30);
  s = feed(s, [key("pageup"), key("pageup")]).state;
  const anchor = s.scroll.anchor.key;
  assert.equal(s.scroll.pinned, false);
  const topItem = (st: AppState) => {
    const l = transcriptLayout(st);
    const t = topLine(l, st.scroll, geometry(st).transcript!.height);
    let i = 0;
    while (i + 1 < l.items.length && l.starts[i + 1]! <= t) i++;
    return l.items[i]!.key;
  };
  assert.equal(topItem(s), anchor);
  s = feed(s, [{ type: "resize", width: 52, height: 20 }]).state;
  assert.equal(topItem(s), anchor);
  s = feed(s, [{ type: "resize", width: 100, height: 30 }]).state;
  assert.equal(topItem(s), anchor);
});

test("a streaming answer re-renders only itself", () => {
  let s = conversation(50);
  const l1 = buildLayout(s.items, 96, false);
  const n = s.items.length;
  s = applyEvent(addUser(s, "q"), { type: "text", delta: "partial" });
  const l2 = buildLayout(s.items, 96, false);
  for (let i = 0; i < n; i++) assert.equal(l2.lines(i), l1.lines(i), "earlier items come from the cache");
  s = applyEvent(s, { type: "text", delta: " more" });
  const l3 = buildLayout(s.items, 96, false);
  for (let i = 0; i <= n; i++) assert.equal(l3.lines(i), l2.lines(i), "nothing before the answer is re-rendered");
  assert.notEqual(l3.lines(n + 1), l2.lines(n + 1), "the answer is");
});

test("5,000 items: a redraw stays quick", () => {
  let s = conversation(1700, 120, 36); // ~5,100 items with the footers
  assert.ok(s.items.length >= 5000);
  const f0 = createFrame(s.width, s.height);
  let t = performance.now();
  draw(s, f0);
  const first = performance.now() - t;
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    s = applyEvent(s, { type: "text", delta: " more words" });
    const f = createFrame(s.width, s.height);
    t = performance.now();
    draw(s, f);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const median = times[10]!;
  t = performance.now();
  draw({ ...s, width: 90 }, createFrame(90, s.height));
  const resized = performance.now() - t;
  process.stdout.write(`# 5,000-item transcript: first draw ${first.toFixed(1)} ms, redraw while streaming median ${median.toFixed(2)} ms, after a resize ${resized.toFixed(1)} ms\n`);
  assert.ok(median < 30, `redraw took ${median} ms`);
});
