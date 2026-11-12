/**
 * A unified diff to lines: file headers, hunk headers, context, added and removed rows with their backgrounds
 * across the full width, old and new line numbers in a muted gutter when the hunk headers give them, the changed
 * part of a replaced line picked out when the two lines are alike, long lines wrapped. Everything is cleaned.
 */
import type { Line, RenderDiff, Role, Span, Style } from "../full/types.js";
import { sanitise } from "../sanitise.js";
import { measurer, type Measure, type Measurer } from "./measure.js";
import { clampWidth, compact, cutLine, expandTabs, lineWidth, padLine } from "./text.js";

interface Row {
  kind: "file" | "hunk" | "meta" | "note" | "text" | "context" | "added" | "removed";
  text: string;
  old?: number | null;
  new?: number | null;
  /** The changed part of a replaced line, as code-unit offsets. */
  changed?: [number, number];
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+/;
const FILE_META = /^(diff --git |diff -|index |new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|old mode|new mode|Binary files|GIT binary patch)/;

function parse(text: string): { rows: Row[]; numbered: boolean } {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  let numbered = false;
  for (const line of text.split("\n")) {
    const counted = inHunk && (oldLeft > 0 || newLeft > 0);
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      numbered = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (counted) {
      const c = line[0];
      if (c === "+" && newLeft > 0) {
        rows.push({ kind: "added", text: line.slice(1), old: null, new: newNo++ });
        newLeft--;
        continue;
      }
      if (c === "-" && oldLeft > 0) {
        rows.push({ kind: "removed", text: line.slice(1), old: oldNo++, new: null });
        oldLeft--;
        continue;
      }
      if ((c === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        rows.push({ kind: "context", text: line.slice(1), old: oldNo++, new: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: line });
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      inHunk = false;
      rows.push({ kind: "file", text: line });
      continue;
    }
    if (FILE_META.test(line)) {
      inHunk = false;
      rows.push({ kind: "meta", text: line });
      continue;
    }
    // A diff without hunk headers (or past their counts): read the marker alone.
    if (!counted && line.startsWith("+")) rows.push({ kind: "added", text: line.slice(1), old: null, new: null });
    else if (!counted && line.startsWith("-")) rows.push({ kind: "removed", text: line.slice(1), old: null, new: null });
    else if (!counted && line.startsWith(" ")) rows.push({ kind: "context", text: line.slice(1), old: null, new: null });
    else rows.push({ kind: "text", text: line });
  }
  while (rows.length && rows[rows.length - 1]!.kind === "text" && !rows[rows.length - 1]!.text) rows.pop();
  return { rows, numbered };
}

/** Marks the changed middle of each removed/added pair that is mostly the same line. Linear per pair. */
function markChanges(rows: Row[], m: Measurer): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== "removed") {
      i++;
      continue;
    }
    let r = i;
    while (r < rows.length && rows[r]!.kind === "removed") r++;
    let a = r;
    while (a < rows.length && rows[a]!.kind === "added") a++;
    const removed = rows.slice(i, r);
    const added = rows.slice(r, a);
    for (let k = 0; k < Math.min(removed.length, added.length); k++) {
      const x = removed[k]!;
      const y = added[k]!;
      if (x.text.length > 4000 || y.text.length > 4000) continue;
      const gx = m.graphemes(x.text);
      const gy = m.graphemes(y.text);
      let pre = 0;
      while (pre < gx.length && pre < gy.length && gx[pre] === gy[pre]) pre++;
      let suf = 0;
      while (suf < gx.length - pre && suf < gy.length - pre && gx[gx.length - 1 - suf] === gy[gy.length - 1 - suf]) suf++;
      const same = pre + suf;
      const longest = Math.max(gx.length, gy.length);
      if (longest === 0 || same / longest < 0.4 || same === longest) continue;
      const cx = [pre, gx.length - suf] as [number, number];
      const cy = [pre, gy.length - suf] as [number, number];
      // Store as code-unit offsets.
      x.changed = [gx.slice(0, cx[0]).join("").length, gx.slice(0, cx[1]).join("").length];
      y.changed = [gy.slice(0, cy[0]).join("").length, gy.slice(0, cy[1]).join("").length];
    }
    i = Math.max(a, i + 1);
  }
}

