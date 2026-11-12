/**
 * Styled text to lines: measuring, wrapping on word boundaries, cutting and padding, always by display width and
 * never inside a grapheme.
 */
import type { Line, Span, Style } from "../full/types.js";
import type { Measurer } from "./measure.js";

/** A run of styled text inside a paragraph, or a hard line break. Text has no newlines, tabs or controls. */
export type Piece = { text: string; style?: Style } | { br: true };

export function isBreak(p: Piece): p is { br: true } {
  return "br" in p;
}

export function sameStyle(a: Style | undefined, b: Style | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return isPlain(a) && isPlain(b);
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    a.link === b.link
  );
}

function isPlain(s: Style | undefined): boolean {
  return !s || (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline && !s.strike && !s.link);
}

/** `extra` over `base`: later wins for colours and the link, flags accumulate. */
export function mergeStyle(base: Style | undefined, extra: Style | undefined): Style | undefined {
  if (!extra) return base;
  if (!base) return extra;
  const out: Style = { ...base };
  for (const [k, v] of Object.entries(extra) as [keyof Style, never][]) if (v !== undefined) out[k] = v;
  return out;
}

/** A span list with neighbours of the same style joined and empty spans dropped. */
export function compact(line: Line): Line {
  const out: Line = [];
  for (const span of line) {
    if (!span.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, span.style)) out[out.length - 1] = { text: last.text + span.text, style: last.style };
    else out.push(span.style && !isPlain(span.style) ? { text: span.text, style: span.style } : { text: span.text });
  }
  return out;
}

/** The widest layout drawn; a larger (or infinite) width is drawn at this. */
export const MAX_WIDTH = 4096;

/** A requested width as whole cells between 1 and `MAX_WIDTH` (NaN and anything below 1 read as 1). */
export function clampWidth(width: number): number {
  return width >= 1 ? Math.min(MAX_WIDTH, Math.floor(width)) : 1;
}

export function lineWidth(line: Line, m: Measurer): number {
  let w = 0;
  for (const s of line) w += m.width(s.text);
  return w;
}

/** The line padded with spaces in `style` to exactly `width` (or left as it is when already as wide). */
export function padLine(line: Line, width: number, m: Measurer, style?: Style): Line {
  const w = lineWidth(line, m);
  if (w >= width) return line;
  return compact([...line, { text: " ".repeat(width - w), style }]);
}

/** The line cut to `width` cells, never splitting a grapheme; a wide character that would straddle is dropped. */
export function cutLine(line: Line, width: number, m: Measurer): Line {
  const out: Line = [];
  let used = 0;
  for (const span of line) {
    const w = m.width(span.text);
    if (used + w <= width) {
      out.push(span);
      used += w;
      continue;
    }
    let text = "";
    for (const g of m.graphemes(span.text)) {
      const gw = m.cell(g);
      if (used + gw > width) break;
      text += g;
      used += gw;
    }
    if (text) out.push({ text, style: span.style });
    break;
  }
  return out;
}

/** Tabs as spaces to the next multiple of `stop`, counted in display cells. */
export function expandTabs(text: string, m: Measurer, stop = 4): string {
  if (!text.includes("\t")) return text;
  let out = "";
  let col = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\t") continue;
    const before = text.slice(start, i);
    out += before;
    col += m.width(before);
    const n = stop - (col % stop);
    out += " ".repeat(n);
    col += n;
    start = i + 1;
  }
  return out + text.slice(start);
}

interface Word {
  parts: Span[];
  width: number;
  gap: Span[];
  gapWidth: number;
}
type Token = Word | { br: true };

const SPACE_RUN = /( +)|([^ ]+)/g;
const NARROW_ONLY = /^[\x20-\x7e\u00a0-\u02ff]*$/;

/**
 * Splits pieces into words (runs that may not be broken) and the gaps between them. A wide character (CJK) is a
 * word of its own, so text without spaces can still wrap between characters.
 */
function tokenize(pieces: Piece[], m: Measurer): Token[] {
  const out: Token[] = [];
  let word: Word | null = null;
  let gap: Span[] = [];
  let gapWidth = 0;
  let forceNew = true;
  const startWord = (): Word => {
    const w: Word = { parts: [], width: 0, gap, gapWidth };
    gap = [];
    gapWidth = 0;
    out.push(w);
    word = w;
    forceNew = false;
    return w;
  };
  for (const p of pieces) {
    if (isBreak(p)) {
      out.push({ br: true });
      word = null;
      gap = [];
      gapWidth = 0;
      forceNew = true;
      continue;
    }
    const text = p.text.replace(/[\t\n]/g, " ");
    SPACE_RUN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPACE_RUN.exec(text))) {
      if (match[1]) {
        gap.push({ text: match[1], style: p.style });
        gapWidth += match[1].length;
        forceNew = true;
        continue;
      }
      const run = match[2]!;
      if (NARROW_ONLY.test(run)) {
        const w = forceNew || !word ? startWord() : (word as Word);
        w.parts.push({ text: run, style: p.style });
        w.width += run.length;
        continue;
      }
      // Anything else is segmented once and measured a grapheme at a time (never re-segmenting a grapheme: that
      // made 100k characters of binary junk cost a quarter of a second). Every wide grapheme is a word of its own.
      let narrow = "";
      let narrowW = 0;
      const flushNarrow = () => {
        if (!narrow) return;
        const w = forceNew || !word ? startWord() : (word as Word);
        w.parts.push({ text: narrow, style: p.style });
        w.width += narrowW;
        narrow = "";
        narrowW = 0;
      };
      for (const g of m.graphemes(run)) {
        const gw = m.cell(g);
        if (gw >= 2) {
          flushNarrow();
          forceNew = true;
          const w = startWord();
          w.parts.push({ text: g, style: p.style });
          w.width += gw;
          forceNew = true;
        } else {
          narrow += g;
          narrowW += gw;
        }
      }
      flushNarrow();
    }
  }
  return out;
}

