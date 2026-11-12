/** Blocks to lines at a width: headings, paragraphs, lists, quotes, callouts, code, tables, MDX sections. */
import type { Line, Role, Span, Style } from "../full/types.js";
import type { Block, CalloutTone, Ctx } from "./ast.js";
import { highlightLines } from "./code.js";
import { address } from "./links.js";
import type { Measurer } from "./measure.js";
import { imagePieces, markdownPieces } from "./render-inline.js";
import { renderTable } from "./table.js";
import { compact, cutLine, expandTabs, lineWidth, mergeStyle, padLine, type Piece, prefixLines, wrapPieces } from "./text.js";

/** A container is drawn without its own indent or bar when that would leave its content less than this. */
const MIN_INNER = 10;

export interface Env {
  m: Measurer;
  ctx: Ctx;
  /** How many lists deep (for the bullet glyph). */
  listDepth: number;
}

const BULLETS = ["•", "◦", "▪"];
const TONE: Record<CalloutTone, Role> = { info: "info", success: "success", warning: "warning", danger: "danger", heading: "heading" };

const HEADING_STYLE: Style[] = [
  { fg: "heading", bold: true },
  { fg: "heading", bold: true },
  { fg: "heading", bold: true },
  { bold: true },
  { bold: true, fg: "muted" },
  { italic: true, fg: "muted" },
];

/** Blocks with a blank line between each two that drew something (none when `tight`). */
export function renderBlocks(blocks: Block[], width: number, env: Env, tight = false): Line[] {
  const out: Line[] = [];
  for (const b of blocks) {
    const lines = renderBlock(b, width, env);
    if (!lines.length) continue;
    if (out.length && !tight) out.push([]);
    out.push(...lines);
  }
  return out;
}

/** Lines of `inner`, drawn `prefixW` cells in from the left with the given prefixes, or flush when too narrow. */
function contained(width: number, prefixW: number, draw: (inner: number) => Line[], first: Line, rest: Line): Line[] {
  if (width - prefixW < MIN_INNER) return draw(width);
  const lines = prefixLines(draw(width - prefixW), first, rest);
  // A blank line inside a container shows the bar alone, without the space after it.
  return lines.map((l, i) => (i > 0 && l.length === rest.length && rest.every((s, k) => s.text === l[k]?.text) ? trimSpaces(l) : l));
}