/** Graphemes of styled text in chunks of at most `width` cells. */
function chunk(spans: Span[], width: number, m: Measurer): Line[] {
  const out: Line[] = [];
  let cur: Span[] = [];
  let w = 0;
  for (const s of spans) {
    if (w + m.width(s.text) <= width) {
      cur.push(s);
      w += m.width(s.text);
      continue;
    }
    for (const g of m.graphemes(s.text)) {
      const gw = m.width(g);
      if (w + gw > width && w > 0) {
        out.push(cur);
        cur = [];
        w = 0;
      }
      if (gw > width) continue;
      cur.push({ text: g, style: s.style });
      w += gw;
    }
  }
  out.push(cur);
  return out.map(compact);
}

export function diffToLines(diff: string, width: number, m: Measurer): Line[] {
  const W = clampWidth(width);
  const clean = sanitise(diff);
  const { rows, numbered } = parse(clean.replace(/\n$/, ""));
  for (const r of rows) r.text = expandTabs(r.text, m);
  markChanges(rows, m);
  let maxNo = 0;
  for (const r of rows) maxNo = Math.max(maxNo, r.old ?? 0, r.new ?? 0);
  const digits = String(maxNo).length;
  // Gutter: "old new " then the marker and a space; dropped when the line is too narrow to spare it.
  const showNumbers = numbered && W >= digits * 2 + 2 + 2 + 12;
  const gutterW = showNumbers ? digits * 2 + 2 : 0;
  const markerW = W >= 6 ? 2 : 0;
  const textW = Math.max(1, W - gutterW - markerW);
  const out: Line[] = [];
  for (const r of rows) {
    if (r.kind === "file" || r.kind === "meta" || r.kind === "hunk" || r.kind === "note" || r.kind === "text") {
      const style: Style =
        r.kind === "file" ? { bold: true } : r.kind === "meta" ? { fg: "muted", bold: true } : r.kind === "hunk" ? { fg: "info" } : r.kind === "note" ? { fg: "muted", italic: true } : {};
      const text = expandTabs(r.text, m);
      for (const l of chunk([{ text, style }], W, m)) out.push(l);
      continue;
    }
    const bg: Role | undefined = r.kind === "added" ? "addedBg" : r.kind === "removed" ? "removedBg" : undefined;
    const fg: Role = r.kind === "added" ? "added" : r.kind === "removed" ? "removed" : "text";
    const base: Style = bg ? { bg } : {};
    const text = r.text;
    let spans: Span[];
    if (r.kind !== "context" && r.changed) {
      const [a, b] = r.changed;
      spans = [
        { text: expandTabs(text.slice(0, a), m), style: base },
        { text: text.slice(a, b), style: { fg: "page", bg: fg, bold: true } },
        { text: expandTabs(text.slice(b), m), style: base },
      ];
    } else spans = [{ text: expandTabs(text, m), style: r.kind === "context" ? undefined : base }];
    const marker = r.kind === "added" ? "+" : r.kind === "removed" ? "-" : " ";
    const gutterStyle: Style = { fg: "muted", ...(bg ? { bg } : {}) };
    const pieces = chunk(spans, textW, m);
    pieces.forEach((piece, idx) => {
      const line: Span[] = [];
      if (gutterW) {
        const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v)).padStart(digits);
        line.push({ text: idx === 0 ? `${num(r.old)} ${num(r.new)} ` : " ".repeat(gutterW), style: gutterStyle });
      }
      if (markerW) line.push({ text: idx === 0 ? `${marker} ` : "↪ ", style: { fg: idx === 0 ? fg : "muted", ...(bg ? { bg } : {}), ...(idx === 0 && bg ? { bold: true } : {}) } });
      line.push(...piece);
      const full = compact(line);
      out.push(bg ? padLine(full, W, m, { bg }) : full);
    });
  }
  return out.map((l) => (lineWidth(l, m) > W ? cutLine(l, W, m) : l));
}

export const renderDiff: RenderDiff & ((diff: string, options: { width: number; measure?: Measure }) => Line[]) = (diff, options) =>
  diffToLines(diff, options.width, measurer((options as { measure?: Measure }).measure));