/** Characters after which a long unbreakable word (an address, a path) is best broken. */
const SOFT_BREAK_AFTER = new Set(["/", "?", "&", "=", "-", "_", ".", ",", "#", ":", ";", ")"]);

/**
 * Pieces wrapped to `width` cells on word boundaries. A word wider than the line is broken by grapheme, at a
 * separator near the end of the line when there is one. Spaces at a wrap are dropped. Returns no lines for
 * nothing, and every line is at most `width` wide.
 */
export function wrapPieces(pieces: Piece[], width: number, m: Measurer): Line[] {
  const w = Math.max(1, Math.floor(width));
  const lines: Line[] = [];
  let cur: Span[] = [];
  let curW = 0;
  let any = false;
  const push = () => {
    lines.push(compact(cur));
    cur = [];
    curW = 0;
  };
  for (const tok of tokenize(pieces, m)) {
    if ("br" in tok) {
      push();
      any = true;
      continue;
    }
    any = true;
    const gapW = curW > 0 ? tok.gapWidth : 0;
    if (curW + gapW + tok.width <= w) {
      if (curW > 0) cur.push(...tok.gap);
      cur.push(...tok.parts);
      curW += gapW + tok.width;
      continue;
    }
    if (tok.width <= w) {
      if (curW > 0) push();
      cur.push(...tok.parts);
      curW = tok.width;
      continue;
    }
    // Wider than a whole line: start it on a fresh line unless the current one has plenty of room.
    if (curW > 0 && (curW + gapW > w / 2 || w - curW - gapW < 8)) push();
    else if (curW > 0) {
      cur.push(...tok.gap);
      curW += gapW;
    }
    const gs: { g: string; style?: Style; w: number }[] = [];
    for (const part of tok.parts) for (const g of m.graphemes(part.text)) gs.push({ g, style: part.style, w: m.cell(g) });
    let i = 0;
    while (i < gs.length) {
      let room = w - curW;
      // Take as many graphemes as fit.
      let j = i;
      let used = 0;
      while (j < gs.length && used + gs[j]!.w <= room) used += gs[j++]!.w;
      if (j === i) {
        if (curW > 0) {
          push();
          continue;
        }
        // A wide character on a line one cell wide: show a stand-in rather than overflow.
        cur.push({ text: "?", style: gs[i]!.style });
        curW = 1;
        i++;
        push();
        continue;
      }
      if (j < gs.length) {
        // Prefer to break just after a separator in the last part of the chunk.
        const floor = i + Math.ceil((j - i) * 0.6);
        for (let k = j - 1; k >= floor; k--) {
          if (SOFT_BREAK_AFTER.has(gs[k]!.g)) {
            j = k + 1;
            break;
          }
        }
      }
      for (let k = i; k < j; k++) cur.push({ text: gs[k]!.g, style: gs[k]!.style });
      for (let k = i; k < j; k++) curW += gs[k]!.w;
      i = j;
      if (i < gs.length) push();
      room = 0;
    }
  }
  if (cur.length || (any && lines.length === 0)) push();
  // Trailing spaces never matter and would only make a line look wider than it is.
  return lines.map(trimEnd).filter((l, idx, all) => l.length > 0 || idx < all.length - 1 || all.length === 1);
}

function trimEnd(line: Line): Line {
  const out = line.slice();
  while (out.length) {
    const last = out[out.length - 1]!;
    const t = last.text.replace(/ +$/, "");
    if (t === last.text) break;
    if (t) {
      out[out.length - 1] = { text: t, style: last.style };
      break;
    }
    out.pop();
  }
  return out;
}

/** Each line with `first` before the first line and `rest` before the others. */
export function prefixLines(lines: Line[], first: Line, rest: Line): Line[] {
  return lines.map((l, i) => compact([...(i === 0 ? first : rest), ...l]));
}

/** Plain text of pieces, for comparisons and alt text. */
export function piecesText(pieces: Piece[]): string {
  let s = "";
  for (const p of pieces) s += isBreak(p) ? " " : p.text;
  return s;
}
