import type { AgentEvent, Answer, Decision, ToolResult } from "../../../agent/types.js";
import { reasonText, sourceWords } from "../../render.js";
import { terminalText } from "../../sanitise.js";
import { compactNumber } from "../../status.js";
import { renderDiff, renderMarkdown } from "../../md/index.js";
import type { Line, Role, Span } from "../types.js";
import type { AppState, Item, Scroll, ToolItem } from "./state.js";
import { clean, cleanLines, commandLines, fg, fit, plural, span, truncate, wrapLine, wrapText } from "./text.js";

/**
 * The conversation: agent events folded into items (`applyEvent`, pure), each item laid out to lines at a width
 * (`layoutItem`, cached per item object and width, so a streaming answer re-renders only itself), and the view as a
 * window over all of them (`buildLayout`, `topLine`, `scrollBy`).
 */

export const DIFF_LINES = 40;
export const OUTPUT_LINES = 8;
/** A message the person sent is shown up to this many lines; the rest is counted. */
export const USER_LINES = 40;
const PROGRESS_KEEP = 64 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Events → items
// ---------------------------------------------------------------------------------------------------------------

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function push(state: AppState, item: DistOmit<Item, "key">): AppState {
  const it = { ...item, key: state.nextKey } as Item;
  return { ...state, items: [...state.items, it], nextKey: state.nextKey + 1, view: "conversation" };
}

function replaceAt(state: AppState, i: number, item: Item): AppState {
  const items = state.items.slice();
  items[i] = item;
  return { ...state, items };
}

/** Streaming text and thinking are finished: their last render is final. */
function closeStreams(state: AppState): AppState {
  let s = state;
  for (let i = s.items.length - 1; i >= 0 && i >= s.items.length - 3; i--) {
    const it = s.items[i]!;
    if ((it.kind === "assistant" || it.kind === "thinking") && !it.done) s = replaceAt(s, i, { ...it, done: true });
  }
  return s;
}

function toolIndex(state: AppState, id: string): number {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i]!;
    if (it.kind === "tool" && it.id === id) return i;
  }
  return -1;
}

export function addUser(state: AppState, text: string): AppState {
  const s = push(closeStreams(state), { kind: "user", text });
  const first = clean(text.trim().split("\n")[0] ?? "");
  return s.title ? s : { ...s, title: first.length > 80 ? `${first.slice(0, 79)}…` : first };
}

export function addNotice(state: AppState, text: string, tone: "warning" | "info" | "plain" = "plain"): AppState {
  if (!text) return state;
  return push(closeStreams(state), { kind: "notice", text, tone });
}

/** A turn begins: its counters start again. */
export function beginTurn(state: AppState, model: string): AppState {
  return { ...state, running: true, stopping: false, turnModel: model, turnTokens: null, status: { ...state.status, model } };
}

export function applyEvent(state: AppState, e: AgentEvent): AppState {
  switch (e.type) {
    case "turn-start":
      return { ...state, turnModel: e.model, status: { ...state.status, model: e.model } };
    case "routing":
      return e.model ? { ...state, turnModel: e.model, status: { ...state.status, model: e.model } } : state;
    case "text":
    case "thinking": {
      const kind = e.type === "text" ? "assistant" : "thinking";
      const last = state.items.at(-1);
      if (last && last.kind === kind && !last.done) return replaceAt(state, state.items.length - 1, { ...last, text: last.text + e.delta });
      if (!e.delta) return state;
      return push(closeStreams(state), { kind, text: e.delta, done: false });
    }
    case "tool-call": {
      const c = e.call;
      return push(closeStreams(state), {
        kind: "tool",
        id: c.id,
        tool: c.tool,
        risk: c.risk,
        title: c.summary.title,
        ...(c.summary.command !== undefined ? { command: c.summary.command } : {}),
        asking: false,
        progress: "",
      });
    }
    case "tool-decision": {
      const i = toolIndex(state, e.id);
      if (i < 0) return state;
      const it = state.items[i] as Item & ToolItem;
      return replaceAt(state, i, { ...it, decision: e.decision, ...(e.answer ? { answer: e.answer } : {}), asking: false });
    }
    case "tool-progress": {
      const i = toolIndex(state, e.id);
      if (i < 0) return state;
      const it = state.items[i] as Item & ToolItem;
      const progress = (it.progress + e.text).slice(-PROGRESS_KEEP);
      return replaceAt(state, i, { ...it, progress });
    }
    case "tool-result": {
      const i = toolIndex(state, e.id);
      if (i < 0) return push(closeStreams(state), { kind: "tool", id: e.id, tool: e.tool, risk: null, title: e.tool, asking: false, progress: "", result: e.result });
      const it = state.items[i] as Item & ToolItem;
      return replaceAt(state, i, { ...it, result: e.result, asking: false });
    }
    case "usage": {
      const step = e.step.input + e.step.output;
      const session = e.session.input + e.session.output;
      return {
        ...state,
        turnTokens: step ? (state.turnTokens ?? 0) + step : state.turnTokens,
        status: { ...state.status, tokens: session ? session : state.status.tokens, contextUsed: e.contextUsed, contextLimit: e.contextLimit },
      };
    }
    case "compacted":
      return push(closeStreams(state), { kind: "compaction", before: e.before, after: e.after });
    case "notice":
      return addNotice(state, e.text, "warning");
    case "error":
      return push(closeStreams(state), { kind: "error", text: e.message, retryable: e.retryable });
    case "turn-end": {
      const s = closeStreams(state);
      return push(s, { kind: "footer", model: s.turnModel, tokens: s.turnTokens, interrupted: e.reason === "interrupted" });
    }
  }
}

