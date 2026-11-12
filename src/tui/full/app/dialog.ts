import type { Frame, Input, Line } from "../types.js";
import { rank } from "./match.js";
import { clean, displayWidth, fg, fit, span, truncate, wrapLine } from "./text.js";

/**
 * One dialog component for the palette, the model picker, the session list, help and the tools: a title, a search
 * field that filters as you type, sections of rows, and a footer. Everything behind it is dimmed.
 */

export interface DialogRow {
  id: string;
  label: string;
  /** Right-aligned, muted: a key, a size, an age. */
  detail?: string;
  section?: string;
  current?: boolean;
  /** Shown in the warning colour after the label (a tool that acts). */
  flag?: string;
}

export type DialogKind = "palette" | "model" | "resume" | "help" | "tools" | "choice";

export interface DialogState {
  kind: DialogKind;
  title: string;
  query: string;
  rows: DialogRow[];
  /** One muted line under the search field. */
  note?: string;
  footer?: string;
  /** Rows are for reading only (help): nothing is selected and Enter closes. */
  readOnly?: boolean;
  /** Sections whose rows are set two to a line when the dialog is wide enough (help's short keys). */
  twoColumns?: string[];
  /** For `choice`: the command whose argument is chosen. */
  command?: string;
  selected: number;
  top: number;
}

export function openDialog(d: Omit<DialogState, "query" | "selected" | "top">): DialogState {
  const s: DialogState = { ...d, query: "", selected: 0, top: 0 };
  // Start on the current value when there is one.
  const rows = visibleRows(s);
  const cur = rows.findIndex((r) => r.current);
  return cur > 0 ? { ...s, selected: cur } : s;
}

/** The rows the search leaves, grouped by section in their original order, in rank order within a section. */
export function visibleRows(d: DialogState): DialogRow[] {
  if (!d.query.trim()) return d.rows;
  const ranked = rank(d.rows, d.query, (r) => r.label, (r) => `${r.detail ?? ""} ${r.section ?? ""}`).map((r) => r.item);
  const order: string[] = [];
  for (const r of d.rows) if (!order.includes(r.section ?? "")) order.push(r.section ?? "");
  return order.flatMap((sec) => ranked.filter((r) => (r.section ?? "") === sec));
}

type BodyLine = { kind: "heading"; text: string } | { kind: "blank" } | { kind: "row"; row: DialogRow; index: number; right?: { row: DialogRow; index: number } };

/** The body as lines: section headings, blanks between sections, rows (two to a line in two columns). */
export function bodyLines(d: DialogState, columns: 1 | 2): BodyLine[] {
  const rows = visibleRows(d);
  const out: BodyLine[] = [];
  let section: string | undefined;
  let pendingLeft: { row: DialogRow; index: number } | null = null;
  const flush = () => {
    if (pendingLeft) out.push({ kind: "row", ...pendingLeft });
    pendingLeft = null;
  };
  rows.forEach((row, index) => {
    if (row.section !== section) {
      flush();
      if (out.length) out.push({ kind: "blank" });
      if (row.section) out.push({ kind: "heading", text: row.section });
      section = row.section;
    }
    if (columns === 1 || !d.twoColumns?.includes(row.section ?? "")) out.push({ kind: "row", row, index });
    else if (!pendingLeft) pendingLeft = { row, index };
    else {
      out.push({ kind: "row", ...pendingLeft, right: { row, index } });
      pendingLeft = null;
    }
  });
  flush();
  return out;
}

export type DialogResult = { kind: "none" } | { kind: "close" } | { kind: "choose"; row: DialogRow };

/** Keys and pasted text in the dialog. Pure. */
export function dialogInput(d: DialogState, input: Input, bodyHeight: number): { dialog: DialogState; result: DialogResult } {
  const rows = visibleRows(d);
  const n = rows.length;
  const move = (delta: number, wrap: boolean): DialogState => {
    if (d.readOnly) return { ...d, top: Math.max(0, d.top + delta) };
    if (!n) return d;
    let selected = d.selected + delta;
    selected = wrap ? ((selected % n) + n) % n : Math.max(0, Math.min(n - 1, selected));
    return { ...d, selected };
  };
  const filter = (query: string): DialogState => ({ ...d, query, selected: 0, top: 0 });
  if (input.type === "paste") return { dialog: filter(d.query + clean(input.text)), result: { kind: "none" } };
  if (input.type !== "key") return { dialog: d, result: { kind: "none" } };
  const k = input;
  if (k.name === "escape" || (k.ctrl && k.name === "c")) return { dialog: d, result: { kind: "close" } };
  if (k.name === "up" || (k.ctrl && k.name === "p")) return { dialog: move(-1, true), result: { kind: "none" } };
  if (k.name === "down" || (k.ctrl && k.name === "n")) return { dialog: move(1, true), result: { kind: "none" } };
  if (k.name === "pageup") return { dialog: move(-Math.max(1, bodyHeight - 1), false), result: { kind: "none" } };
  if (k.name === "pagedown") return { dialog: move(Math.max(1, bodyHeight - 1), false), result: { kind: "none" } };
  if (k.name === "enter" || k.name === "return") {
    if (d.readOnly) return { dialog: d, result: { kind: "close" } };
    const row = rows[d.selected];
    return { dialog: d, result: row ? { kind: "choose", row } : { kind: "none" } };
  }
  if (k.name === "backspace") return { dialog: filter(Array.from(d.query).slice(0, -1).join("")), result: { kind: "none" } };
  if (k.ctrl && k.name === "u") return { dialog: filter(""), result: { kind: "none" } };
  if (k.text && !k.ctrl && !k.alt) return { dialog: filter(d.query + clean(k.text)), result: { kind: "none" } };
  return { dialog: d, result: { kind: "none" } };
}

