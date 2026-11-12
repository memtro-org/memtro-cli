import { writeSync } from "node:fs";
import { onRestore } from "../../terminal.js";
import type { ColourDepth, Frame, Input, Screen, Theme } from "../types.js";
import { darkTheme, detectDepth, isDarkBackground, parseOscColour } from "./colour.js";
import { diffFrame, initialWriterState } from "./diff.js";
import { CellFrame, type Cell } from "./frame.js";
import { InputDecoder, type Reply } from "./input.js";
import { applyEnterRule, EnterRule } from "../../enter.js";

/**
 * The full screen: the alternate screen, raw keys, and a frame painted by difference.
 *
 * `start` enters every mode the interface uses and `stop` leaves exactly those, synchronously, so it can run from an
 * exit or signal handler; it is registered with the terminal guard (src/tui/terminal.ts) while the screen is up, so a
 * crash or a signal restores the terminal through the one guard. Writes never throw: a terminal that has gone
 * (EPIPE, EIO) ends the screen quietly.
 *
 * Repaints are coalesced: any number of `invalidate` calls make one draw on the next tick, and draws are at most
 * one per FRAME_MS, so a fast token stream cannot flood the terminal.
 */

const ESC = "\u001b";
export const FRAME_MS = 16;
/** How long a lone ESC waits for the rest of a sequence before it is the Escape key. */
export const ESCAPE_MS = 40;
/** How long a paste may go quiet before it is ended without its end mark. */
export const PASTE_IDLE_MS = 1500;
/** How long `start` waits for the terminal to answer its questions before painting anyway. */
export const PROBE_MS = 200;

