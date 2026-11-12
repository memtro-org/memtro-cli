/**
 * The block parser: lines to a tree of blocks.
 *
 * Aimed at what models and documentation actually write rather than at every CommonMark corner. Containers (quotes,
 * list items, MDX elements, admonitions) collect their lines and are parsed again one level down, so the cost is
 * the text's size times the nesting depth, and the depth is capped: beyond it, text is shown as it is.
 *
 * Streaming: a block is only ever extended by text that comes after it, so a block that was complete in a prefix
 * parses the same in any longer text. The exceptions are handled explicitly: an unclosed fence, element, comment or
 * front matter is an open block that runs to the end; and while streaming, a reference link only resolves against
 * definitions that came before it (a definition arriving later would otherwise reshape a paragraph already shown).
 */
import type { Align, Block, Ctx, ListItem } from "./ast.js";
import { normaliseLabel } from "./ast.js";
import { decodeEntities } from "./inlines.js";
import { parseInfo } from "./languages.js";
import { calloutKind, findBlockClose, INLINE_TAGS, mapElement, parseTag, VOID } from "./mdx.js";

/** Containers nested deeper than this are shown as plain text. */
export const MAX_DEPTH = 16;
/** A table wider than this many columns is shown as stacked rows (see table.ts); cells beyond it are dropped. */
export const MAX_COLUMNS = 1000;
/** After this many `<Tag` openings fail to match, a `<` at a line start is ordinary text. */
const MAX_JSX_FAILURES = 64;

const RE_FENCE = /^(`{3,}|~{3,})(.*)$/;
const RE_ATX = /^(#{1,6})(?:[ \t]+|$)/;
const RE_HR = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_BULLET = /^([*+-])(?=[ \t]|$)/;
const RE_ORDERED = /^(\d{1,9})([.)])(?=[ \t]|$)/;
const RE_SETEXT = /^(?:=+|-+)[ \t]*$/;
const RE_ADMON_OPEN = /^(:{3,})[ \t]*([A-Za-z][\w-]*)(.*)$/;
const RE_ADMON_CLOSE = /^(:{3,})[ \t]*$/;
const RE_DEF = /^\[((?:[^\]\\\n]|\\.){1,999})\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;
const RE_ESM = /^(?:import[ \t]+(?:type[ \t]+)?(?:["'{*]|[\w$]+[ \t]*(?:,|[ \t]from[ \t]))|export[ \t]+(?:const|let|var|function|class|default|async|type|interface|enum|\{|\*))/;
const RE_JSX_START = /^<(\/?)([A-Za-z][\w.:-]*)/;
const RE_SCHEME_START = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const RE_ALERT =/^\[!([A-Za-z]+)\][ \t]*(.*)$/;
const RE_FRONT_KEY = /^[\w-]+(?::|$)/;

const isBlank = (line: string): boolean => /^[ \t]*$/.test(line);

function indentOf(line: string): number {
  let i = 0;
  while (line.charCodeAt(i) === 32) i++;
  return i;
}

/** Leading tabs as spaces (stops of four), the way CommonMark measures indentation. */
function expandLeading(line: string): string {
  if (!/^ *\t/.test(line)) return line;
  let col = 0;
  let i = 0;
  let out = "";
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === " ") {
      out += " ";
      col++;
    } else if (c === "\t") {
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else break;
  }
  return out + line.slice(i);
}

function removeIndent(line: string, n: number): string {
  let i = 0;
  while (i < n && line[i] === " ") i++;
  return line.slice(i);
}

interface Marker {
  ordered: boolean;
  /** The bullet character, or the ordered delimiter. */
  ch: string;
  start: number;
  /** Columns from the marker's start to the item's content. */
  offset: number;
  /** The first line's content. */
  rest: string;
}

function listMarker(t: string): Marker | null {
  let m = RE_BULLET.exec(t);
  let ordered = false;
  let markerLen: number;
  let ch: string;
  let start = 1;
  if (m) {
    markerLen = 1;
    ch = m[1]!;
  } else {
    m = RE_ORDERED.exec(t);
    if (!m) return null;
    ordered = true;
    markerLen = m[0].length;
    ch = m[2]!;
    start = Number(m[1]);
  }
  const after = t.slice(markerLen);
  if (isBlank(after)) return { ordered, ch, start, offset: markerLen + 1, rest: "" };
  const spaces = indentOf(after);
  if (spaces >= 5) return { ordered, ch, start, offset: markerLen + 1, rest: after.slice(1) };
  return { ordered, ch, start, offset: markerLen + spaces, rest: after.slice(spaces) };
}

function fenceOpen(t: string): { marker: string; info: string } | null {
  const m = RE_FENCE.exec(t);
  if (!m) return null;
  if (m[1]![0] === "`" && m[2]!.includes("`")) return null;
  return { marker: m[1]!, info: m[2]! };
}

function closesFence(t: string, marker: string): boolean {
  const m = /^(`{3,}|~{3,})[ \t]*$/.exec(t);
  return !!m && m[1]![0] === marker[0] && m[1]!.length >= marker.length;
}