export interface DialogGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  bodyY: number;
  bodyHeight: number;
  columns: 1 | 2;
}

/** The note under the search field, wrapped to the dialog's inner width. */
export function noteLines(d: DialogState, width: number): Line[] {
  return d.note ? wrapLine([span(clean(d.note), fg("muted", { bg: "dialog" }))], Math.max(1, width - 6)) : [];
}

/** The footer, wrapped to the dialog's inner width (it is never cut). */
export function footerLines(d: DialogState, width: number): Line[] {
  return d.footer ? wrapLine([span(clean(d.footer), fg("muted", { bg: "dialog" }))], Math.max(1, width - 6)) : [];
}

export function dialogGeometry(d: DialogState, fw: number, fh: number): DialogGeometry {
  const wide = Boolean(d.twoColumns?.length) && fw >= 104;
  const width = Math.max(20, Math.min(wide ? 100 : 64, fw - 4));
  const columns: 1 | 2 = wide ? 2 : 1;
  const notes = noteLines(d, width).length;
  const footer = footerLines(d, width).length;
  // pad, title, blank, search, (blank, note…), blank, body…, (blank, footer…), pad
  const fixed = 1 + 1 + 1 + (d.readOnly ? 0 : 1) + (notes ? notes + 1 : 0) + 1 + (footer ? footer + 1 : 0) + 1;
  // At most about half the screen of rows: a long list scrolls rather than filling the terminal.
  const wanted = Math.max(1, Math.min(bodyLines(d, columns).length, Math.max(8, Math.floor(fh / 2))));
  let y = Math.floor(fh / 4);
  let bodyHeight = Math.min(wanted, Math.max(1, fh - y - 1 - fixed));
  if (bodyHeight < wanted && y > 1) {
    y = Math.max(1, fh - 1 - fixed - wanted);
    bodyHeight = Math.min(wanted, Math.max(1, fh - y - 1 - fixed));
  }
  const height = Math.min(fh, fixed + bodyHeight);
  const x = Math.max(0, Math.floor((fw - width) / 2));
  const bodyY = y + 1 + 1 + 1 + (d.readOnly ? 0 : 1) + (notes ? notes + 1 : 0) + 1;
  return { x, y, width, height, bodyY, bodyHeight, columns };
}

/** The scroll that keeps the selected row in view. */
export function keepSelectedInView(d: DialogState, g: DialogGeometry): DialogState {
  const lines = bodyLines(d, g.columns);
  const max = Math.max(0, lines.length - g.bodyHeight);
  if (d.readOnly) return d.top > max ? { ...d, top: max } : d;
  const at = lines.findIndex((l) => l.kind === "row" && (l.index === d.selected || l.right?.index === d.selected));
  let top = Math.min(d.top, max);
  if (at >= 0) {
    // Show the section heading above the first row of a section when scrolling up to it.
    const headingAbove = at > 0 && lines[at - 1]!.kind === "heading" ? at - 1 : at;
    if (headingAbove < top) top = headingAbove;
    if (at >= top + g.bodyHeight) top = at - g.bodyHeight + 1;
  }
  return top === d.top ? d : { ...d, top };
}

