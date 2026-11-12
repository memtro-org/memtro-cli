import type { Line, Span, Style } from "../types.js";

/**
 * How many terminal cells text takes.
 *
 * A terminal draws graphemes (what a reader sees as one character), not code points: "é" written as e + U+0301 is
 * one cell, a family emoji joined with zero-width joiners is one two-cell glyph, a flag is two regional indicators
 * drawn as one two-cell glyph. Graphemes come from `Intl.Segmenter`; the width of each comes from its first code
 * point, except that an emoji variation selector (U+FE0F) makes it two cells and a lone mark or format character
 * makes it none.
 *
 * Wide and fullwidth code points follow Unicode 15.1's EastAsianWidth.txt (the W and F classes, which include every
 * Emoji_Presentation character), kept here as a compact sorted range table rather than a data file. Ambiguous (A)
 * characters are narrow, as in every terminal's default. Marks (Mn, Me), format characters (Cf) and Hangul medial
 * vowels and final consonants are zero width; control characters are zero width and are never drawn (see frame.ts).
 *
 * Tabs are expanded to the next multiple of `TAB_WIDTH` before anything is measured; a tab never reaches a cell.
 */

export const TAB_WIDTH = 4;
export const UNICODE_VERSION = "15.1";

/** EastAsianWidth W and F, Unicode 15.1, as [first, last] pairs flattened, sorted. */
const WIDE: readonly number[] = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe,
  0x2614, 0x2615, 0x2648, 0x2653, 0x267f, 0x267f, 0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
  0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa,
  0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755,
  0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55,
  0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0, 0x2fff, 0x3000, 0x303e, 0x3041, 0x3096, 0x3099, 0x30ff,
  0x3105, 0x312f, 0x3131, 0x318e, 0x3190, 0x31e3, 0x31ef, 0x321e, 0x3220, 0x3247, 0x3250, 0x4dbf, 0x4e00, 0xa48c,
  0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe52, 0xfe54, 0xfe66,
  0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe4, 0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800,
  0x18cd5, 0x18d00, 0x18d08, 0x1aff0, 0x1aff3, 0x1aff5, 0x1affb, 0x1affd, 0x1affe, 0x1b000, 0x1b122, 0x1b132,
  0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155, 0x1b164, 0x1b167, 0x1b170, 0x1b2fb, 0x1f004, 0x1f004, 0x1f0cf,
  0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250,
  0x1f251, 0x1f260, 0x1f265, 0x1f300, 0x1f320, 0x1f32d, 0x1f335, 0x1f337, 0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0,
  0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4, 0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442,
  0x1f4fc, 0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567, 0x1f57a, 0x1f57a, 0x1f595, 0x1f596, 0x1f5a4,
  0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc, 0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d7, 0x1f6dc,
  0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb, 0x1f7f0, 0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c,
  0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa88, 0x1fa90, 0x1fabd, 0x1fabf, 0x1fac5, 0x1face,
  0x1fadb, 0x1fae0, 0x1fae8, 0x1faf0, 0x1faf8, 0x20000, 0x2fffd, 0x30000, 0x3fffd,
];

function inWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  let lo = 0;
  let hi = WIDE.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const first = WIDE[mid * 2]!;
    const last = WIDE[mid * 2 + 1]!;
    if (cp < first) hi = mid - 1;
    else if (cp > last) lo = mid + 1;
    else return true;
  }
  return false;
}

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
// C0 and C1 controls, and the invisible format characters that reorder or hide text (bidi embeddings, overrides,
// isolates and marks; zero-width space, word joiner, invisible operators, byte-order mark). None is ever drawn:
// a terminal that does bidi would otherwise let "\u202e" make a line read backwards. Joiners (ZWJ, ZWNJ) stay.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** True for a character that must never be written to a terminal cell. */
export function isControl(text: string): boolean {
  return CONTROL.test(text);
}