/** Marks the call whose approval panel is open, or none. */
export function markAsking(state: AppState, id: string | null): AppState {
  let s = state;
  for (let i = s.items.length - 1; i >= 0 && i >= s.items.length - 50; i--) {
    const it = s.items[i]!;
    if (it.kind !== "tool") continue;
    const asking = it.id === id;
    if (it.asking !== asking) s = replaceAt(s, i, { ...it, asking });
  }
  return s;
}

/** The text of the most recent answer, as the model wrote it (Markdown source), or null. */
export function lastAnswer(state: AppState): string | null {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i]!;
    if (it.kind === "assistant" && it.text.trim()) return it.text;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Items → lines
// ---------------------------------------------------------------------------------------------------------------

type Group = "user" | "text" | "tools" | "note" | "footer";

function group(it: Item): Group {
  switch (it.kind) {
    case "user":
      return "user";
    case "assistant":
      return "text";
    case "tool":
    case "thinking":
      return "tools";
    case "footer":
      return "footer";
    default:
      return "note";
  }
}

/** A blank line separates items unless both are in a run of tool lines or notes. */
function gapBefore(prev: Item | undefined, it: Item): boolean {
  if (!prev) return false;
  const a = group(prev);
  const b = group(it);
  return a !== b || a === "user" || a === "text";
}

const TOOL_GLYPH: Record<string, string> = { read: "→", list: "✱", glob: "✱", grep: "✱", bash: "$", edit: "←", write: "←" };

