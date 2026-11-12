import type { Frame, Line, Rect, Role, Style } from "../types.js";
import type { CellStyle } from "./colour.js";
import { graphemes, graphemeWidth, isControl, TAB_WIDTH } from "./width.js";

/**
 * One repaint's grid of cells.
 *
 * A cell holds one grapheme (or a space), its resolved style (a span's style laid over the cell's background), and
 * its width: 1, 2 for the first half of a wide character, or 0 for the cell a wide character covers. Nothing drawn
 * outside the frame or the current clip lands anywhere; no control character is ever stored.
 */

export interface Cell extends CellStyle {
  ch: string;
  /** 1, 2 (lead of a wide character) or 0 (the covered half). */
  w: 0 | 1 | 2;
  link?: string;
}

const blank = (bg: Role): Cell => ({ ch: " ", w: 1, bg });

export function sameCell(a: Cell, b: Cell): boolean {
  return (
    a.ch === b.ch &&
    a.w === b.w &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    !a.bold === !b.bold &&
    !a.dim === !b.dim &&
    !a.italic === !b.italic &&
    !a.underline === !b.underline &&
    !a.strike === !b.strike &&
    !a.dimmed === !b.dimmed &&
    a.link === b.link
  );
}

export function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !a.bold === !b.bold &&
    !a.dim === !b.dim &&
    !a.italic === !b.italic &&
    !a.underline === !b.underline &&
    !a.strike === !b.strike &&
    !a.dimmed === !b.dimmed
  );
}

export class CellFrame implements Frame {
  readonly width: number;
  readonly height: number;
  readonly cells: Cell[];
  cursor: { x: number; y: number } | null = null;
  private clipRect: Rect;

  constructor(width: number, height: number, bg: Role = "page") {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.cells = Array.from({ length: this.width * this.height }, () => blank(bg));
    this.clipRect = { x: 0, y: 0, width: this.width, height: this.height };
  }

  /** Draws with everything clipped to `rect` (within the current clip), then puts the clip back. */
  withClip(rect: Rect, draw: () => void): void {
    const saved = this.clipRect;
    this.clipRect = intersect(saved, rect);
    try {
      draw();
    } finally {
      this.clipRect = saved;
    }
  }

  cell(x: number, y: number): Cell | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.cells[y * this.width + x];
  }

  private inClip(x: number, y: number): boolean {
    const c = this.clipRect;
    return x >= c.x && y >= c.y && x < c.x + c.width && y < c.y + c.height;
  }

  /** Writes a cell, repairing any wide character it cuts in half. */
  private put(x: number, y: number, cell: Cell): void {
    const i = y * this.width + x;
    const old = this.cells[i]!;
    if (old.w === 0 && x > 0) {
      const lead = this.cells[i - 1]!;
      if (lead.w === 2) this.cells[i - 1] = { ...lead, ch: " ", w: 1, link: undefined };
    }
    if (old.w === 2 && x + 1 < this.width) {
      const tail = this.cells[i + 1]!;
      if (tail.w === 0) this.cells[i + 1] = { ...tail, ch: " ", w: 1 };
    }
    this.cells[i] = cell;
  }

  fill(rect: Rect, bg: Role): void {
    const r = intersect(this.clipRect, rect);
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) this.put(x, y, blank(bg));
    }
  }

  text(x: number, y: number, line: Line, maxWidth: number): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (y < 0 || y >= this.height || maxWidth <= 0) return;
    const limit = Math.min(x + Math.floor(maxWidth), this.width);
    let col = x;
    let prev = -1; // index of the last cell this call wrote, for a mark that arrives in a later span
    for (const span of line) {
      const st: Style = span.style ?? {};
      for (const g of graphemes(span.text)) {
        if (col >= limit) return;
        if (g === "\t") {
          const n = TAB_WIDTH - ((col - x) % TAB_WIDTH);
          for (let k = 0; k < n && col < limit; k++, col++) {
            if (col >= 0 && this.inClip(col, y)) this.put(col, y, this.styled(col, y, " ", 1, st));
          }
          prev = -1;
          continue;
        }
        const w = graphemeWidth(g);
        if (w === 0) {
          if (isControl(g)) continue;
          const p = prev >= 0 ? this.cells[prev] : undefined;
          if (p && p.ch !== " " && !isControl(g)) p.ch += g;
          continue;
        }
        if (col + w > limit) {
          // only one cell left for a two-cell character: a space, never half a glyph
          if (col >= 0 && this.inClip(col, y)) this.put(col, y, this.styled(col, y, " ", 1, st));
          return;
        }
        if (w === 2 && (!this.inClip(col, y) || !this.inClip(col + 1, y) || col < 0)) {
          if (col >= 0 && this.inClip(col, y)) this.put(col, y, this.styled(col, y, " ", 1, st));
          if (col + 1 >= 0 && this.inClip(col + 1, y)) this.put(col + 1, y, this.styled(col + 1, y, " ", 1, st));
          col += 2;
          prev = -1;
          continue;
        }
        if (col >= 0 && this.inClip(col, y)) {
          const cell = this.styled(col, y, g, w as 1 | 2, st);
          this.put(col, y, cell);
          prev = y * this.width + col;
          if (w === 2) {
            const i = y * this.width + col + 1;
            const old = this.cells[i]!;
            if (old.w === 2 && col + 2 < this.width && this.cells[i + 1]!.w === 0) this.cells[i + 1] = { ...this.cells[i + 1]!, ch: " ", w: 1 };
            this.cells[i] = { ...cell, ch: "", w: 0 };
          }
        } else prev = -1;
        col += w;
      }
    }
  }

  private styled(x: number, y: number, ch: string, w: 1 | 2, st: Style): Cell {
    const under = this.cells[y * this.width + x]!;
    const c: Cell = { ch, w, fg: st.fg ?? "text", bg: st.bg ?? under.bg };
    if (st.bold) c.bold = true;
    if (st.dim) c.dim = true;
    if (st.italic) c.italic = true;
    if (st.underline) c.underline = true;
    if (st.strike) c.strike = true;
    if (st.link) c.link = st.link;
    return c;
  }

  dim(rect: Rect): void {
    const r = intersect(this.clipRect, rect);
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        const c = this.cells[y * this.width + x]!;
        c.dimmed = true;
        // a link behind a dialog is not something to click
        delete c.link;
      }
    }
  }

  /** The row as text (wide characters once, covered halves skipped). For tests. */
  row(y: number): string {
    let s = "";
    for (let x = 0; x < this.width; x++) {
      const c = this.cells[y * this.width + x]!;
      if (c.w !== 0) s += c.ch;
    }
    return s;
  }

  rows(): string[] {
    return Array.from({ length: this.height }, (_, y) => this.row(y));
  }
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, Math.floor(b.x));
  const y = Math.max(a.y, Math.floor(b.y));
  const x2 = Math.min(a.x + a.width, Math.floor(b.x) + Math.floor(b.width));
  const y2 = Math.min(a.y + a.height, Math.floor(b.y) + Math.floor(b.height));
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}

export function createFrame(width: number, height: number, bg: Role = "page"): CellFrame {
  return new CellFrame(width, height, bg);
}
