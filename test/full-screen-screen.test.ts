import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { darkTheme, lightTheme } from "../src/tui/full/screen/colour.js";
import { createScreen, createTestScreen, ENTER_ALT, LEAVE_ALT, QUERIES } from "../src/tui/full/screen/screen.js";
import type { Input } from "../src/tui/full/types.js";
import { guardTerminal, RESTORE } from "../src/tui/terminal.js";

const ESC = "\u001b";

function fakeStreams(cols = 80, rows = 24, opts: { failWrites?: boolean } = {}) {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (on: boolean) => raw.push(on),
    resume: () => {},
    pause: () => {},
  });
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: cols,
    rows,
    getWindowSize() {
      return [stdout.columns, stdout.rows];
    },
    write(s: string) {
      if (opts.failWrites) {
        const e = new Error("write EPIPE") as NodeJS.ErrnoException;
        e.code = "EPIPE";
        throw e;
      }
      writes.push(s);
      return true;
    },
  });
  return {
    writes,
    raw,
    stdin,
    stdout,
    streams: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream },
    type: (s: string) => stdin.emit("data", Buffer.from(s, "latin1")),
  };
}

const env = { TERM: "xterm-256color", COLORTERM: "truecolor" };
const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("screen: start enters every mode and asks its questions; stop leaves exactly those; both idempotent", () => {
  const t = fakeStreams();
  const s = createScreen(t.streams, { theme: darkTheme, mouse: true, env });
  s.start();
  s.start();
  const started = t.writes.join("");
  assert.equal(started, `${ENTER_ALT}${ESC}[?25l${ESC}[?7l${ESC}[?2004h${ESC}[?1004h${ESC}[?1000h${ESC}[?1006h${QUERIES}`);
  assert.deepEqual(t.raw, [true]);
  t.writes.length = 0;
  s.stop();
  s.stop();
  assert.equal(t.writes.join(""), `${ESC}[?1006l${ESC}[?1000l${ESC}[?1004l${ESC}[?2004l${ESC}[0m${ESC}[?7h${ESC}[?25h${LEAVE_ALT}`);
  assert.deepEqual(t.raw, [true, false]);
});

test("screen: without mouse, no mouse modes either way", () => {
  const t = fakeStreams();
  const s = createScreen(t.streams, { theme: darkTheme, mouse: false, env });
  s.start();
  s.stop();
  assert.ok(!t.writes.join("").includes("?1000"));
  assert.ok(!t.writes.join("").includes("?1006"));
});

test("screen: granted keyboard protocol and sync are used and undone; replies never reach the application", async () => {
  const t = fakeStreams();
  const s = createScreen(t.streams, { theme: darkTheme, mouse: false, env });
  const inputs: Input[] = [];
  s.onInput((i) => inputs.push(i));
  let bg: string | null = null;
  s.onBackground((b) => (bg = b));
  s.onDraw((f) => f.text(0, 0, [{ text: "hi" }], 10));
  s.start();
  t.type(`${ESC}[?0u${ESC}[?2026;2$y${ESC}]11;rgb:ffff/ffff/ffff${ESC}\\${ESC}[?62;22c`);
  assert.deepEqual(inputs, []);
  assert.equal(bg, "light");
  assert.equal(s.background, "light");
  assert.deepEqual(s.capabilities, { sync: true, kittyKeyboard: true });
  assert.ok(t.writes.includes(`${ESC}[>1u`));
  await tick();
  await wait(20);
  const frame = t.writes.find((w) => w.includes("hi"));
  assert.ok(frame && frame.startsWith(`${ESC}[?2026h`) && frame.endsWith(`${ESC}[?2026l`));
  t.writes.length = 0;
  s.stop();
  assert.ok(t.writes.join("").startsWith(`${ESC}[<u`), "the keyboard protocol is popped before leaving the alternate screen");
});

