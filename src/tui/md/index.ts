/**
 * Markdown and MDX for the full-screen interface, as pure functions from text to styled lines.
 *
 * `renderMarkdown` cleans its input with `sanitise` first, parses blocks (blocks.ts) and inlines (inlines.ts), and
 * lays them out at the width given (layout.ts); `highlightCode` and `renderDiff` are the same parts used alone.
 * Nothing here evaluates anything: MDX expressions and attributes are text. Nothing throws: if a part fails on
 * some input nobody foresaw, the text is shown cleaned and wrapped instead.
 */
import type { Line, MarkdownOptions, RenderMarkdown } from "../full/types.js";
import { sanitise } from "../sanitise.js";
import type { Ctx } from "./ast.js";
import { parseDocument, toLines } from "./blocks.js";
import { renderBlock, type Env } from "./layout.js";
import { measurer, type Measure, type Measurer } from "./measure.js";
import { clampWidth, cutLine, expandTabs, lineWidth, wrapPieces } from "./text.js";

export { highlightCode } from "./code.js";
export { renderDiff } from "./diff.js";
export type { Measure } from "./measure.js";

export interface RenderOptions extends MarkdownOptions {
  /** How text is measured; the screen's own measure when left out (tests pass a stand-in). */
  measure?: Measure;
}

/** Inputs longer than this are shown as plain wrapped text (a 10 MB answer is not something to lay out). */
export const MAX_SOURCE = 2_000_000;

function newCtx(streaming: boolean, size: number): Ctx {
  return { streaming, refs: new Map(), seq: 0, budget: { n: 64 * size + 200_000 }, jsxFailures: 0 };
}

function plainLines(text: string, width: number, m: Measurer): Line[] {
  const out: Line[] = [];
  for (const l of text.split("\n")) {
    const t = expandTabs(l, m);
    if (!t.trim()) out.push([]);
    else out.push(...wrapPieces([{ text: t }], width, m));
  }
  return out;
}

/**
 * The document as one group of lines per top-level block, each group carrying the blank line that separates it
 * from the one before. Exposed for the streaming property: every group but the last of a prefix must reappear,
 * unchanged, at the start of a longer text's groups.
 */
export function renderMarkdownGroups(source: string, options: RenderOptions): Line[][] {
  if (!(options.width >= 1)) return [];
  const width = clampWidth(options.width);
  const m = measurer(options.measure);
  const text = sanitise(typeof source === "string" ? source : String(source ?? ""));
  try {
    if (text.length > MAX_SOURCE) return [plainLines(text, width, m)];
    const ctx = newCtx(!!options.streaming, text.length);
    const blocks = parseDocument(toLines(text), ctx);
    const env: Env = { m, ctx, listDepth: 0 };
    const groups: Line[][] = [];
    let any = false;
    for (const b of blocks) {
      const lines = renderBlock(b, width, env);
      if (!lines.length) continue;
      groups.push(any ? [[], ...lines] : lines);
      any = true;
    }
    return groups;
  } catch {
    return [plainLines(text, width, m)];
  }
}

export const renderMarkdown: RenderMarkdown & ((source: string, options: RenderOptions) => Line[]) = (source, options) => {
  const m = measurer((options as RenderOptions).measure);
  const width = clampWidth(options.width);
  const lines = renderMarkdownGroups(source, options).flat();
  // Every line already fits; this only guards the promise against a mistake.
  return lines.map((l) => (lineWidth(l, m) > width ? cutLine(l, width, m) : l));
};
