import assert from "node:assert/strict";
import { test } from "node:test";
import { darkTheme } from "../src/tui/full/screen/colour.js";
import { diffFrame, initialWriterState, safeLink, SYNC_END, SYNC_START } from "../src/tui/full/screen/diff.js";
import { CellFrame } from "../src/tui/full/screen/frame.js";
import { graphemes, graphemeWidth } from "../src/tui/full/screen/width.js";

const ESC = "\u001b";

/**
 * A small terminal for checking the writer: cursor addressing, relative moves, SGR (ignored), OSC 8, modes. It
 * fails the test on anything written outside the grid and on any control character used as content.
 */
class MiniTerm {
  grid: string[][];
  links: (string | null)[][];
  x = 0;
  y = 0;
  link: string | null = null;
  cursorVisible = true;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.grid = Array.from({ length: h }, () => Array.from({ length: w }, () => " "));
    this.links = Array.from({ length: h }, () => Array.from({ length: w }, () => null));
  }
  feed(s: string) {
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === ESC) {
        const rest = s.slice(i);
        let m: RegExpExecArray | null;
        if ((m = /^\u001b\[(\d+);(\d+)H/.exec(rest))) {
          this.y = Number(m[1]) - 1;
          this.x = Number(m[2]) - 1;
          assert.ok(this.y >= 0 && this.y < this.h && this.x >= 0 && this.x < this.w, `CUP outside the screen: ${m[0]}`);
        } else if ((m = /^\u001b\[(\d*)C/.exec(rest))) {
          this.x += Number(m[1] || 1);
          assert.ok(this.x < this.w, "CUF past the edge");
        } else if ((m = /^\u001b\[[0-9;]*m/.exec(rest))) {
          // style
        } else if ((m = /^\u001b\[\?(\d+)([hl])/.exec(rest))) {
          if (m[1] === "25") this.cursorVisible = m[2] === "h";
        } else if ((m = /^\u001b\]8;;([^\u001b\u0007]*)\u001b\\/.exec(rest))) {
          this.link = m[1] || null;
        } else assert.fail(`unexpected sequence ${JSON.stringify(rest.slice(0, 12))}`);
        i += m[0].length;
        continue;
      }
      if (c === "\r") {
        this.x = 0;
        i++;
        continue;
      }
      const code = c.codePointAt(0)!;
      assert.ok(code >= 0x20 && !(code >= 0x7f && code < 0xa0), `control character written as content: ${code}`);
      // one grapheme
      const g = graphemes(s.slice(i, i + 16))[0]!;
      const gw = graphemeWidth(g);
      assert.ok(this.y < this.h && this.x + gw <= this.w, `write outside the screen at ${this.x},${this.y}`);
      this.grid[this.y]![this.x] = g;
      this.links[this.y]![this.x] = this.link;
      if (gw === 2) this.grid[this.y]![this.x + 1] = "";
      this.x += gw;
      i += g.length;
    }
  }
  rows(): string[] {
    return this.grid.map((r) => r.join(""));
  }
}

const opts = { theme: darkTheme, depth: "truecolor" as const, sync: true };

test("frame: text clips to the frame, maxWidth and the clip; wide characters never split", () => {
  const f = new CellFrame(10, 3);
  f.text(-2, 0, [{ text: "abcdefghijklmnop" }], 100);
  assert.equal(f.row(0), "cdefghijkl");
  f.text(0, 1, [{ text: "日本語日本語" }], 5);
  assert.equal(f.row(1), "日本      ", "the fifth cell would split 語: a space");
  f.text(0, 5, [{ text: "nowhere" }], 10);
  f.text(0, -1, [{ text: "nowhere" }], 10);
  f.withClip({ x: 2, y: 2, width: 3, height: 1 }, () => f.text(0, 2, [{ text: "XXXXXXXX" }], 10));
  assert.equal(f.row(2), "  XXX     ");
  f.text(9, 0, [{ text: "日" }], 5);
  assert.equal(f.cell(9, 0)!.ch, " ", "a wide char in the last column becomes a space");
});

test("frame: overwriting half of a wide character clears the other half", () => {
  const f = new CellFrame(6, 1);
  f.text(0, 0, [{ text: "日本語" }], 6);
  f.text(1, 0, [{ text: "x" }], 1);
  assert.equal(f.row(0), " x本語");
  f.text(2, 0, [{ text: "y" }], 1);
  assert.equal(f.row(0), " xy 語");
  for (let x = 0; x < 6; x++) {
    const c = f.cell(x, 0)!;
    if (c.w === 0) assert.equal(f.cell(x - 1, 0)!.w, 2, `covered half at ${x} has its lead`);
  }
});