function trimSpaces(line: Line): Line {
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

function pieces(text: string, seq: number, env: Env, base?: Style): Piece[] {
  return markdownPieces(text, seq, env.ctx, base);
}

export function renderBlock(b: Block, width: number, env: Env): Line[] {
  const { m } = env;
  switch (b.k) {
    case "para": {
      const base: Style | undefined = b.strong ? { bold: true } : b.muted ? { fg: "muted", italic: true } : undefined;
      return trimEmpty(wrapPieces(pieces(b.text, b.seq, env, base), width, m));
    }
    case "heading": {
      const style = HEADING_STYLE[Math.min(5, b.level - 1)]!;
      const lines = b.text ? wrapPieces(pieces(b.text, b.seq, env, style), width, m) : [];
      if (b.level === 1) lines.push([{ text: "━".repeat(width), style: { fg: "heading" } }]);
      else if (b.level === 2) lines.push([{ text: "─".repeat(width), style: { fg: "rule" } }]);
      return lines;
    }
    case "hr":
      return [[{ text: "─".repeat(width), style: { fg: "rule" } }]];
    case "code":
      return renderCode(b, width, m);
    case "quote": {
      const bar: Line = [{ text: "│ ", style: { fg: "muted" } }];
      const lines = contained(width, 2, (w) => renderBlocks(b.children, w, env), bar, bar);
      return lines.length ? lines : [[{ text: "│", style: { fg: "muted" } }]];
    }
    case "callout": {
      const tone = TONE[b.tone];
      const bar: Line = [{ text: "┃ ", style: { fg: tone } }];
      return contained(
        width,
        2,
        (w) => {
          const head: Piece[] = [{ text: b.label, style: { fg: tone, bold: true } }];
          if (b.title) head.push({ text: " " }, ...pieces(b.title, env.ctx.seq, env, { bold: true }));
          const body = renderBlocks(b.children, w, env);
          return [...wrapPieces(head, w, m), ...body];
        },
        bar,
        bar,
      );
    }
    case "list":
      return renderList(b, width, env);
    case "table":
      return renderTable(b, width, env.ctx, m);
    case "section":
      return renderSection(b, width, env);
    case "image": {
      return wrapPieces(imagePieces(b.alt, b.url, undefined), width, m);
    }
    case "plain": {
      const out: Line[] = [];
      for (const l of b.lines) {
        const text = expandTabs(l, m);
        if (!text.trim()) out.push([]);
        else out.push(...wrapPieces([{ text }], width, m));
      }
      return out;
    }
  }
}

function renderSection(b: Extract<Block, { k: "section" }>, width: number, env: Env): Line[] {
  const { m } = env;
  const title: Piece[] = b.title ? pieces(b.title, env.ctx.seq, env, { bold: true, ...(b.style === "tab" ? { fg: "heading" } : {}) }) : [];
  if (b.href) {
    const addr = address(b.href);
    title.push({ text: " " }, { text: `(${addr.shown})`, style: { fg: "muted", ...(addr.link ? { link: addr.link } : {}) } });
  }
  if (b.style === "details") {
    const head = wrapPieces([{ text: "▸ ", style: { fg: "muted" } }, ...title], width, m);
    const body = contained(width, 2, (w) => renderBlocks(b.children, w, env), [{ text: "  " }], [{ text: "  " }]);
    return [...head, ...body];
  }
  const head = title.length ? wrapPieces(title, width, m) : [];
  const body = renderBlocks(b.children, width, env);
  if (!head.length) return body;
  if (!body.length) return head;
  return b.style === "card" || b.style === "step" ? [...head, ...body] : [...head, [], ...body];
}

function renderList(b: Extract<Block, { k: "list" }>, width: number, env: Env): Line[] {
  const { m } = env;
  const markers: Line[] = b.items.map((item, i) => {
    if (item.task !== null) return item.task ? [{ text: "[✓]", style: { fg: "success" } }] : [{ text: "[ ]", style: { fg: "muted" } }];
    if (b.ordered) return [{ text: `${b.start + i}${b.delim}`, style: { fg: "muted" } }];
    return [{ text: BULLETS[env.listDepth % BULLETS.length]!, style: { fg: "muted" } }];
  });
  // Numbers are right-aligned so the text of every numbered item starts in one column.
  let numberW = 0;
  b.items.forEach((item, i) => {
    if (b.ordered && item.task === null) numberW = Math.max(numberW, lineWidth(markers[i]!, m));
  });
  const inner: Env = { ...env, listDepth: env.listDepth + 1 };
  const out: Line[] = [];
  b.items.forEach((item, i) => {
    if (i > 0 && b.loose) out.push([]);
    let marker = markers[i]!;
    const mw = lineWidth(marker, m);
    if (b.ordered && item.task === null) marker = [{ text: " ".repeat(numberW - mw) }, ...marker];
    const markerW = lineWidth(marker, m) + 1;
    const first: Line = compact([...marker, { text: " " }]);
    const rest: Line = [{ text: " ".repeat(markerW) }];
    const lines = contained(width, markerW, (w) => renderBlocks(item.children, w, inner, !b.loose), first, rest);
    out.push(...(lines.length && item.children.length ? lines : [first]));
  });
  return out;
}

const CODE_BG: Style = { bg: "codeBg" };

/** A code block: a rectangle of `codeBg`, a top row naming the language or file, long lines wrapped with ↪. */
function renderCode(b: Extract<Block, { k: "code" }>, width: number, m: Measurer): Line[] {
  const gutter = width >= 12 ? 2 : 0;
  const right = width >= 12 ? 1 : 0;
  const inner = Math.max(1, width - gutter - right);
  const lines = highlightLines(
    b.lines.map((l) => expandTabs(l, m)),
    b.lang,
  );
  const label = [b.title, b.lang].filter(Boolean).join(" · ");
  const row = (content: Line, mark: string): Line => {
    const spans: Span[] = [];
    if (gutter) spans.push({ text: mark, style: { fg: "muted", bg: "codeBg" } });
    for (const s of content) spans.push({ text: s.text, style: mergeStyle(s.style, CODE_BG) });
    return padLine(compact(spans), width, m, CODE_BG);
  };
  const out: Line[] = [row(label ? cutLine([{ text: label, style: { fg: "muted" } }], inner, m) : [], "  ")];
  for (const line of lines) {
    const chunks = chunkLine(line, inner, m);
    chunks.forEach((c, i) => out.push(row(c, i === 0 ? "  " : "↪ ")));
  }
  out.push(row([], "  "));
  return out;
}

/** A line cut into pieces of at most `width` cells, never splitting a grapheme. */
function chunkLine(line: Line, width: number, m: Measurer): Line[] {
  if (lineWidth(line, m) <= width) return [line];
  const out: Line[] = [];
  let cur: Span[] = [];
  let w = 0;
  for (const s of line) {
    const sw = m.width(s.text);
    if (w + sw <= width) {
      cur.push(s);
      w += sw;
      continue;
    }
    let text = "";
    for (const g of m.graphemes(s.text)) {
      const gw = m.cell(g);
      if (w + gw > width) {
        if (text) cur.push({ text, style: s.style });
        text = "";
        if (cur.length) out.push(compact(cur));
        cur = [];
        w = 0;
        if (gw > width) continue;
      }
      text += g;
      w += gw;
    }
    if (text) cur.push({ text, style: s.style });
  }
  if (cur.length) out.push(compact(cur));
  return out;
}

/** Without empty lines at either end (a hard break at a paragraph's end draws nothing). */
function trimEmpty(lines: Line[]): Line[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a]!.length === 0) a++;
  while (b > a && lines[b - 1]!.length === 0) b--;
  return a === 0 && b === lines.length ? lines : lines.slice(a, b);
}