test("screen: invalidations coalesce and draws are capped", async () => {
  const t = fakeStreams();
  const s = createScreen(t.streams, { theme: darkTheme, mouse: false, env });
  let draws = 0;
  let n = 0;
  s.onDraw((f) => {
    draws++;
    f.text(0, 0, [{ text: String(n) }], 10);
  });
  s.start();
  t.type(`${ESC}[?62c`); // DA1: probing over
  for (let i = 0; i < 100; i++) s.invalidate();
  await tick();
  await wait(5);
  assert.equal(draws, 1);
  const start = Date.now();
  while (Date.now() - start < 160) {
    n++;
    s.invalidate();
    await wait(1);
  }
  await wait(30);
  assert.ok(draws <= 1 + Math.ceil(190 / 16) + 1, `${draws} draws in ~160ms`);
  s.stop();
});

test("screen: a burst of keys reads as a burst; a single key reads its quiet time", async () => {
  const t = fakeStreams();
  const s = createScreen(t.streams, { theme: darkTheme, mouse: false, env });
  const seen: number[] = [];
  s.onInput(() => seen.push(s.sinceInput()));
  s.start();
  await wait(40);
  t.type("y");
  t.type("yn");
  s.stop();
  assert.ok(seen[0]! >= 30, `quiet before a lone key: ${seen[0]}`);
  assert.deepEqual(seen.slice(1), [0, 0]);
});

test("screen: a lone Escape arrives after a short wait", async () => {
  const t = fakeStreams();
  const s = createScreen(t.streams, { theme: darkTheme, mouse: false, env });
  const inputs: Input[] = [];
  s.onInput((i) => inputs.push(i));
  s.start();
  t.type(ESC);
  assert.deepEqual(inputs, []);
  await wait(80);
  assert.deepEqual(inputs, [{ type: "key", name: "escape", ctrl: false, alt: false, shift: false }]);
  s.stop();
});

test("screen: resize delivers an input and repaints in full; a zero-size terminal draws nothing and does not throw", async () => {
  const t = fakeStreams(40, 10);
  const s = createScreen(t.streams, { theme: darkTheme, mouse: false, env });
  const inputs: Input[] = [];
  s.onInput((i) => inputs.push(i));
  s.onDraw((f) => f.text(0, 0, [{ text: `${f.width}x${f.height}` }], f.width));
  s.start();
  t.type(`${ESC}[?62c`);
  await wait(20);
  t.stdout.columns = 50;
  t.stdout.rows = 12;
  t.stdout.emit("resize");
  assert.deepEqual(inputs, [{ type: "resize", width: 50, height: 12 }]);
  t.writes.length = 0;
  await wait(25);
  assert.ok(t.writes.join("").includes("50x12"));
  t.stdout.columns = 0;
  t.stdout.rows = 0;
  t.stdout.emit("resize");
  await wait(25);
  s.stop();
});

test("screen: a terminal that has gone ends the screen quietly", () => {
  const t = fakeStreams(80, 24, { failWrites: true });
  const s = createScreen(t.streams, { theme: darkTheme, mouse: false, env });
  let closed = false;
  s.onClose(() => (closed = true));
  assert.doesNotThrow(() => s.start());
  assert.ok(closed);
  assert.doesNotThrow(() => s.stop());
});