function isJsxStart(t: string, ctx: Ctx): boolean {
  if (ctx.jsxFailures >= MAX_JSX_FAILURES) return false;
  if (t.startsWith("<!--")) return !ctx.noCommentClose;
  // An autolink (`<https://…>`, `<mailto:…>`) or an address (`<me@example.com>`) is prose, never an element.
  if (RE_SCHEME_START.test(t)) return false;
  const m = RE_JSX_START.exec(t);
  if (!m) return false;
  const after = t[m[0].length];
  if (after !== undefined && !/[\s/>]/.test(after)) return false;
  return !INLINE_TAGS.has(m[2]!.toLowerCase());
}

/** Whether a line (indent under four, already stripped) starts a block that ends a paragraph. */
function interrupts(t: string, ctx: Ctx): boolean {
  if (RE_ATX.test(t) || fenceOpen(t) || RE_HR.test(t) || t.startsWith(">")) return true;
  const mk = listMarker(t);
  if (mk && mk.rest && (!mk.ordered || mk.start === 1)) return true;
  if (RE_ADMON_OPEN.test(t)) return true;
  return isJsxStart(t, ctx);
}

function isDelimRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !/^[|:\- \t]+$/.test(t)) return false;
  if (!t.includes("|") && !/^:?-+:?$/.test(t)) return false;
  const cells = splitRow(t);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Cells of a table row: split on unescaped pipes, outer pipes dropped, `\|` kept as a literal pipe. */
export function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      if (cells.length > MAX_COLUMNS) return cells;
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

/** Text of lines with a fence state, to tell whether a line in a container sits inside fenced code. */
class FenceTracker {
  marker: string | null = null;
  feed(t: string): void {
    const s = t.trimStart();
    if (this.marker) {
      if (closesFence(s, this.marker)) this.marker = null;
    } else {
      const f = fenceOpen(s);
      if (f && indentOf(t) < 4) this.marker = f.marker;
    }
  }
}

/** The source as lines, prepared once: CRLF already gone (sanitise), leading tabs expanded. */
export function toLines(text: string): string[] {
  return text.split("\n").map(expandLeading);
}

export function parseDocument(lines: string[], ctx: Ctx): Block[] {
  return parseBlocks(lines, ctx, 0, true);
}

/** Joined text and line offsets of a line array, for the element parser (built on first use). */
class Joined {
  text = "";
  starts: number[] = [];
  constructor(lines: string[]) {
    let off = 0;
    const parts: string[] = [];
    for (const l of lines) {
      this.starts.push(off);
      parts.push(l);
      off += l.length + 1;
    }
    this.text = parts.join("\n");
  }
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

export function parseBlocks(lines: string[], ctx: Ctx, depth: number, top: boolean): Block[] {
  if (depth > MAX_DEPTH) return lines.some((l) => !isBlank(l)) ? [{ k: "plain", lines: trimBlank(lines) }] : [];
  const out: Block[] = [];
  const n = lines.length;
  let joined: Joined | null = null;
  const join = () => (joined ??= new Joined(lines));
  let i = 0;

  if (top && n > 0 && /^---[ \t]*$/.test(lines[0]!)) {
    let close = -1;
    for (let j = 1; j < Math.min(n, 400); j++) {
      if (/^(---|\.\.\.)[ \t]*$/.test(lines[j]!)) {
        close = j;
        break;
      }
    }
    if (close > 0) i = close + 1;
    else if (ctx.streaming && n < 400 && (n === 1 || RE_FRONT_KEY.test(lines[1]!))) return [];
  }

  while (i < n) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);

    // Indented code.
    if (ind >= 4) {
      const body: string[] = [];
      let j = i;
      while (j < n && (isBlank(lines[j]!) || indentOf(lines[j]!) >= 4)) body.push(removeIndent(lines[j++]!, 4));
      while (body.length && isBlank(body[body.length - 1]!)) {
        body.pop();
      }
      out.push({ k: "code", lang: "", title: "", lines: body, open: false });
      i = j;
      continue;
    }