export const ENTER_ALT = `${ESC}[?1049h`;
export const LEAVE_ALT = `${ESC}[?1049l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const WRAP_OFF = `${ESC}[?7l`;
const WRAP_ON = `${ESC}[?7h`;
const PASTE_ON = `${ESC}[?2004h`;
const PASTE_OFF = `${ESC}[?2004l`;
const FOCUS_ON = `${ESC}[?1004h`;
const FOCUS_OFF = `${ESC}[?1004l`;
/** Button events (the wheel is buttons 4 and 5) in SGR encoding: no motion tracking. */
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;
/** Kitty keyboard protocol, "disambiguate escape codes" only (flag 1): Escape, Alt and Shift+Enter become unambiguous. */
const KITTY_PUSH = `${ESC}[>1u`;
const KITTY_POP = `${ESC}[<u`;
const RESET = `${ESC}[0m`;
/** Kitty flags query, synchronized-output mode query, background colour query, then DA1 (answered last by everyone). */
export const QUERIES = `${ESC}[?u${ESC}[?2026$p${ESC}]11;?${ESC}\\${ESC}[c`;

export interface ScreenOptions {
  theme: Theme;
  mouse: boolean;
  env: NodeJS.ProcessEnv;
}

/** The screen plus what the application may want beyond the contract. */
export interface FullScreen extends Screen {
  readonly theme: Theme;
  /** What the terminal said its background is (OSC 11), or null when it has not said. */
  readonly background: "dark" | "light" | null;
  /** What the terminal granted. */
  readonly capabilities: { sync: boolean; kittyKeyboard: boolean };
  /** Called once when the terminal answers the background question. */
  onBackground(cb: (bg: "dark" | "light") => void): void;
  /** Called when the screen ends by itself (the terminal went away). */
  onClose(cb: () => void): void;
  setTheme(theme: Theme): void;
  /** Leaves the screen and stops the process (Ctrl-Z); on continue everything is restored and repainted. */
  suspend(): void;
  /** Bytes written by the last draw, for measurement. */
  readonly lastFrameBytes: number;
}

type TtyIn = NodeJS.ReadStream;
type TtyOut = NodeJS.WriteStream;

interface Writer {
  write(s: string): void;
  writeNow(s: string): void;
}

function makeWriter(out: TtyOut, onDead: () => void): Writer {
  let dead = false;
  const fail = () => {
    if (dead) return;
    dead = true;
    onDead();
  };
  out.on?.("error", fail);
  return {
    write(s: string) {
      if (dead || !s) return;
      try {
        out.write(s);
      } catch {
        fail();
      }
    },
    /** Synchronous where the stream has a descriptor: for stop() from an exit or signal handler. */
    writeNow(s: string) {
      if (dead || !s) return;
      const fd = (out as unknown as { fd?: unknown }).fd;
      if (typeof fd === "number" && out.isTTY) {
        try {
          writeSync(fd, s);
          return;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "EAGAIN") {
            fail();
            return;
          }
        }
      }
      try {
        out.write(s);
      } catch {
        fail();
      }
    },
  };
}

export function createScreen(streams: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream }, options: ScreenOptions): FullScreen {
  const stdin = streams.stdin as TtyIn;
  const stdout = streams.stdout as TtyOut;
  const depth: ColourDepth = detectDepth(options.env, stdout);
  let theme = options.theme;
  const size = () => {
    const s = typeof stdout.getWindowSize === "function" ? safeSize(stdout) : null;
    return { w: s?.[0] ?? stdout.columns ?? 80, h: s?.[1] ?? stdout.rows ?? 24 };
  };
  let { w: width, h: height } = size();

  let started = false;
  let suspended = false;
  let closed = false;
  let probing = false;
  let sync = false;
  let kitty = false;
  let kittyPushed = false;
  let background: "dark" | "light" | null = null;
  let lastFrameBytes = 0;
  let drawFn: ((f: Frame) => void) | null = null;
  const inputHandlers: Array<(i: Input) => void> = [];
  const bgHandlers: Array<(bg: "dark" | "light") => void> = [];
  const closeHandlers: Array<() => void> = [];
  const state = initialWriterState();
  let lastInputAt = Date.now();
  let gapNow: number | null = null;
  let scheduled: NodeJS.Timeout | NodeJS.Immediate | null = null;
  let lastDrawAt = 0;
  let dirty = false;
  let escTimer: NodeJS.Timeout | null = null;
  let pasteTimer: NodeJS.Timeout | null = null;
  let probeTimer: NodeJS.Timeout | null = null;
  let unregister: (() => void) | null = null;

  const writer = makeWriter(stdout, () => {
    // The terminal is gone: nothing more can be written. End quietly.
    closed = true;
    teardown(false);
    for (const cb of closeHandlers) cb();
  });

  const onReply = (r: Reply) => {
    switch (r.kind) {
      case "kitty-flags":
        if (!kitty && started && !suspended) {
          kitty = true;
          kittyPushed = true;
          writer.write(KITTY_PUSH);
        }
        break;
      case "mode":
        if (r.mode === 2026 && (r.value === 1 || r.value === 2)) sync = true;
        break;
      case "osc":
        if (r.code === 11) {
          const c = parseOscColour(r.body);
          if (c && background === null) {
            background = isDarkBackground(c) ? "dark" : "light";
            for (const cb of bgHandlers) cb(background);
          }
        }
        break;
      case "da1":
        probeDone();
        break;
    }
  };
  const decoder = new InputDecoder(onReply);
  // An Enter that is part of a burst of input (an unmarked paste) is a newline, not a send: see enter.ts.
  const enterRule = new EnterRule();

  function probeDone() {
    if (!probing) return;
    probing = false;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    invalidate();
  }

  function dispatch(inputs: Input[], gap: number) {
    gapNow = inputs.length > 1 ? 0 : gap;
    try {
      for (const input of inputs) {
        if (input.type === "key" && input.ctrl && input.name === "z" && !input.alt && process.platform !== "win32") {
          suspend();
          continue;
        }
        for (const h of inputHandlers) h(input);
      }
    } finally {
      gapNow = null;
    }
  }

  const onData = (chunk: Buffer | string) => {
    const now = Date.now();
    const gap = now - lastInputAt;
    lastInputAt = now;
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const inputs = applyEnterRule(enterRule, decoder.feed(data), now);
    armTimers();
    if (inputs.length) dispatch(inputs, gap);
  };

  function armTimers() {
    if (escTimer) clearTimeout(escTimer);
    escTimer = null;
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = null;
    const p = decoder.pending;
    if (p === "escape" || p === "partial") {
      escTimer = setTimeout(() => {
        escTimer = null;
        const inputs = applyEnterRule(enterRule, decoder.flush(), Date.now());
        if (inputs.length) dispatch(inputs, Date.now() - lastInputAt);
      }, ESCAPE_MS);
      escTimer.unref?.();
    } else if (p === "paste") {
      pasteTimer = setTimeout(() => {
        pasteTimer = null;
        const inputs = applyEnterRule(enterRule, decoder.endPaste(), Date.now());
        if (inputs.length) dispatch(inputs, Date.now() - lastInputAt);
      }, PASTE_IDLE_MS);
      pasteTimer.unref?.();
    }
  }

  function checkSize(): boolean {
    const s = size();
    if (s.w === width && s.h === height) return false;
    width = s.w;
    height = s.h;
    state.shown = null;
    return true;
  }

  const onResize = () => {
    if (!started || suspended) return;
    if (!checkSize()) return;
    dispatch([{ type: "resize", width: Math.max(0, width), height: Math.max(0, height) }], Date.now() - lastInputAt);
    invalidate();
  };

  function enterModes() {
    let s = ENTER_ALT + HIDE + WRAP_OFF + PASTE_ON + FOCUS_ON;
    if (options.mouse) s += MOUSE_ON;
    if (kittyPushed) s += KITTY_PUSH;
    writer.writeNow(s);
    state.shown = null;
    state.cursorVisible = false;
    state.cursorAt = null;
  }

  /** Exactly what `enterModes` (and a granted keyboard protocol) turned on, off again. */
  function leaveModes(): string {
    let s = "";
    if (kittyPushed) s += KITTY_POP;
    if (options.mouse) s += MOUSE_OFF;
    s += FOCUS_OFF + PASTE_OFF + RESET + WRAP_ON + SHOW + LEAVE_ALT;
    return s;
  }

  function setRaw(on: boolean) {
    try {
      if (stdin.isTTY) stdin.setRawMode?.(on);
    } catch {
      // the stream may be closed
    }
  }

  const onTstp = () => suspend();
  const onCont = () => {
    if (!started) return;
    if (suspended) {
      suspended = false;
      process.on("SIGTSTP", onTstp);
    }
    setRaw(true);
    enterModes();
    checkSize();
    state.shown = null;
    invalidate();
  };

  function suspend() {
    if (!started || suspended || closed) return;
    suspended = true;
    writer.writeNow(leaveModes());
    setRaw(false);
    process.off("SIGTSTP", onTstp);
    try {
      process.kill(process.pid, "SIGTSTP");
    } catch {
      // cannot stop: carry on as if continued
      onCont();
    }
  }

  function start() {
    if (started || closed) return;
    started = true;
    setRaw(true);
    stdin.on("data", onData);
    stdin.resume?.();
    stdout.on?.("resize", onResize);
    if (process.platform !== "win32") {
      process.on("SIGWINCH", onResize);
      process.on("SIGTSTP", onTstp);
      process.on("SIGCONT", onCont);
    }
    unregister = onRestore(stop);
    checkSize();
    enterModes();
    probing = true;
    writer.writeNow(QUERIES);
    probeTimer = setTimeout(probeDone, PROBE_MS);
    probeTimer.unref?.();
    invalidate();
  }

  function teardown(write: boolean) {
    if (!started) return;
    started = false;
    for (const t of [escTimer, pasteTimer, probeTimer]) if (t) clearTimeout(t);
    escTimer = pasteTimer = probeTimer = null;
    if (scheduled) {
      clearTimeout(scheduled as NodeJS.Timeout);
      clearImmediate(scheduled as NodeJS.Immediate);
    }
    scheduled = null;
    if (write && !suspended) writer.writeNow(leaveModes());
    suspended = false;
    kittyPushed = false;
    setRaw(false);
    stdin.off?.("data", onData);
    stdin.pause?.();
    stdout.off?.("resize", onResize);
    if (process.platform !== "win32") {
      process.off("SIGWINCH", onResize);
      process.off("SIGTSTP", onTstp);
      process.off("SIGCONT", onCont);
    }
    unregister?.();
    unregister = null;
  }

  function stop() {
    teardown(true);
  }

  function invalidate() {
    dirty = true;
    if (!started || suspended || closed || scheduled) return;
    const wait = Math.max(0, lastDrawAt + FRAME_MS - Date.now());
    scheduled = wait > 0 ? setTimeout(draw, wait) : setImmediate(draw);
  }

  function draw() {
    scheduled = null;
    if (!started || suspended || closed || probing) return;
    if (!dirty) return;
    dirty = false;
    lastDrawAt = Date.now();
    if (width < 1 || height < 1) return;
    const frame = new CellFrame(width, height, "page");
    drawFn?.(frame);
    const out = diffFrame(frame, state, { theme, depth, sync });
    lastFrameBytes = Buffer.byteLength(out);
    writer.write(out);
  }

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    depth,
    get theme() {
      return theme;
    },
    get background() {
      return background;
    },
    get capabilities() {
      return { sync, kittyKeyboard: kitty };
    },
    get lastFrameBytes() {
      return lastFrameBytes;
    },
    start,
    stop,
    invalidate,
    suspend,
    onDraw(fn) {
      drawFn = fn;
    },
    onInput(fn) {
      inputHandlers.push(fn);
    },
    onBackground(cb) {
      bgHandlers.push(cb);
      if (background) cb(background);
    },
    onClose(cb) {
      closeHandlers.push(cb);
    },
    setTheme(t) {
      theme = t;
      state.shown = null;
      invalidate();
    },
    sinceInput() {
      return gapNow ?? Date.now() - lastInputAt;
    },
  };
}

function safeSize(out: TtyOut): [number, number] | null {
  try {
    const s = out.getWindowSize();
    return Array.isArray(s) && s.length === 2 ? [s[0], s[1]] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// In memory, for tests
// ---------------------------------------------------------------------------------------------------------------

export interface TestScreen extends FullScreen {
  /**
   * Delivers inputs as one arrival (more than one: a burst, so `sinceInput()` is 0 for each). As on the real screen,
   * an Enter in the same arrival as typed text, or less than `PASTE_ENTER_MS` of the fake clock after it, is a newline.
   */
  feed(...inputs: Input[]): void;
  /** Delivers raw bytes through the real decoder as one chunk (then flushes a lone ESC). */
  feedBytes(bytes: string | Buffer): void;
  /** Moves the fake clock that `sinceInput` reads. */
  advance(ms: number): void;
  resize(width: number, height: number): void;
  /** Draws now if anything asked for it, and returns the last frame. */
  frame(): CellFrame;
  /** The last frame's rows as text. */
  rows(): string[];
  /** The last frame's cell at x,y (style roles and attributes). */
  cellAt(x: number, y: number): Cell | undefined;
  /** How many draws have happened. */
  readonly draws: number;
  /** Every byte the differ produced, in order (what a terminal would have received). */
  readonly output: string;
}

export function createTestScreen(width: number, height: number, options: { theme?: Theme; depth?: ColourDepth } = {}): TestScreen {
  let w = width;
  let h = height;
  let theme = options.theme ?? darkTheme;
  const depth = options.depth ?? "truecolor";
  let clock = 0;
  let lastInputAt = 0;
  let gapNow: number | null = null;
  let drawFn: ((f: Frame) => void) | null = null;
  const handlers: Array<(i: Input) => void> = [];
  const bgHandlers: Array<(bg: "dark" | "light") => void> = [];
  let dirty = true;
  let draws = 0;
  let output = "";
  let lastFrameBytes = 0;
  let last = new CellFrame(w, h, "page");
  const state = initialWriterState();
  const decoder = new InputDecoder();
  const enterRule = new EnterRule();

  /** One arrival, as the real screen delivers it: an Enter that is part of a burst is a newline (enter.ts). */
  const dispatch = (arrived: Input[]) => {
    const inputs = applyEnterRule(enterRule, arrived, clock);
    const gap = clock - lastInputAt;
    lastInputAt = clock;
    gapNow = inputs.length > 1 ? 0 : gap;
    try {
      for (const i of inputs) for (const fn of handlers) fn(i);
    } finally {
      gapNow = null;
    }
  };

  const drawNow = () => {
    dirty = false;
    draws++;
    const f = new CellFrame(w, h, "page");
    if (w > 0 && h > 0) drawFn?.(f);
    last = f;
    const out = diffFrame(f, state, { theme, depth, sync: true });
    lastFrameBytes = Buffer.byteLength(out);
    output += out;
  };
  const frame = () => {
    if (dirty) drawNow();
    return last;
  };

  return {
    get width() {
      return w;
    },
    get height() {
      return h;
    },
    depth,
    get theme() {
      return theme;
    },
    background: null,
    capabilities: { sync: true, kittyKeyboard: false },
    get lastFrameBytes() {
      return lastFrameBytes;
    },
    get draws() {
      return draws;
    },
    get output() {
      return output;
    },
    start() {},
    stop() {},
    suspend() {},
    invalidate() {
      dirty = true;
    },
    onDraw(fn) {
      drawFn = fn;
      dirty = true;
    },
    onInput(fn) {
      handlers.push(fn);
    },
    onBackground(cb) {
      bgHandlers.push(cb);
    },
    onClose() {},
    setTheme(t) {
      theme = t;
      state.shown = null;
      dirty = true;
    },
    sinceInput() {
      return gapNow ?? clock - lastInputAt;
    },
    feed(...inputs) {
      dispatch(inputs);
    },
    feedBytes(bytes) {
      const inputs = [...decoder.feed(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes), ...decoder.flush()];
      if (inputs.length) dispatch(inputs);
    },
    advance(ms) {
      clock += ms;
    },
    resize(nw, nh) {
      w = nw;
      h = nh;
      state.shown = null;
      dispatch([{ type: "resize", width: nw, height: nh }]);
      dirty = true;
    },
    frame,
    rows() {
      return frame().rows();
    },
    cellAt(x, y) {
      return frame().cell(x, y);
    },
  };
}