test("screen: Ctrl-Z leaves every mode before stopping; continuing restores them and repaints in full", async () => {
  if (process.platform === "win32") return;
  const t = fakeStreams(20, 3);
  const s = createScreen(t.streams, { theme: darkTheme, mouse: true, env });
  s.onDraw((f) => f.text(0, 0, [{ text: "visible" }], 20));
  const kills: string[] = [];
  const realKill = process.kill;
  // the real SIGTSTP would stop the test runner: record it instead
  process.kill = ((pid: number, sig?: string | number) => {
    kills.push(String(sig));
    return true;
  }) as typeof process.kill;
  try {
    s.start();
    t.type(`${ESC}[?62c`);
    await wait(25);
    assert.ok(t.writes.join("").includes("visible"));
    t.writes.length = 0;
    t.type("\x1a"); // Ctrl-Z
    assert.deepEqual(kills, ["SIGTSTP"]);
    const left = t.writes.join("");
    assert.ok(left.includes(LEAVE_ALT) && left.includes(`${ESC}[?1000l`) && left.includes(`${ESC}[?2004l`), "every mode is left before stopping");
    assert.equal(t.raw.at(-1), false, "raw mode is off while stopped");
    t.writes.length = 0;
    s.invalidate();
    await wait(25);
    assert.equal(t.writes.join(""), "", "nothing is drawn while stopped");
    process.emit("SIGCONT");
    assert.equal(t.raw.at(-1), true);
    await wait(25);
    const back = t.writes.join("");
    assert.ok(back.startsWith(`${ENTER_ALT}${ESC}[?25l`) && back.includes(`${ESC}[?1000h`), "the modes are entered again");
    assert.ok(back.includes("visible"), "and the whole frame is repainted, not just what changed");
  } finally {
    process.kill = realKill;
    s.stop();
  }
});

test("screen: the terminal guard restores the screen on every way out", () => {
  const t = fakeStreams();
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const exits: number[] = [];
  const proc = {
    on: (ev: string, fn: (...a: unknown[]) => void) => handlers.set(ev, fn),
    off: (ev: string) => handlers.delete(ev),
    listenerCount: () => 1,
    exit: (code: number) => exits.push(code),
  };
  const guard = guardTerminal(t.streams.stdin as never, t.streams.stdout, proc as never, { write: () => true } as never);
  const s = createScreen(t.streams, { theme: darkTheme, mouse: true, env });
  s.start();
  t.writes.length = 0;
  handlers.get("SIGTERM")!();
  const out = t.writes.join("");
  assert.ok(out.includes(LEAVE_ALT) && out.includes(`${ESC}[?1000l`), "the screen's modes are left");
  assert.ok(out.indexOf(LEAVE_ALT) < out.indexOf(RESTORE), "before the guard's own restore");
  assert.deepEqual(exits, [143]);
  // once stopped it is no longer registered
  t.writes.length = 0;
  handlers.get("exit")!();
  assert.ok(!t.writes.join("").includes(LEAVE_ALT));
  guard.dispose();
});

test("test screen: draws on demand, reads cells, feeds inputs with timing", () => {
  const s = createTestScreen(20, 3);
  const got: Array<[Input, number]> = [];
  s.onInput((i) => got.push([i, s.sinceInput()]));
  s.onDraw((f) => {
    f.fill({ x: 0, y: 1, width: 20, height: 1 }, "panel");
    f.text(1, 1, [{ text: "selected", style: { fg: "onAccent", bg: "accent", bold: true } }], 18);
    f.cursor = { x: 2, y: 1 };
  });
  assert.equal(s.rows()[1], " selected           ");
  assert.equal(s.cellAt(1, 1)!.bg, "accent");
  assert.equal(s.cellAt(1, 1)!.bold, true);
  assert.equal(s.cellAt(0, 1)!.bg, "panel");
  assert.equal(s.draws, 1);
  s.rows();
  assert.equal(s.draws, 1, "no draw without an invalidate");
  s.invalidate();
  s.rows();
  assert.equal(s.draws, 2);
  assert.equal(s.lastFrameBytes, 0, "an identical frame writes nothing");
  s.advance(500);
  s.feed({ type: "key", name: "y", text: "y", ctrl: false, alt: false, shift: false });
  s.feedBytes("ab");
  assert.equal(got[0]![1], 500);
  assert.deepEqual(got.slice(1).map((g) => g[1]), [0, 0]);
  s.setTheme(lightTheme);
  assert.equal(s.theme.name, "light");
  s.resize(10, 2);
  assert.equal(s.rows().length, 2);
});