    const t = line.slice(ind);

    // Fenced code.
    const fence = fenceOpen(t);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const l = lines[j]!;
        if (indentOf(l) < 4 && closesFence(l.trimStart(), fence.marker)) {
          closed = true;
          j++;
          break;
        }
        body.push(removeIndent(l, ind));
        j++;
      }
      const info = parseInfo(decodeEntities(fence.info.replace(/\\([!-\/:-@\[-`{-~])/g, "$1")));
      out.push({ k: "code", lang: info.lang, title: info.title, lines: body, open: !closed });
      i = j;
      continue;
    }

    // ATX heading.
    if (RE_ATX.test(t)) {
      const level = /^#+/.exec(t)![0].length;
      let text = t.slice(level).trim();
      text = text.replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
      if (/^#+$/.test(text)) text = "";
      out.push({ k: "heading", level, text, seq: ctx.seq++ });
      i++;
      continue;
    }

    if (RE_HR.test(t)) {
      out.push({ k: "hr" });
      i++;
      continue;
    }

    // Block quote (and GitHub's alerts).
    if (t.startsWith(">")) {
      const inner: string[] = [];
      const fences = new FenceTracker();
      let lastPara = false;
      let j = i;
      while (j < n) {
        const l = lines[j]!;
        const li = indentOf(l);
        if (li < 4 && l[li] === ">") {
          let rest = l.slice(li + 1);
          if (rest.startsWith(" ")) rest = rest.slice(1);
          inner.push(rest);
          const wasFence = fences.marker !== null;
          fences.feed(rest);
          const rt = rest.trimStart();
          lastPara = !isBlank(rest) && !wasFence && fences.marker === null && !fenceOpen(rt) && !RE_ATX.test(rt) && !RE_HR.test(rt);
          j++;
          continue;
        }
        if (isBlank(l)) break;
        if (lastPara && li < 4 ? !interrupts(l.slice(li), ctx) : lastPara) {
          inner.push(l.trimStart());
          j++;
          continue;
        }
        break;
      }
      i = j;
      const alert = inner.length ? RE_ALERT.exec(inner[0]!.trim()) : null;
      if (alert) {
        const kind = calloutKind(alert[1]!);
        const body = inner.slice(1);
        out.push({ k: "callout", tone: kind.tone, label: kind.label, title: alert[2]!.trim(), children: parseBlocks(body, ctx, depth + 1, false) });
      } else out.push({ k: "quote", children: parseBlocks(inner, ctx, depth + 1, false) });
      continue;
    }

    // Lists.
    const first = listMarker(t);
    if (first) {
      const block = parseList(lines, i, ctx, depth);
      out.push(block.list);
      i = block.next;
      continue;
    }

    // Docusaurus admonitions: :::note Title … :::
    const admon = RE_ADMON_OPEN.exec(t);
    if (admon) {
      const colons = admon[1]!.length;
      const inner: string[] = [];
      const fences = new FenceTracker();
      let nest = 0;
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const l = lines[j]!;
        // Unclosed openers would each scan to the end: the work budget bounds that, then the rest is text.
        ctx.budget.n -= l.length + 1;
        if (ctx.budget.n < 0) break;
        const lt = l.trim();
        if (fences.marker === null) {
          const c = RE_ADMON_CLOSE.exec(lt);
          if (c && c[1]!.length === colons) {
            if (nest === 0) {
              closed = true;
              j++;
              break;
            }
            nest--;
          } else {
            const o = RE_ADMON_OPEN.exec(lt);
            if (o && o[1]!.length === colons) nest++;
          }
        }
        fences.feed(l);
        inner.push(l);
        j++;
      }
      if (closed || (ctx.streaming && ctx.budget.n >= 0)) {
        const kind = calloutKind(admon[2]!);
        const title = admon[3]!.trim().replace(/^\[(.*)\]$/, "$1").trim();
        out.push({ k: "callout", tone: kind.tone, label: kind.label, title, children: parseBlocks(inner, ctx, depth + 1, false) });
        i = j;
        continue;
      }
      // Unclosed when complete: shown as the text it is.
    }

    // MDX / HTML elements and comments.
    if (isJsxStart(t, ctx)) {
      const r = parseElement(lines, i, ind, ctx, depth, join());
      if (r) {
        out.push(...r.blocks);
        if (r.remainderAt !== null) {
          lines[r.next] = lines[r.next]!.slice(r.remainderAt);
          joined!.starts[r.next]! += r.remainderAt;
        }
        i = r.next;
        continue;
      }
      ctx.jsxFailures++;
    }

    // MDX import/export: plumbing, dropped (top level only; a paragraph's continuation is never read as one).
    if (top && ind === 0 && RE_ESM.test(t)) {
      let j = i;
      while (j < n && !isBlank(lines[j]!)) j++;
      i = j;
      continue;
    }

    // Table: a header row with a pipe and a delimiter row under it.
    if (t.includes("|") && i + 1 < n && isDelimRow(lines[i + 1]!)) {
      const table = parseTable(lines, i, ctx);
      out.push(table.block);
      i = table.next;
      continue;
    }

    // Link reference definitions at a paragraph's start.
    const def = RE_DEF.exec(t);
    if (def) {
      const label = normaliseLabel(def[1]!);
      let dest = def[2]!;
      if (dest.startsWith("<")) dest = dest.slice(1, -1);
      dest = decodeEntities(dest.replace(/\\([!-\/:-@\[-`{-~])/g, "$1"));
      if (label && !ctx.refs.has(label)) ctx.refs.set(label, { dest, seq: ctx.seq++ });
      i++;
      continue;
    }

    // Paragraph (or a setext heading).
    const buf: string[] = [t];
    let j = i + 1;
    let heading = 0;
    while (j < n) {
      const l = lines[j]!;
      if (isBlank(l)) break;
      const li = indentOf(l);
      const lt = l.slice(li);
      if (li < 4) {
        if (RE_SETEXT.test(lt)) {
          heading = lt[0] === "=" ? 1 : 2;
          j++;
          break;
        }
        if (interrupts(lt, ctx)) break;
        if (lt.includes("|") && j + 1 < n && isDelimRow(lines[j + 1]!)) break;
      }
      buf.push(lt);
      j++;
    }
    const text = buf.join("\n").replace(/[ \t]+$/, "");
    if (heading) out.push({ k: "heading", level: heading, text, seq: ctx.seq++ });
    else out.push({ k: "para", text, seq: ctx.seq++ });
    i = j;
  }
  return out;
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && isBlank(lines[a]!)) a++;
  while (b > a && isBlank(lines[b - 1]!)) b--;
  return lines.slice(a, b);
}

