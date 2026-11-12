import { keepInHistory, loadHistory, saveHistoryEntry, HISTORY_KEEP } from "../input.js";
import { sanitise } from "../sanitise.js";
import type { Input, Line, Span, Style } from "./types.js";
import { graphemes, graphemeWidth, TAB_WIDTH } from "./screen/width.js";

/**
 * The text being typed: a multi-line editor model with no drawing of its own.
 *
 * The cursor moves by grapheme, so an accented letter or an emoji is one step. Words, lines, kill and yank follow
 * readline's keys. Enter is "submit" (the application decides what that means); Shift-Enter, Alt-Enter, Ctrl-J,
 * and a backslash typed at the end of a line followed by Enter, start a new line.
 *
 * A paste of more than CHIP_LINES lines or CHIP_CHARS characters is held whole as one chip, shown as
 * `[pasted N lines]`, moved over and deleted as one character, and expanded in `text`.
 *
 * History is the inline prompt's: the same file, the same rule about what is kept (`keepInHistory`: one line, not
 * starting with a space, never a Memtro key).
 */

export const CHIP_LINES = 5;
export const CHIP_CHARS = 800;
const CHIP_STYLE: Style = { fg: "accent", bold: true };

/** Chips are stood in for by code points from Supplementary Private Use Area A; typed or pasted ones are removed. */
const CHIP_BASE = 0xf0000;
const CHIP_RE = /[\u{F0000}-\u{FFFFD}]/gu;
const isChip = (g: string) => {
  const cp = g.codePointAt(0)!;
  return cp >= CHIP_BASE && cp <= 0xffffd;
};

const WORD = /^[\p{L}\p{N}_]/u;
const isWord = (g: string) => WORD.test(g);
const isBlank = (g: string) => g === " " || g === "\t" || g === "\n";

export type EditResult = "changed" | "submit" | "ignored";

export interface EditorOptions {
  /** The history file (`historyFile(...)` in src/tui/input.ts); null or absent: no file. */
  historyPath?: string | null;
  /** Starting history, oldest first (tests). Ignored when `historyPath` is given. */
  history?: string[];
}

interface Unit {
  start: number;
  end: number;
  text: string;
  w: number;
  style?: Style;
  nl?: boolean;
  space?: boolean;
}

interface Layout {
  rows: Array<Array<Unit & { x: number }>>;
  cursor: { x: number; y: number };
}

export class Editor {
  private buf = "";
  private pos = 0;
  private chips = new Map<string, string>();
  private nextChip = CHIP_BASE;
  private killed = "";
  private readonly historyPath: string | null;
  /** Oldest first. */
  private history: string[];
  /** -1: editing; otherwise an index into `history`. */
  private browsing = -1;
  private draft = "";
  private draftPos = 0;
  private width = Number.POSITIVE_INFINITY;
  private goalX: number | null = null;

  constructor(options: EditorOptions = {}) {
    this.historyPath = options.historyPath ?? null;
    this.history = this.historyPath ? loadHistory(this.historyPath) : [...(options.history ?? [])];
  }

  /** Everything typed, pasted blocks expanded: what would be sent. */
  get text(): string {
    if (!this.chips.size) return this.buf;
    return this.buf.replace(CHIP_RE, (c) => this.chips.get(c) ?? "");
  }

  /** The buffer with each pasted block as one stand-in character (what `cursor` indexes). */
  get raw(): string {
    return this.buf;
  }

  /** The cursor, as an index into `raw`, always on a grapheme boundary. */
  get cursor(): number {
    return this.pos;
  }

  get isEmpty(): boolean {
    return this.buf.length === 0;
  }

  /** The history, oldest first. */
  get entries(): readonly string[] {
    return this.history;
  }

  setText(text: string, cursor?: number): void {
    this.chips.clear();
    this.buf = clean(text);
    this.pos = cursor === undefined ? this.buf.length : this.snap(Math.max(0, Math.min(cursor, this.buf.length)));
    this.goalX = null;
  }

  clear(): void {
    this.setText("");
    this.browsing = -1;
  }

  /** Inserts typed text at the cursor. */
  insert(text: string): void {
    this.put(clean(text));
  }

  private put(t: string): void {
    if (!t) return;
    this.buf = this.buf.slice(0, this.pos) + t + this.buf.slice(this.pos);
    this.pos += t.length;
    this.goalX = null;
  }

