/**
 * GitHub tables to lines. Columns are sized to their content; when the table is too wide they are shrunk fairly
 * (narrow columns keep their width, wide ones share what is left) and cell text wraps within its column. When even
 * the narrowest fair layout cannot fit, each row becomes a small block of "header: value" lines.
 */
import type { Line, Span, Style } from "../full/types.js";
import type { Align, Block } from "./ast.js";
import type { Measurer } from "./measure.js";
import { markdownPieces } from "./render-inline.js";
import { compact, lineWidth, type Piece, wrapPieces } from "./text.js";
import type { Ctx } from "./ast.js";

/** A column is never squeezed below this many cells (or its content, if narrower) before the stacked form is used. */
export const MIN_COLUMN = 6;
const SEP = " │ ";
const SEP_STYLE: Style = { fg: "rule" };

type Table = Extract<Block, { k: "table" }>;

function naturalWidth(pieces: Piece[], m: Measurer): number {
  let w = 0;
  for (const line of wrapPieces(pieces, 1e9, m)) w = Math.max(w, lineWidth(line, m));
  return w;
}

function alignCell(line: Line, width: number, align: Align, m: Measurer): Line {
  const gap = width - lineWidth(line, m);
  if (gap <= 0) return line;
  if (align === "right") return compact([{ text: " ".repeat(gap) }, ...line]);
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return compact([{ text: " ".repeat(left) }, ...line, { text: " ".repeat(gap - left) }]);
  }
  return compact([...line, { text: " ".repeat(gap) }]);
}

/** Column widths that fit `avail`, or null when the table cannot fit even at the minimums. */
export function fitColumns(natural: number[], avail: number): number[] | null {
  const n = natural.length;
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= avail) return natural.map((w) => Math.max(1, w));
  const mins = natural.map((w) => Math.max(1, Math.min(w, MIN_COLUMN)));
  if (mins.reduce((a, b) => a + b, 0) > avail) return null;
  const widthsAt = (level: number) => natural.map((w, i) => Math.max(mins[i]!, Math.min(w, level)));
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  let lo = 0;
  let hi = Math.max(...natural);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sum(widthsAt(mid)) <= avail) lo = mid;
    else hi = mid - 1;
  }
  const widths = widthsAt(lo);
  let left = avail - sum(widths);
  for (let i = 0; i < n && left > 0; i++) {
    if (widths[i]! < natural[i]!) {
      widths[i]!++;
      left--;
    }
  }
  return widths;
}

export function renderTable(table: Table, width: number, ctx: Ctx, m: Measurer): Line[] {
  const cols = table.head.length;
  if (cols === 0) return [];
  const head = table.head.map((c) => markdownPieces(c, table.seq, ctx, { bold: true }));
  const rows = table.rows.map((r) => r.map((c) => markdownPieces(c, table.seq, ctx)));
  const sepW = m.width(SEP);
  const avail = width - sepW * (cols - 1);
  const natural: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = naturalWidth(head[c]!, m);
    for (const r of rows) w = Math.max(w, naturalWidth(r[c] ?? [], m));
    natural.push(w);
  }
  const widths = avail > 0 ? fitColumns(natural, avail) : null;
  if (!widths) return stacked(head, rows, table.head, width, m);

  const out: Line[] = [];
  const renderRow = (cells: Piece[][]) => {
    const wrapped = cells.map((p, c) => wrapPieces(p, widths[c]!, m));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    for (let k = 0; k < height; k++) {
      const line: Span[] = [];
      for (let c = 0; c < cols; c++) {
        if (c > 0) line.push({ text: SEP, style: SEP_STYLE });
        line.push(...alignCell(wrapped[c]![k] ?? [], widths[c]!, table.align[c] ?? null, m));
      }
      out.push(compact(trimRight(line)));
    }
  };
  renderRow(head);
  out.push([{ text: widths.map((w) => "─".repeat(w)).join("─┼─"), style: SEP_STYLE }]);
  for (const r of rows) renderRow(r);
  return out;
}

/** Trailing spaces of a row (from padding its last cell) are not drawn. */
function trimRight(line: Span[]): Span[] {
  const out = line.slice();
  while (out.length) {
    const last = out[out.length - 1]!;
    if (last.style?.bg) break;
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

function stacked(head: Piece[][], rows: Piece[][][], headText: string[], width: number, m: Measurer): Line[] {
  const out: Line[] = [];
  rows.forEach((row, r) => {
    if (r > 0) out.push([]);
    row.forEach((cell, c) => {
      const label: Piece[] = headText[c]!.trim() ? head[c]! : [{ text: `Column ${c + 1}`, style: { bold: true } }];
      out.push(...wrapPieces([...label, { text: ":", style: { bold: true } }, { text: " " }, ...cell], width, m));
    });
  });
  if (rows.length === 0) out.push(...wrapPieces(head.flatMap((h, i) => (i ? [{ text: " · ", style: SEP_STYLE }, ...h] : h)), width, m));
  return out;
}