export function toolGlyph(it: ToolItem): string {
  if (TOOL_GLYPH[it.tool]) return TOOL_GLYPH[it.tool]!;
  if (it.risk === "remote-act") return "◆";
  if (it.risk === "remote-read") return "◇";
  if (it.risk === "execute") return "$";
  if (it.risk === "write") return "←";
  return "•";
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (tick: number): string => SPIN[tick % SPIN.length]!;

/** The call's one line: glyph, what it is, and how it went. */
export function toolHeadline(it: ToolItem, width: number): Line {
  const failed = toolFailed(it);
  const glyph: Span = span(toolGlyph(it), fg(failed ? "danger" : it.asking ? "warning" : "muted"));
  const what = it.command !== undefined && it.tool === "bash" ? commandHeadline(it.command) : clean(it.title);
  const tail = toolOutcome(it);
  const tailW = tail.reduce((n, s) => n + s.text.length, 0);
  const room = Math.max(8, width - 2 - Math.min(tailW, Math.floor(width / 2)));
  const body = truncate([span(what, fg("muted"))], room, true);
  return truncate([glyph, span(" "), ...body, ...tail], width, true);
}

function commandHeadline(command: string): string {
  const lines = commandLines(command);
  return clean(lines[0] ?? "") + (lines.length > 1 ? ` … (+${plural(lines.length - 1, "line")})` : "");
}

function toolFailed(it: ToolItem): boolean {
  if (it.answer?.kind === "deny" || it.decision?.verdict === "deny") return true;
  const r = it.result;
  if (!r) return false;
  if (r.display?.kind === "command") return r.display.exitCode !== 0;
  return Boolean(r.isError);
}

function toolOutcome(it: ToolItem): Span[] {
  if (it.asking) return [span("  waiting for you", fg("warning"))];
  const a: Answer | undefined = it.answer;
  const d: Decision | undefined = it.decision;
  if (a?.kind === "deny") return [span(`  ✗ not run${a.note ? `: ${clean(a.note)}` : " (you said no)"}`, fg("danger"))];
  if (!a && d?.verdict === "deny") return [span(`  ✗ refused (${sourceWords(d)}): ${reasonText(d)}`, fg("danger"))];
  const r = it.result;
  const session = a?.kind === "session" ? [span("  allowed for this session", fg("muted"))] : [];
  if (!r) return session;
  return [...resultOutcome(r), ...session];
}

function resultOutcome(r: ToolResult): Span[] {
  const d = r.display;
  if (d?.kind === "command") {
    if (d.exitCode === null) return [span("  ✗ stopped before it exited", fg("danger"))];
    return d.exitCode === 0 ? [span("  ✓", fg("success"))] : [span(`  ✗ exit ${d.exitCode}`, fg("danger"))];
  }
  if (d?.kind === "diff") return d.diff.trim() ? [span("  ✓", fg("success"))] : [span("  ✓ no change", fg("muted"))];
  if (r.isError) {
    const first = clean((d?.kind === "text" ? d.text : r.content).trim().split("\n")[0] ?? "");
    return [span(`  ✗ ${first || "failed"}`, fg("danger"))];
  }
  if (d?.kind === "text") return [span("  ✓", fg("success"))];
  const text = r.content.trim();
  const n = text ? text.split("\n").length : 0;
  return [span("  ✓", fg("success")), span(n ? ` ${plural(n, "line")}` : " nothing", fg("faint"))];
}

/** The last `n` lines of output, with a count of what came before, each line cut to the width. */
function outputTail(text: string, n: number, width: number, role: Role): Line[] {
  const lines = terminalText(text).replace(/\n+$/, "").split("\n").map((l) => clean(l));
  if (lines.length === 1 && !lines[0]) return [];
  const kept = lines.slice(-n);
  const out: Line[] = [];
  if (lines.length > n) out.push([span(`    … ${plural(lines.length - n, "earlier line")}`, fg("faint"))]);
  for (const l of kept) out.push(truncate([span("    │ ", fg("faint")), span(l, fg(role))], width, true));
  return out;
}

function toolLines(it: ToolItem, width: number): Line[] {
  const out: Line[] = [toolHeadline(it, width)];
  const r = it.result;
  const d = r?.display;
  if (!r && it.progress && !it.asking) out.push(...outputTail(it.progress, OUTPUT_LINES, width, "muted"));
  if (d?.kind === "diff" && d.diff.trim()) {
    const lines = renderDiff(d.diff, { width: Math.max(10, width - 4) });
    for (const l of lines.slice(0, DIFF_LINES)) out.push([span("    "), ...l]);
    if (lines.length > DIFF_LINES) out.push([span(`    … ${plural(lines.length - DIFF_LINES, "more line")}`, fg("faint"))]);
  }
  if (d?.kind === "command" && d.exitCode !== 0) out.push(...outputTail(d.output, OUTPUT_LINES, width, "muted"));
  if (d?.kind === "text" && r?.isError) out.push(...outputTail(d.text, OUTPUT_LINES, width, "danger"));
  return out;
}

function userLines(text: string, width: number): Line[] {
  const inner = Math.max(1, width - 5);
  const bar: Span = span("┃", { fg: "user", bg: "panel" });
  const row = (line: Line): Line => [bar, span("  ", { bg: "panel" }), ...fit(line, width - 3, "panel")];
  const src = cleanLines(text.replace(/^\n+/, ""));
  const wrapped: Line[] = [];
  for (const l of src) {
    for (const w of wrapText(l, inner, fg("text"))) wrapped.push(w);
    if (wrapped.length > USER_LINES) break;
  }
  const out: Line[] = [row([])];
  for (const l of wrapped.slice(0, USER_LINES)) out.push(row(l));
  const hidden = src.length > USER_LINES || wrapped.length > USER_LINES;
  if (hidden) out.push(row([span(`… ${plural(Math.max(1, src.length - USER_LINES), "more line")}`, fg("muted"))]));
  out.push(row([]));
  return out;
}

function prose(text: string, width: number, role: Role, prefix = ""): Line[] {
  const out: Line[] = [];
  for (const l of cleanLines(text)) {
    for (const w of wrapText(prefix + l, width, fg(role))) out.push(w);
  }
  return out;
}

/** One item as lines, `width` cells wide at most. Pure; `layoutItem` caches it. */
export function renderItem(it: Item, width: number, o: { verbose: boolean }): Line[] {
  const w = Math.max(1, width);
  switch (it.kind) {
    case "user":
      return userLines(it.text, w);
    case "assistant": {
      const md: Line[] = renderMarkdown(it.text, { width: Math.max(1, w - 2), streaming: !it.done });
      return md.map((l) => [span("  "), ...l]);
    }
    case "thinking": {
      if (o.verbose) return prose(it.text, w - 2, "faint").map((l) => [span("  "), ...l.map((s) => ({ ...s, style: { ...s.style, italic: true } }))]);
      const n = it.text.trim() ? it.text.trim().split("\n").length : 0;
      if (!it.done) return [[span("· thinking…", fg("faint"))]];
      return n ? [[span(`· thought for ${plural(n, "line")}`, fg("faint"))]] : [];
    }
    case "tool":
      return toolLines(it, w);
    case "notice":
      return it.tone === "plain" ? prose(it.text, w, "text") : prose(it.text, w, it.tone === "warning" ? "warning" : "info", "· ");
    case "error":
      return prose(`✗ ${it.text}${it.retryable ? " (worth trying again)" : ""}`, w, "danger");
    case "compaction":
      return [[span(`· Compacted the conversation: about ${compactNumber(it.before)} → ${compactNumber(it.after)} tokens.`, fg("muted"))]];
    case "footer": {
      const parts: Span[] = [span("▣ ", fg("accent")), span(clean(it.model), fg("muted"))];
      parts.push(span(` · ${it.tokens === null ? "tokens not reported" : `${compactNumber(it.tokens)} tokens`}`, fg("faint")));
      if (it.interrupted) parts.push(span(" · interrupted", fg("warning")));
      return [truncate(parts, w, true)];
    }
  }
}

interface Cached {
  width: number;
  gap: boolean;
  verbose: boolean;
  lines: Line[];
}

const cache = new WeakMap<Item, Cached>();

/** The item's lines, with the blank line before it when there is one. Re-rendered only when the item, its width or its neighbour's kind changed. */
export function layoutItem(it: Item, prev: Item | undefined, width: number, verbose: boolean): Line[] {
  const gap = gapBefore(prev, it);
  const hit = cache.get(it);
  if (hit && hit.width === width && hit.gap === gap && hit.verbose === verbose) return hit.lines;
  const body = renderItem(it, width, { verbose });
  const lines = gap && body.length ? [[], ...body] : body;
  cache.set(it, { width, gap, verbose, lines });
  return lines;
}

export interface Layout {
  width: number;
  items: Item[];
  starts: number[];
  total: number;
  index: Map<number, number>;
  lines(i: number): Line[];
}

/** Every item laid out at `width`, with where each starts. Linear in the number of items; cached items cost a lookup. */
export function buildLayout(items: Item[], width: number, verbose: boolean): Layout {
  const starts = new Array<number>(items.length);
  const index = new Map<number, number>();
  const all: Line[][] = new Array(items.length);
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const lines = layoutItem(items[i]!, items[i - 1], width, verbose);
    all[i] = lines;
    starts[i] = total;
    index.set(items[i]!.key, i);
    total += lines.length;
  }
  return { width, items, starts, total, index, lines: (i) => all[i] ?? [] };
}