test("frame: controls are never stored; tabs expand; marks join their base; spans keep the cell background", () => {
  const f = new CellFrame(12, 1);
  f.fill({ x: 0, y: 0, width: 12, height: 1 }, "panel");
  f.text(0, 0, [{ text: "a\u001b[2Jb\tc" }, { text: "́", style: { fg: "accent" } }], 12);
  assert.equal(f.row(0), "a[2Jb   c\u0301   ");
  assert.equal(f.cell(0, 0)!.bg, "panel");
  assert.equal(f.cell(0, 0)!.fg, "text");
  for (const c of f.cells) assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(c.ch));
});

test("frame: dim marks cells and drops links", () => {
  const f = new CellFrame(5, 1);
  f.text(0, 0, [{ text: "link", style: { link: "https://example.com" } }], 5);
  f.dim({ x: 0, y: 0, width: 2, height: 1 });
  assert.equal(f.cell(0, 0)!.dimmed, true);
  assert.equal(f.cell(0, 0)!.link, undefined);
  assert.equal(f.cell(2, 0)!.link, "https://example.com");
  assert.ok(!f.cell(2, 0)!.dimmed);
});

test("diff: first paint reproduces the frame; a second identical frame writes nothing", () => {
  const f = new CellFrame(20, 4);
  f.fill({ x: 0, y: 1, width: 20, height: 2 }, "panel");
  f.text(1, 1, [{ text: "hello 日本 😀 ", style: { fg: "accent", bold: true } }, { text: "é" }], 18);
  f.text(0, 3, [{ text: "bottom right!!!!!!!!!" }], 20);
  f.cursor = { x: 3, y: 2 };
  const st = initialWriterState();
  const out = diffFrame(f, st, opts);
  assert.ok(out.startsWith(SYNC_START) && out.endsWith(SYNC_END));
  const term = new MiniTerm(20, 4);
  term.feed(out);
  assert.deepEqual(term.rows(), f.rows());
  assert.equal(term.x, 3);
  assert.equal(term.y, 2);
  assert.ok(term.cursorVisible);
  const again = new CellFrame(20, 4);
  again.fill({ x: 0, y: 1, width: 20, height: 2 }, "panel");
  again.text(1, 1, [{ text: "hello 日本 😀 ", style: { fg: "accent", bold: true } }, { text: "é" }], 18);
  again.text(0, 3, [{ text: "bottom right!!!!!!!!!" }], 20);
  again.cursor = { x: 3, y: 2 };
  assert.equal(diffFrame(again, st, opts), "");
});

test("diff: random successive frames always reproduce on the terminal", () => {
  let seed = 3;
  const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const W = 30;
  const H = 6;
  const term = new MiniTerm(W, H);
  const st = initialWriterState();
  const words = ["ab", "日本", "😀", " ", "é", "x", "👨‍👩‍👧", "\u001b", "Ａ"];
  for (let n = 0; n < 300; n++) {
    const f = new CellFrame(W, H);
    for (let k = 0; k < 6; k++) {
      let t = "";
      for (let i = 0; i < 8; i++) t += words[Math.floor(r() * words.length)];
      f.text(Math.floor(r() * W) - 3, Math.floor(r() * H), [{ text: t, style: r() < 0.5 ? { fg: "danger" } : { link: "https://x.test/a" } }], Math.floor(r() * W));
    }
    if (r() < 0.2) f.dim({ x: 0, y: 0, width: 10, height: 3 });
    f.cursor = r() < 0.5 ? { x: Math.floor(r() * W), y: Math.floor(r() * H) } : null;
    const out = diffFrame(f, st, opts);
    term.feed(out);
    assert.deepEqual(term.rows(), f.rows(), `frame ${n}`);
    assert.equal(term.link, null, "links are closed at the end of every frame");
    assert.equal(term.cursorVisible, f.cursor !== null);
  }
});