function parseList(lines: string[], start: number, ctx: Ctx, depth: number): { list: Block; next: number } {
  const n = lines.length;
  const firstLine = lines[start]!;
  const first = listMarker(firstLine.slice(indentOf(firstLine)))!;
  const items: ListItem[] = [];
  let loose = false;
  let j = start;
  let blankBetween = false;
  while (j < n) {
    const line = lines[j]!;
    const ind = indentOf(line);
    const mk = ind < 4 ? listMarker(line.slice(ind)) : null;
    if (!mk || mk.ordered !== first.ordered || mk.ch !== first.ch) break;
    if (j > start && RE_HR.test(line.slice(ind))) break;
    if (blankBetween) loose = true;
    const offset = ind + mk.offset;
    const body: string[] = [mk.rest];
    const fences = new FenceTracker();
    fences.feed(mk.rest);
    let lastPara = !isBlank(mk.rest) && fences.marker === null && !fenceOpen(mk.rest.trimStart());
    let blankRun = 0;
    j++;
    while (j < n) {
      const l = lines[j]!;
      if (isBlank(l)) {
        body.push("");
        blankRun++;
        j++;
        continue;
      }
      const li = indentOf(l);
      if (li >= offset) {
        const content = l.slice(offset);
        const wasFence = fences.marker !== null;
        fences.feed(content);
        lastPara = !wasFence && fences.marker === null && !fenceOpen(content.trimStart()) && !RE_ATX.test(content.trimStart());
        body.push(content);
        blankRun = 0;
        j++;
        continue;
      }
      if (blankRun === 0 && lastPara && fences.marker === null && !(li < 4 && interrupts(l.slice(li), ctx)) && !listMarker(l.slice(li))) {
        body.push(l.slice(li));
        j++;
        continue;
      }
      break;
    }
    // Blank lines at the item's end sit between items, not inside one.
    let trailing = 0;
    while (body.length > 1 && body[body.length - 1] === "") {
      body.pop();
      trailing++;
    }
    blankBetween = trailing > 0;
    if (!loose && hasInnerBlank(body)) loose = true;
    let task: boolean | null = null;
    const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0]!);
    if (tm) {
      task = tm[1] !== " ";
      body[0] = body[0]!.slice(tm[0].length);
    }
    items.push({ task, children: parseBlocks(body, ctx, depth + 1, false) });
  }
  return { list: { k: "list", ordered: first.ordered, start: first.start, delim: first.ch, loose, items }, next: j };
}