  /** Inserts pasted text: a large block becomes one chip. */
  paste(text: string): void {
    const t = clean(text.replace(/\r\n?/g, "\n"));
    if (!t) return;
    const lines = t.split("\n").length;
    if (lines > CHIP_LINES || t.length > CHIP_CHARS) {
      const ch = String.fromCodePoint(this.nextChip++);
      if (this.nextChip > 0xffffd) this.nextChip = CHIP_BASE;
      this.chips.set(ch, t);
      this.put(ch);
      return;
    }
    this.insert(t);
  }

  /**
   * The text to send, remembered in history when it qualifies, and the editor cleared. The application calls this
   * when it acts on "submit".
   */
  take(): string {
    const value = this.text;
    this.remember(value);
    this.clear();
    return value;
  }

  /** Adds to history (and its file) when `keepInHistory` allows. */
  remember(value: string): void {
    if (!keepInHistory(value)) return;
    this.history = this.history.filter((h) => h !== value);
    this.history.push(value);
    if (this.historyPath) saveHistoryEntry(this.historyPath, value, this.history);
    if (this.history.length >= HISTORY_KEEP * 2) this.history = this.history.slice(-HISTORY_KEEP);
  }

  handle(input: Input): EditResult {
    if (input.type === "paste") {
      this.paste(input.text);
      return "changed";
    }
    if (input.type !== "key") return "ignored";
    const { name, ctrl, alt, shift } = input;
    if (input.text !== undefined && !ctrl && !alt) {
      this.insert(input.text);
      return "changed";
    }
    if (name === "enter") {
      if (shift || alt || ctrl) return this.newline();
      // a backslash typed at the end of a line carries on onto the next, as at the inline prompt
      if (this.buf[this.pos - 1] === "\\" && (this.pos === this.buf.length || this.buf[this.pos] === "\n")) {
        this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos);
        this.pos--;
        return this.newline();
      }
      return "submit";
    }
    if (ctrl && !alt && name === "j") return this.newline();