/** Width of one code point: 0, 1 or 2. */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp >= 0x20 && cp < 0x7f) return 1;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if (cp >= 0x1160 && cp <= 0x11ff) return 0; // Hangul medial vowels and final consonants join the syllable
  if (inWide(cp)) return 2;
  if (cp >= 0x300 && ZERO.test(String.fromCodePoint(cp))) return 0;
  return 1;
}

const PICTO = /^\p{Extended_Pictographic}$/u;
const KEYCAP = /^[0-9#*]$/;
const isRegionalIndicator =(cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

/** Width of one grapheme cluster. */
export function graphemeWidth(g: string): number {
  if (g.length === 1) {
    const c = g.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return 1;
    if (c === 0x09) return TAB_WIDTH;
  }
  let first = -1;
  let ri = 0;
  let base = "";
  for (const ch of g) {
    const cp = ch.codePointAt(0)!;
    if (!base) base = ch;
    if (cp === 0xfe0f && (PICTO.test(base) || KEYCAP.test(base))) return 2; // emoji presentation
    if (isRegionalIndicator(cp)) ri++;
    if (first < 0) {
      const w = codePointWidth(cp);
      if (w > 0) first = w;
    }
  }
  if (ri >= 2) return 2;
  return first < 0 ? 0 : first;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ASCII = /^[\x20-\x7e]*$/;

/** The grapheme clusters of `text`, in order. */
export function graphemes(text: string): string[] {
  if (ASCII.test(text)) return text.split("");
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

/** Tabs replaced by spaces to the next stop, counting columns from `startColumn`. */
export function expandTabs(text: string, startColumn = 0): string {
  if (!text.includes("\t")) return text;
  let col = startColumn;
  let out = "";
  for (const g of graphemes(text)) {
    if (g === "\t") {
      const n = TAB_WIDTH - (col % TAB_WIDTH);
      out += " ".repeat(n);
      col += n;
    } else {
      out += g;
      col += graphemeWidth(g);
    }
  }
  return out;
}

/** Cells `text` takes on one row, tabs expanded from column 0, controls counted as nothing. */
export function displayWidth(text: string): number {
  if (ASCII.test(text)) return text.length;
  let col = 0;
  for (const g of graphemes(text)) {
    if (g === "\t") col += TAB_WIDTH - (col % TAB_WIDTH);
    else col += graphemeWidth(g);
  }
  return col;
}

/** Cells a line takes; tabs expand across span boundaries. */
export function lineWidth(line: Line): number {
  let col = 0;
  for (const span of line) {
    if (ASCII.test(span.text)) {
      col += span.text.length;
      continue;
    }
    for (const g of graphemes(span.text)) {
      if (g === "\t") col += TAB_WIDTH - (col % TAB_WIDTH);
      else col += graphemeWidth(g);
    }
  }
  return col;
}

/** One measured grapheme with the style it carries. Tabs are already spaces. */
interface Piece {
  g: string;
  w: number;
  style: Style | undefined;
}

function pieces(line: Line): Piece[] {
  const out: Piece[] = [];
  let col = 0;
  for (const span of line) {
    for (const g of graphemes(span.text)) {
      if (g === "\t") {
        const n = TAB_WIDTH - (col % TAB_WIDTH);
        for (let i = 0; i < n; i++) out.push({ g: " ", w: 1, style: span.style });
        col += n;
        continue;
      }
      const w = graphemeWidth(g);
      if (w === 0 && isControl(g)) continue; // a stray control is dropped, never measured or drawn
      out.push({ g, w, style: span.style });
      col += w;
    }
  }
  return out;
}

/** Joins pieces back into spans, merging neighbours that share a style object. */
function toLine(ps: readonly Piece[]): Line {
  const out: Span[] = [];
  for (const p of ps) {
    const last = out.at(-1);
    if (last && last.style === p.style) last.text += p.g;
    else out.push(p.style ? { text: p.g, style: p.style } : { text: p.g });
  }
  return out;
}

/**
 * The line cut to at most `width` cells. A wide character that would straddle the edge is left out. With
 * `ellipsis`, a line that had to be cut ends in "…" (in the style of what it replaced) and still fits.
 */
export function truncate(line: Line, width: number, ellipsis = false): Line {
  if (width <= 0) return [];
  if (lineWidth(line) <= width && !line.some((s) => s.text.includes("\t") || CONTROL.test(s.text))) return line;
  const ps = pieces(line);
  const total = ps.reduce((n, p) => n + p.w, 0);
  if (total <= width) return toLine(ps);
  const limit = ellipsis ? width - 1 : width;
  const kept: Piece[] = [];
  let used = 0;
  for (const p of ps) {
    if (used + p.w > limit) break;
    kept.push(p);
    used += p.w;
  }
  if (ellipsis) kept.push({ g: "…", w: 1, style: ps[kept.length]?.style ?? kept.at(-1)?.style });
  return toLine(kept);
}

const isSpace = (g: string) => g === " " || g === " " || g === "　";

/**
 * The line wrapped to `width` cells. Breaks at spaces (dropping the spaces at each break); a word longer than a
 * row is broken between graphemes, never inside one. `indent` puts that many blank cells before every row after
 * the first. `hardBreak` wraps at exactly `width` cells keeping every space (for code and preformatted text).
 * An empty line gives one empty row. A wide character that cannot fit even on an empty row becomes a space.
 */
export function wrapLine(line: Line, width: number, options: { indent?: number; hardBreak?: boolean } = {}): Line[] {
  if (width <= 0) return [[]];
  // at least two cells stay free after the indent, so a wide character always fits on a continuation row
  const indent = Math.max(0, Math.min(options.indent ?? 0, width - 2));
  const pad: Piece[] = indent ? Array.from({ length: indent }, () => ({ g: " ", w: 1, style: undefined })) : [];
  const ps = pieces(line);
  const rows: Piece[][] = [];
  let row: Piece[] = [];
  let used = 0;
  const newRow = () => {
    rows.push(row);
    row = [...pad];
    used = indent;
  };
  const place = (p: Piece) => {
    if (p.w > width - indent && p.w > width - used) {
      // cannot fit even on a fresh row: show a space rather than overflow
      p = { g: " ", w: 1, style: p.style };
    }
    if (used + p.w > width) newRow();
    row.push(p);
    used += p.w;
  };

  if (options.hardBreak) {
    for (const p of ps) place(p);
    rows.push(row);
    return rows.map(toLine);
  }

  // Words and runs of spaces.
  let i = 0;
  while (i < ps.length) {
    const space = isSpace(ps[i]!.g);
    let j = i;
    let w = 0;
    while (j < ps.length && isSpace(ps[j]!.g) === space) w += ps[j++]!.w;
    const run = ps.slice(i, j);
    i = j;
    if (space) {
      const atBreak = rows.length > 0 && used === indent && row.length === indent;
      if (atBreak) continue; // spaces that start a continuation row are the break
      if (used + w <= width) {
        row.push(...run);
        used += w;
      } else {
        newRow(); // the spaces at the break are dropped
      }
      continue;
    }
    if (used + w <= width) {
      row.push(...run);
      used += w;
      continue;
    }
    const hasContent = row.length > (rows.length > 0 ? indent : 0) && used > (rows.length > 0 ? indent : 0);
    if (hasContent && w <= width - indent) {
      // trailing spaces on the row being left are part of the break
      while (row.length && isSpace(row.at(-1)!.g) && row.length > (rows.length > 0 ? indent : 0)) {
        used -= row.pop()!.w;
      }
      newRow();
      row.push(...run);
      used += w;
      continue;
    }
    for (const p of run) place(p);
  }
  rows.push(row);
  // Trailing spaces at a break are invisible; drop them from every row but the last so widths are honest.
  for (let r = 0; r < rows.length - 1; r++) {
    const rr = rows[r]!;
    while (rr.length && isSpace(rr.at(-1)!.g)) rr.pop();
  }
  return rows.map(toLine);
}