/** A blank line between two non-blank lines of an item, outside fenced code: the item's blocks are spaced. */
function hasInnerBlank(body: string[]): boolean {
  const fences = new FenceTracker();
  let seen = false;
  let pendingBlank = false;
  for (const l of body) {
    const inFence = fences.marker !== null;
    fences.feed(l);
    if (inFence) continue;
    if (isBlank(l)) {
      if (seen) pendingBlank = true;
      continue;
    }
    if (pendingBlank) return true;
    seen = true;
  }
  return false;
}

function parseTable(lines: string[], start: number, ctx: Ctx): { block: Block; next: number } {
  const head = splitRow(lines[start]!.trim());
  const delims = splitRow(lines[start + 1]!.trim());
  const cols = Math.min(head.length, MAX_COLUMNS);
  const align: Align[] = [];
  for (let c = 0; c < cols; c++) align.push(alignOf(delims[c] ?? ""));
  const rows: string[][] = [];
  let j = start + 2;
  while (j < lines.length) {
    const l = lines[j]!;
    if (isBlank(l)) break;
    const li = indentOf(l);
    const lt = l.slice(li);
    if (li < 4 && interrupts(lt, ctx)) break;
    const cells = splitRow(lt).slice(0, cols);
    while (cells.length < cols) cells.push("");
    rows.push(cells);
    j++;
  }
  return { block: { k: "table", head: head.slice(0, cols), align, rows, seq: ctx.seq++ }, next: j };
}

interface ElementResult {
  blocks: Block[];
  /** The line to continue from. */
  next: number;
  /** When the element ended mid-line with text after it: the column that text starts at on line `next`. */
  remainderAt: number | null;
}

function parseElement(lines: string[], i: number, ind: number, ctx: Ctx, depth: number, joined: Joined): ElementResult | null {
  const src = joined.text;
  const off = joined.starts[i]! + ind;
  const after = (end: number, blocks: Block[]): ElementResult => {
    if (end >= src.length) return { blocks, next: lines.length, remainderAt: null };
    const line = joined.lineOf(end);
    const lineEnd = line + 1 < joined.starts.length ? joined.starts[line + 1]! - 1 : src.length;
    const rest = src.slice(end, lineEnd);
    if (isBlank(rest)) return { blocks, next: line + 1, remainderAt: null };
    return { blocks, next: line, remainderAt: end - joined.starts[line]! };
  };
  if (src.startsWith("<!--", off)) {
    const end = src.indexOf("-->", off + 4);
    if (end < 0) {
      if (ctx.streaming) return { blocks: [], next: lines.length, remainderAt: null };
      ctx.noCommentClose = true; // no later comment can close either
      return null;
    }
    return after(end + 3, []);
  }
  const tag = parseTag(src, off);
  if (tag === "incomplete") return ctx.streaming ? { blocks: [], next: lines.length, remainderAt: null } : null;
  if (!tag || tag.closing) return null;
  if (tag.selfClosing || VOID.has(tag.lname)) return after(tag.end, mapElement(tag, [], ctx));
  const close = findBlockClose(src, tag.end, tag.lname, ctx);
  if (close === null) return null;
  let inner: string;
  let end: number;
  if (close === "eof") {
    if (!ctx.streaming) return null;
    inner = src.slice(tag.end);
    end = src.length;
  } else {
    inner = src.slice(tag.end, close.start);
    end = close.end;
  }
  const children = parseBlocks(dedent(inner), ctx, depth + 1, false);
  return after(end, mapElement(tag, children, ctx));
}

/** An element's children as lines: what follows the tag on its own line kept, the rest dedented together. */
function dedent(inner: string): string[] {
  const lines = inner.split("\n").map(expandLeading);
  const firstLine = lines[0]!.trim();
  const rest = lines.slice(1);
  let min = Number.POSITIVE_INFINITY;
  for (const l of rest) if (!isBlank(l)) min = Math.min(min, indentOf(l));
  const body = Number.isFinite(min) ? rest.map((l) => removeIndent(l, min)) : rest;
  return firstLine ? [firstLine, ...body] : body;
}