/** The first line shown, given the scroll and the view's height. */
export function topLine(layout: Layout, scroll: Scroll, viewHeight: number): number {
  const max = Math.max(0, layout.total - viewHeight);
  if (scroll.pinned) return max;
  const i = layout.index.get(scroll.anchor.key);
  if (i === undefined) return Math.min(max, 0);
  const h = layout.lines(i).length;
  return Math.max(0, Math.min(max, layout.starts[i]! + Math.min(scroll.anchor.offset, Math.max(0, h - 1))));
}

/** The scroll that puts `line` at the top; at or past the bottom it pins. */
export function scrollTo(layout: Layout, line: number, viewHeight: number): Scroll {
  const max = Math.max(0, layout.total - viewHeight);
  if (line >= max || layout.items.length === 0) return { pinned: true, anchor: { key: 0, offset: 0 } };
  const top = Math.max(0, line);
  // The last item starting at or before `top`.
  let lo = 0;
  let hi = layout.items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.starts[mid]! <= top) lo = mid;
    else hi = mid - 1;
  }
  return { pinned: false, anchor: { key: layout.items[lo]!.key, offset: top - layout.starts[lo]! } };
}

export function scrollBy(layout: Layout, scroll: Scroll, delta: number, viewHeight: number): Scroll {
  return scrollTo(layout, topLine(layout, scroll, viewHeight) + delta, viewHeight);
}

/** The lines in view, from `top`, at most `height` of them. */
export function windowLines(layout: Layout, top: number, height: number): Line[] {
  const out: Line[] = [];
  if (!layout.items.length || height <= 0) return out;
  let lo = 0;
  let hi = layout.items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.starts[mid]! <= top) lo = mid;
    else hi = mid - 1;
  }
  for (let i = lo; i < layout.items.length && out.length < height; i++) {
    const lines = layout.lines(i);
    const from = i === lo ? top - layout.starts[i]! : 0;
    for (let j = Math.max(0, from); j < lines.length && out.length < height; j++) out.push(lines[j]!);
  }
  return out;
}