    const wordMove = alt || ctrl;
    switch (name) {
      case "left":
        return this.move(wordMove ? this.wordLeft(this.pos) : this.prev(this.pos));
      case "right":
        return this.move(wordMove ? this.wordRight(this.pos) : this.next(this.pos));
      case "home":
        return this.move(ctrl ? 0 : this.lineStart(this.pos));
      case "end":
        return this.move(ctrl ? this.buf.length : this.lineEnd(this.pos));
      case "up":
        return this.vertical(-1);
      case "down":
        return this.vertical(1);
      case "backspace":
        if (alt || ctrl) return this.killTo(this.wordLeft(this.pos));
        return this.deleteRange(this.prev(this.pos), this.pos);
      case "delete":
        if (alt || ctrl) return this.killTo(this.wordRight(this.pos));
        return this.deleteRange(this.pos, this.next(this.pos));
    }
    if (ctrl && !alt) {
      switch (name) {
        case "a":
          return this.move(this.lineStart(this.pos));
        case "e":
          return this.move(this.lineEnd(this.pos));
        case "b":
          return this.move(this.prev(this.pos));
        case "f":
          return this.move(this.next(this.pos));
        case "d":
          if (!this.buf) return "ignored";
          return this.deleteRange(this.pos, this.next(this.pos));
        case "h":
          return this.deleteRange(this.prev(this.pos), this.pos);
        case "w":
          return this.killTo(this.unixWordLeft(this.pos));
        case "u": {
          const s = this.lineStart(this.pos);
          return this.killTo(s === this.pos && s > 0 ? s - 1 : s);
        }
        case "k": {
          const e = this.lineEnd(this.pos);
          return this.killTo(e === this.pos && e < this.buf.length ? e + 1 : e);
        }
        case "y":
          if (!this.killed) return "ignored";
          this.insert(this.killed);
          return "changed";
      }
      return "ignored";
    }
    if (alt && !ctrl) {
      switch (name) {
        case "b":
          return this.move(this.wordLeft(this.pos));
        case "f":
          return this.move(this.wordRight(this.pos));
        case "d":
          return this.killTo(this.wordRight(this.pos));
      }
    }
    return "ignored";
  }

  /**
   * The text soft-wrapped to `width` cells, and the cell the cursor is in. A row that is exactly full puts a cursor
   * at its end on the next row. Pasted blocks show as their chip.
   */
  lines(width: number): { lines: Line[]; cursor: { x: number; y: number } } {
    this.width = Math.max(1, Math.floor(width));
    const layout = this.layout(this.width);
    const lines = layout.rows.map((row) => {
      const spans: Span[] = [];
      for (const u of row) {
        if (u.nl || !u.text) continue;
        const last = spans.at(-1);
        if (last && last.style === u.style) last.text += u.text;
        else spans.push(u.style ? { text: u.text, style: u.style } : { text: u.text });
      }
      return spans;
    });
    return { lines, cursor: layout.cursor };
  }

  // -------------------------------------------------------------------------------------------------------------

  private newline(): EditResult {
    this.insert("\n");
    return "changed";
  }

  private move(to: number): EditResult {
    this.goalX = null;
    if (to === this.pos) return "ignored";
    this.pos = to;
    return "changed";
  }

  private deleteRange(from: number, to: number): EditResult {
    if (from >= to) return "ignored";
    const removed = this.buf.slice(from, to);
    this.buf = this.buf.slice(0, from) + this.buf.slice(to);
    this.pos = from;
    this.goalX = null;
    this.forgetChips(removed);
    return "changed";
  }

  /** Deletes between the cursor and `to` (either side) into the kill buffer. */
  private killTo(to: number): EditResult {
    const from = Math.min(to, this.pos);
    const end = Math.max(to, this.pos);
    if (from === end) return "ignored";
    // a killed chip is yanked back as its text, never as a dangling stand-in
    this.killed = this.buf.slice(from, end).replace(CHIP_RE, (c) => this.chips.get(c) ?? "");
    return this.deleteRange(from, end);
  }

  private forgetChips(removed: string): void {
    for (const m of removed.matchAll(CHIP_RE)) this.chips.delete(m[0]);
  }

  /** Grapheme boundaries of the buffer. */
  private bounds(): number[] {
    const b = [0];
    let i = 0;
    for (const g of graphemes(this.buf)) {
      i += g.length;
      b.push(i);
    }
    return b;
  }

  private snap(i: number): number {
    const b = this.bounds();
    let best = 0;
    for (const x of b) if (x <= i) best = x;
    return best;
  }

  private prev(i: number): number {
    if (i <= 0) return 0;
    const b = this.bounds();
    let p = 0;
    for (const x of b) {
      if (x >= i) break;
      p = x;
    }
    return p;
  }

  private next(i: number): number {
    if (i >= this.buf.length) return this.buf.length;
    for (const x of this.bounds()) if (x > i) return x;
    return this.buf.length;
  }

  /** The graphemes with their start offsets. */
  private segs(): Array<{ g: string; at: number }> {
    const out: Array<{ g: string; at: number }> = [];
    let at = 0;
    for (const g of graphemes(this.buf)) {
      out.push({ g, at });
      at += g.length;
    }
    return out;
  }

  private wordLeft(i: number): number {
    const s = this.segs();
    let k = s.findIndex((x) => x.at >= i);
    if (k < 0) k = s.length;
    k--;
    while (k >= 0 && !isWord(s[k]!.g)) k--;
    while (k >= 0 && isWord(s[k]!.g)) k--;
    return k + 1 < s.length ? s[k + 1]!.at : this.buf.length;
  }

  private wordRight(i: number): number {
    const s = this.segs();
    let k = s.findIndex((x) => x.at >= i);
    if (k < 0) return this.buf.length;
    while (k < s.length && !isWord(s[k]!.g)) k++;
    while (k < s.length && isWord(s[k]!.g)) k++;
    return k < s.length ? s[k]!.at : this.buf.length;
  }

  /** Ctrl-W: back over blanks, then over everything that is not blank. */
  private unixWordLeft(i: number): number {
    const s = this.segs();
    let k = s.findIndex((x) => x.at >= i);
    if (k < 0) k = s.length;
    k--;
    while (k >= 0 && isBlank(s[k]!.g)) k--;
    while (k >= 0 && !isBlank(s[k]!.g)) k--;
    return k + 1 < s.length ? s[k + 1]!.at : this.buf.length;
  }

  private lineStart(i: number): number {
    const n = this.buf.lastIndexOf("\n", i - 1);
    return n < 0 ? 0 : n + 1;
  }

  private lineEnd(i: number): number {
    const n = this.buf.indexOf("\n", i);
    return n < 0 ? this.buf.length : n;
  }

  private vertical(dir: -1 | 1): EditResult {
    const layout = this.layout(this.width);
    const y = layout.cursor.y;
    const target = y + dir;
    if (target < 0) return this.historyOlder();
    if (target >= layout.rows.length) return this.historyNewer();
    const goal = this.goalX ?? layout.cursor.x;
    const row = layout.rows[target]!;
    let to: number | null = null;
    for (const u of row) {
      if (u.nl) break;
      if (goal < u.x + Math.max(1, u.w) && goal >= u.x) {
        to = u.start;
        break;
      }
      if (u.x >= goal) {
        to = u.start;
        break;
      }
    }
    if (to === null) {
      const nl = row.find((u) => u.nl);
      if (nl) to = nl.start;
      else if (target === layout.rows.length - 1) to = this.buf.length;
      else {
        const last = row.at(-1);
        to = last ? last.start : this.buf.length;
      }
    }
    this.pos = to;
    this.goalX = goal;
    return "changed";
  }

  private historyOlder(): EditResult {
    if (!this.history.length) return "ignored";
    if (this.browsing === -1) {
      this.draft = this.buf;
      this.draftPos = this.pos;
      this.browsing = this.history.length;
    }
    if (this.browsing === 0) return "ignored";
    this.browsing--;
    this.buf = this.history[this.browsing]!;
    this.pos = this.buf.length;
    this.goalX = null;
    return "changed";
  }

  private historyNewer(): EditResult {
    if (this.browsing === -1) return "ignored";
    this.browsing++;
    if (this.browsing >= this.history.length) {
      this.browsing = -1;
      this.buf = this.draft;
      this.pos = this.draftPos;
    } else {
      this.buf = this.history[this.browsing]!;
      this.pos = this.buf.length;
    }
    this.goalX = null;
    return "changed";
  }

  private units(): Unit[] {
    const out: Unit[] = [];
    let at = 0;
    for (const g of graphemes(this.buf)) {
      const start = at;
      at += g.length;
      if (g === "\n") {
        out.push({ start, end: at, text: "", w: 0, nl: true });
        continue;
      }
      if (isChip(g)) {
        const body = this.chips.get(g) ?? "";
        const n = body.split("\n").length;
        const label = n > 1 ? `[pasted ${n} lines]` : `[pasted ${body.length} characters]`;
        out.push({ start, end: at, text: label, w: label.length, style: CHIP_STYLE });
        continue;
      }
      if (g === "\t") {
        out.push({ start, end: at, text: "\t", w: -1, space: true }); // width set at layout
        continue;
      }
      // whatever a control character is, it is shown as its picture, never sent to the terminal
      const shown = sanitise(g).replace(/\t/g, " ");
      let w = 0;
      for (const sg of graphemes(shown)) w += graphemeWidth(sg);
      if (w === 0 && shown) {
        // a lone combining mark: attach to the previous unit for display
        const prev = out.at(-1);
        if (prev && !prev.nl && !prev.style) {
          prev.text += shown;
          prev.end = at;
          continue;
        }
      }
      out.push({ start, end: at, text: shown, w, space: g === " " });
    }
    return out;
  }

  private layout(width: number): Layout {
    const W = Number.isFinite(width) ? width : Number.MAX_SAFE_INTEGER;
    const rows: Array<Array<Unit & { x: number }>> = [];
    let row: Unit[] = [];
    let col = 0;
    const flush = () => {
      let x = 0;
      rows.push(
        row.map((u) => {
          const p = { ...u, x };
          x += u.w;
          return p;
        }),
      );
      row = [];
      col = 0;
    };
    for (const unit of this.units()) {
      let u = unit;
      if (u.nl) {
        row.push(u);
        flush();
        continue;
      }
      if (u.w < 0) {
        // a tab: to the next stop on this row, at least one cell
        const n = TAB_WIDTH - (col % TAB_WIDTH);
        u = { ...u, text: " ".repeat(n), w: n };
      }
      if (u.w > W) {
        // a chip wider than the row: cut its label
        const text = `${u.text.slice(0, Math.max(0, W - 1))}…`.slice(0, W);
        u = { ...u, text, w: text.length };
      }
      if (col + u.w > W && row.length) {
        // prefer to break after the last space on the row
        let k = -1;
        for (let r = row.length - 1; r >= 0; r--) {
          if (row[r]!.space) {
            k = r;
            break;
          }
        }
        if (!u.space && k >= 0 && k < row.length - 1) {
          const carry = row.slice(k + 1);
          row = row.slice(0, k + 1);
          flush();
          row = carry;
          col = carry.reduce((n, c) => n + c.w, 0);
          if (col + u.w > W) flush();
        } else flush();
      }
      row.push(u);
      col += u.w;
    }
    flush();

    // the cursor
    let cx = 0;
    let cy = rows.length - 1;
    let found = false;
    for (let y = 0; y < rows.length && !found; y++) {
      for (const u of rows[y]!) {
        if (u.start === this.pos) {
          cx = u.x;
          cy = y;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const last = rows[rows.length - 1]!;
      cx = last.reduce((n, u) => n + u.w, 0);
      cy = rows.length - 1;
    }
    if (cx >= W) {
      cy++;
      cx = 0;
      if (cy >= rows.length) rows.push([]);
    }
    return { rows, cursor: { x: cx, y: cy } };
  }
}

function clean(text: string): string {
  return text.replace(CHIP_RE, "");
}