export function drawDialog(d0: DialogState, frame: Frame, o: { noColour: boolean; cursorBlink?: boolean }): DialogGeometry {
  const g = dialogGeometry(d0, frame.width, frame.height);
  const d = keepSelectedInView(d0, g);
  frame.dim({ x: 0, y: 0, width: frame.width, height: frame.height });
  frame.fill({ x: g.x, y: g.y, width: g.width, height: g.height }, "dialog");
  const ix = g.x + 3;
  const iw = g.width - 6;
  let y = g.y + 1;
  const esc = "esc";
  frame.text(ix, y, [span(clean(d.title), fg("text", { bold: true, bg: "dialog" }))], iw - esc.length - 1);
  frame.text(ix + iw - esc.length, y, [span(esc, fg("muted", { bg: "dialog" }))], esc.length);
  y += 2;
  if (!d.readOnly) {
    const q = d.query;
    if (q) frame.text(ix, y, [span(q, fg("text", { bg: "dialog" }))], iw);
    else frame.text(ix, y, [span("Search", fg("faint", { bg: "dialog" }))], iw);
    frame.cursor = { x: ix + Math.min(iw - 1, displayWidth(q)), y };
    y += 1;
  } else frame.cursor = null;
  const notes = noteLines(d, g.width);
  if (notes.length) {
    y += 1;
    for (const l of notes) frame.text(ix, y++, l, iw);
  }
  const lines = bodyLines(d, g.columns);
  const rows = visibleRows(d);
  if (!rows.length) frame.text(ix, g.bodyY, [span(d.query ? "Nothing matches." : "Nothing here.", fg("muted", { bg: "dialog" }))], iw);
  const half = Math.floor((iw - 2) / 2);
  const paired = (row: DialogRow) => g.columns === 2 && Boolean(d.twoColumns?.includes(row.section ?? ""));
  const marks = d.rows.some((r) => r.current);
  // Help: each section's key column as wide as its widest key, up to half the row.
  const keyW = new Map<string, number>();
  if (d.kind === "help") {
    for (const r of d.rows) {
      const sec = r.section ?? "";
      const cap = Math.floor((paired(r) ? half : iw) / 2);
      keyW.set(sec, Math.min(cap, Math.max(keyW.get(sec) ?? 0, displayWidth(clean(r.label)) + 2)));
    }
  }
  for (let i = 0; i < g.bodyHeight; i++) {
    const l = lines[d.top + i];
    if (!l) break;
    const ly = g.bodyY + i;
    if (l.kind === "heading") frame.text(ix, ly, [span(clean(l.text), fg("heading", { bold: true, bg: "dialog" }))], iw);
    else if (l.kind === "row") {
      const colW = paired(l.row) ? half : iw;
      drawRow(frame, ix, ly, colW, l.row, !d.readOnly && l.index === d.selected, marks, o.noColour, keyW.get(l.row.section ?? ""));
      if (l.right) drawRow(frame, ix + colW + 2, ly, colW, l.right.row, !d.readOnly && l.right.index === d.selected, marks, o.noColour, keyW.get(l.right.row.section ?? ""));
    }
  }
  if (lines.length > g.bodyHeight) {
    const more = d.top + g.bodyHeight < lines.length ? "more below" : "";
    const above = d.top > 0 ? "more above" : "";
    const text = [above, more].filter(Boolean).join(" · ");
    if (text) frame.text(ix + iw - displayWidth(text), g.bodyY + g.bodyHeight, [span(text, fg("faint", { bg: "dialog" }))], displayWidth(text));
  }
  const footer = footerLines(d, g.width);
  footer.forEach((l, i) => frame.text(ix, g.y + g.height - 1 - footer.length + i, l, iw));
  return g;
}

/** One row. With `keyW` (help) the label is a key in a column that wide, and the detail follows it from the left. */
function drawRow(frame: Frame, x: number, y: number, width: number, row: DialogRow, selected: boolean, marks: boolean, noColour: boolean, keyW?: number): void {
  const on = selected && !noColour;
  const bg = on ? "accent" : "dialog";
  const text = fg(on ? "onAccent" : "text", { bg, bold: on });
  const quiet = fg(on ? "onAccent" : "muted", { bg });
  const left: Line = [];
  if (noColour) left.push(span(selected ? "> " : "  ", text));
  if (marks) left.push(span(row.current ? "● " : "  ", on ? text : fg("accent", { bg })));
  const detail = row.detail ? clean(row.detail) : "";
  if (keyW !== undefined) {
    const line: Line = [...left, ...fit([span(clean(row.label), fg(on ? "onAccent" : "text", { bg, bold: true }))], keyW), span(" "), span(detail, quiet)];
    frame.fill({ x: x - 1, y, width: width + 2, height: 1 }, bg);
    frame.text(x, y, truncate(line, width, true), width);
    return;
  }
  left.push(span(clean(row.label), text));
  if (row.flag) left.push(span(` ${clean(row.flag)}`, on ? quiet : fg("warning", { bg })));
  const dw = Math.min(displayWidth(detail), Math.floor(width / 2));
  const lw = Math.max(1, width - (dw ? dw + 2 : 0));
  const line: Line = [...fit(truncate(left, lw, true), lw, bg), ...(dw ? [span("  ", { bg }), ...truncate([span(detail, quiet)], dw, true)] : [])];
  frame.fill({ x: x - 2, y, width: width + 4, height: 1 }, bg);
  frame.text(x, y, line, width);
}