test("diff: only http, https and mailto links are written, and always closed", () => {
  assert.equal(safeLink("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(safeLink("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("file:///etc/passwd"), null);
  assert.equal(safeLink("https://e.com/\u001b]52;c;x\u0007"), null);
  assert.equal(safeLink("https://e.com/ a"), null);
  const f = new CellFrame(30, 1);
  f.text(0, 0, [{ text: "ok", style: { link: "https://memtro.com" } }, { text: " " }, { text: "bad", style: { link: "javascript:x" } }], 30);
  const out = diffFrame(f, initialWriterState(), opts);
  assert.match(out, /\u001b\]8;;https:\/\/memtro\.com\u001b\\(\u001b\[[0-9;]*m)?ok\u001b\]8;;\u001b\\/);
  assert.ok(!out.includes("javascript"));
});

test("diff: style codes only when the style changes; no colour at depth none", () => {
  const f = new CellFrame(10, 1);
  f.text(0, 0, [{ text: "aaaa", style: { fg: "accent" } }, { text: "bbbb", style: { fg: "danger" } }], 10);
  const out = diffFrame(f, initialWriterState(), opts);
  assert.equal((out.match(/\u001b\[0;[^m]*m/g) ?? []).length, 3, "page-blank run, accent run, danger run... at most one per change");
  const none = diffFrame(f, initialWriterState(), { ...opts, depth: "none" });
  assert.ok(!/38;|48;|\[3\dm|\[9\dm/.test(none));
  const sel = new CellFrame(10, 1);
  sel.text(0, 0, [{ text: "selected", style: { bg: "accent", fg: "onAccent" } }], 10);
  assert.ok(diffFrame(sel, initialWriterState(), { ...opts, depth: "none" }).includes(`${ESC}[0;7m`), "the selection is reverse video without colour");
  assert.ok(diffFrame(sel, initialWriterState(), { ...opts, depth: "16" }).includes(";46m"), "cyan background at 16 colours");
  assert.ok(diffFrame(sel, initialWriterState(), { ...opts, depth: "256" }).includes("48;5;"), "an indexed background at 256");
});

test("diff: without synchronized output there are no sync marks", () => {
  const f = new CellFrame(4, 1);
  f.text(0, 0, [{ text: "x" }], 4);
  const out = diffFrame(f, initialWriterState(), { ...opts, sync: false });
  assert.ok(!out.includes("2026"));
});

test("diff: a keystroke repaint at 120×36 is tens to hundreds of bytes", () => {
  const draw = (typed: string) => {
    const f = new CellFrame(120, 36);
    for (let y = 2; y < 28; y++) f.text(2, y, [{ text: `line ${y} of an answer with some words in it and `, style: { fg: "text" } }, { text: "code", style: { fg: "synKeyword", bg: "codeBg" } }], 116);
    f.fill({ x: 2, y: 30, width: 116, height: 4 }, "panel");
    f.text(2, 30, [{ text: "┃", style: { fg: "accent" } }], 1);
    f.text(4, 30, [{ text: typed }], 110);
    f.text(4, 32, [{ text: "auto", style: { fg: "accent" } }, { text: "  claude-opus  acme", style: { fg: "muted" } }], 110);
    f.cursor = { x: 4 + typed.length, y: 30 };
    return f;
  };
  const st = initialWriterState();
  const first = diffFrame(draw("hello"), st, opts);
  const key = diffFrame(draw("hello!"), st, opts);
  const bytes = Buffer.byteLength(key);
  assert.ok(Buffer.byteLength(first) > 4_000, "the first paint is the whole screen");
  assert.ok(bytes > 10 && bytes < 300, `keystroke repaint was ${bytes} bytes`);
  console.log(`# bytes: first paint ${Buffer.byteLength(first)}, keystroke ${bytes}`);
});

test("diff: a glyph in a surface colour is a space where surfaces are the terminal's own, and kept where it shows", () => {
  const f = new CellFrame(6, 1);
  f.text(0, 0, [{ text: "▀▀", style: { fg: "panel" } }, { text: "▀▀", style: { fg: "panel", bg: "accent" } }, { text: "ok" }], 6);
  for (const depth of ["16", "none"] as const) {
    const term = new MiniTerm(6, 1);
    term.feed(diffFrame(f, initialWriterState(), { ...opts, depth }));
    assert.equal(term.rows()[0], "  ▀▀ok", `${depth}: the half-blocks on the page vanish, those on a filled background stay`);
  }
  for (const depth of ["truecolor", "256"] as const) {
    const term = new MiniTerm(6, 1);
    term.feed(diffFrame(f, initialWriterState(), { ...opts, depth }));
    assert.equal(term.rows()[0], "▀▀▀▀ok", `${depth}: surfaces have colours, so the edge is drawn`);
  }
});
