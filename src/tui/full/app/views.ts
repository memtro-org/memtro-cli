import { compactNumber } from "../../status.js";
import type { Frame, Line, Rect, Span, Theme } from "../types.js";
import { approvalGeometry, drawApproval, type ApprovalGeometry, type ApprovalState } from "./approval.js";
import { drawDialog } from "./dialog.js";
import { editorView } from "./editing.js";
import { drawMenu } from "./menu.js";
import type { AppState } from "./state.js";
import { buildLayout, spinner, topLine, windowLines, type Layout } from "./transcript.js";
import { clean, displayWidth, fg, fit, middleCut, span, tildify, truncate, wrapLine } from "./text.js";
import { wordmark, WORDMARK_HEIGHT, WORDMARK_WIDTH } from "./wordmark.js";

/**
 * State to frame. `draw` composes small view functions, each drawing one part into the frame from the state alone;
 * `geometry` says where every part goes, and is what the key handling uses too (how tall the conversation's view
 * is, where the menu sits), so the two cannot disagree.
 */

export const START_WIDTH = 76;
/** Rows of the conversation kept in view above an approval panel (the call being asked about, and what led to it). */
export const TRANSCRIPT_KEEP = 3;
export const GUTTER = 2;

export interface Geometry {
  input: Rect;
  /** Rows of text inside the input panel. */
  textRows: number;
  /** The input panel is only its status line (the approval panel is open above it and needs the rows). */
  compact: boolean;
  hintY: number;
  hint: { x: number; width: number };
  header: Rect | null;
  transcript: Rect | null;
  approval: ApprovalGeometry | null;
  /** Start screen: where the wordmark and the notices go. */
  wordmarkY: number;
  noticeY: number;
}

function inputHeight(textRows: number): number {
  // pad, text…, blank, status, bottom edge
  return textRows + 4;
}

export function geometry(state: AppState, approval: ApprovalState | null = state.overlay.kind === "approval" ? state.overlay.approval : null): Geometry {
  const W = state.width;
  const H = state.height;
  const maxRows = Math.max(1, Math.floor(H / 3));
  if (state.view === "start") {
    const width = Math.max(10, Math.min(START_WIDTH, W - 2 * GUTTER));
    const x = Math.floor((W - width) / 2);
    const textRows = Math.min(maxRows, editorRows(state, width));
    const panelH = inputHeight(textRows);
    const notices = startNoticeLines(state, width).length;
    const group = WORDMARK_HEIGHT + 1 + (notices ? notices + 1 : 1) + panelH + 1;
    const top = Math.max(0, Math.floor((H - group) / 2) - Math.floor(H / 10));
    const wordmarkY = top;
    const noticeY = top + WORDMARK_HEIGHT + 1;
    const inputY = noticeY + (notices ? notices + 1 : 1);
    const input = { x, y: Math.min(inputY, H - 1 - panelH), width, height: panelH };
    return { input, textRows, compact: false, hintY: input.y + panelH, hint: { x, width }, header: null, transcript: null, approval: null, wordmarkY, noticeY };
  }
  const width = Math.max(10, W - 2 * GUTTER);
  const x = GUTTER;
  const textRows = Math.min(maxRows, editorRows(state, width));
  // While a call is put to the person the input is disabled: it shrinks to its status line, and the rows go to
  // what is being decided.
  const compact = approval !== null;
  const panelH = compact ? 2 : inputHeight(textRows);
  const hintY = H - 1;
  const input = { x, y: Math.max(0, hintY - panelH), width, height: panelH };
  const tall = H >= 30;
  const header = { x, y: tall ? 1 : 0, width, height: tall ? 3 : 1 };
  const tTop = header.y + header.height + 1;
  let tBottom = input.y - 1; // a blank row above the input
  let ag: ApprovalGeometry | null = null;
  if (approval) {
    const room = Math.max(4, input.y - tTop - 1 - TRANSCRIPT_KEEP);
    ag = approvalGeometry(approval, x, width, input.y, room);
    tBottom = Math.max(tTop, ag.rect.y - 1);
  }
  const transcript = { x, y: tTop, width, height: Math.max(0, tBottom - tTop) };
  return { input, textRows, compact, hintY, hint: { x, width }, header, transcript, approval: ag, wordmarkY: 0, noticeY: 0 };
}

function editorRows(state: AppState, width: number): number {
  return Math.max(1, editorView(state.editor, textWidth(width)).lines.length);
}

/** Cells for text inside an input panel of `width`: the bar, two of padding each side. */
export const textWidth = (panelWidth: number): number => Math.max(1, panelWidth - 5);

/** The conversation laid out at the transcript's width. */
export function transcriptLayout(state: AppState, g: Geometry = geometry(state)): Layout {
  return buildLayout(state.items, g.transcript?.width ?? Math.max(1, state.width - 2 * GUTTER), state.verbose);
}

export function draw(state: AppState, frame: Frame, _theme?: Theme): void {
  frame.fill({ x: 0, y: 0, width: frame.width, height: frame.height }, "page");
  frame.cursor = null;
  const g = geometry(state);
  if (state.view === "start") drawStart(state, frame, g);
  else {
    drawHeader(state, frame, g);
    drawTranscript(state, frame, g);
  }
  const disabled = state.overlay.kind === "approval" || state.overlay.kind === "dialog";
  drawInput(state, frame, g, disabled);
  drawHints(state, frame, g);
  const o = state.overlay;
  if (o.kind === "menu" && !state.menuDismissed) drawMenu(o.menu, frame, g.input, { noColour: state.noColour });
  if (o.kind === "approval" && g.approval) drawApproval(o.approval, frame, g.approval);
  if (o.kind === "dialog") drawDialog(o.dialog, frame, { noColour: state.noColour });
}

export function drawStart(state: AppState, frame: Frame, g: Geometry): void {
  const mark = wordmark();
  const mx = Math.floor((state.width - WORDMARK_WIDTH) / 2);
  if (state.width >= WORDMARK_WIDTH + 2) mark.forEach((l, i) => frame.text(mx, g.wordmarkY + i, l, WORDMARK_WIDTH));
  else frame.text(Math.floor((state.width - 6) / 2), g.wordmarkY + WORDMARK_HEIGHT - 1, [span("memtro", fg("accent", { bold: true }))], 6);
  startNoticeLines(state, g.input.width).forEach((line, i) => {
    const w = Math.min(g.input.width, displayWidth(line.map((s) => s.text).join("")));
    frame.text(Math.floor((state.width - w) / 2), g.noticeY + i, line, w);
  });
  const v = `v${clean(state.version)}`;
  frame.text(state.width - displayWidth(v) - 2, state.height - 1, [span(v, fg("faint"))], displayWidth(v));
}

/** At most this many rows of start-up notices on the start screen; all of them go into the transcript too. */
export const START_NOTICE_ROWS = 4;

/** The start screen's notices, wrapped to `width`, at most START_NOTICE_ROWS rows (the last one says when more were cut). */
export function startNoticeLines(state: AppState, width: number): Line[] {
  const out: Line[] = [];
  for (const n of state.startNotices) for (const l of wrapLine(noticeLine(n), width)) out.push(l);
  if (out.length <= START_NOTICE_ROWS) return out;
  const kept = out.slice(0, START_NOTICE_ROWS);
  kept[START_NOTICE_ROWS - 1] = truncate([...kept[START_NOTICE_ROWS - 1]!, span(" …", fg("muted"))], width, true);
  return kept;
}

/** A start-up notice, with any `/command` in it in the accent colour. */
function noticeLine(text: string): Line {
  const t = clean(text);
  const out: Span[] = [];
  let last = 0;
  for (const m of t.matchAll(/(^|\s)(\/[a-z]+)/g)) {
    const at = m.index + m[1]!.length;
    if (at > last) out.push(span(t.slice(last, at), fg("muted")));
    out.push(span(m[2]!, fg("accent", { bold: true })));
    last = at + m[2]!.length;
  }
  if (last < t.length) out.push(span(t.slice(last), fg("muted")));
  return out;
}

export function drawHeader(state: AppState, frame: Frame, g: Geometry): void {
  const r = g.header;
  if (!r) return;
  frame.fill(r, "panel");
  for (let i = 0; i < r.height; i++) frame.text(r.x, r.y + i, [span("┃", fg("rule", { bg: "panel" }))], 1);
  const y = r.y + Math.floor(r.height / 2);
  const s = state.status;
  const right: string[] = [];
  if (s.tokens !== null) right.push(`${compactNumber(s.tokens)} tokens`);
  const pct = contextPct(state);
  if (pct !== null) right.push(`${pct}% context`);
  const rt = right.join("  ");
  const rw = displayWidth(rt);
  const tw = Math.max(1, r.width - 4 - (rw ? rw + 2 : 0));
  frame.text(r.x + 3, y, truncate([span(state.title || "New session", fg("text", { bold: true, bg: "panel" }))], tw, true), tw);
  if (rw) frame.text(r.x + r.width - 2 - rw, y, [span(rt, fg("muted", { bg: "panel" }))], rw);
}

export function contextPct(state: AppState): number | null {
  const s = state.status;
  if (s.contextUsed === null || !s.contextLimit) return null;
  return Math.min(100, Math.round((s.contextUsed / s.contextLimit) * 100));
}

export function drawTranscript(state: AppState, frame: Frame, g: Geometry): void {
  const r = g.transcript;
  if (!r || r.height <= 0) return;
  const layout = transcriptLayout(state, g);
  const top = topLine(layout, state.scroll, r.height);
  const lines = windowLines(layout, top, r.height);
  lines.forEach((l, i) => frame.text(r.x, r.y + i, l, r.width));
  const below = layout.total - (top + r.height);
  if (!state.scroll.pinned && below > 0) {
    const t = " ↓ newer · end ";
    const w = displayWidth(t);
    frame.text(r.x + r.width - w, r.y + r.height - 1, [span(t, fg("onAccent", { bg: "accent", bold: true }))], w);
  }
}

export function drawInput(state: AppState, frame: Frame, g: Geometry, disabled: boolean): void {
  const r = g.input;
  frame.fill({ x: r.x, y: r.y, width: r.width, height: r.height - 1 }, "panel");
  const barRole = disabled ? "faint" : "accent";
  if (g.compact) {
    frame.text(r.x, r.y, [span("┃", fg(barRole, { bg: "panel" }))], 1);
    frame.text(r.x + 3, r.y, statusLine(state, textWidth(r.width)), textWidth(r.width));
    frame.text(r.x, r.y + 1, [span("╹", fg(barRole)), span("▀".repeat(Math.max(0, r.width - 1)), fg("panel"))], r.width);
    return;
  }
  for (let i = 0; i < r.height - 1; i++) frame.text(r.x, r.y + i, [span("┃", fg(barRole, { bg: "panel" }))], 1);
  frame.text(r.x, r.y + r.height - 1, [span("╹", fg(barRole)), span("▀".repeat(Math.max(0, r.width - 1)), fg("panel"))], r.width);
  const tx = r.x + 3;
  const tw = textWidth(r.width);
  const view = editorView(state.editor, tw);
  const empty = !state.editor.text;
  if (empty) {
    frame.text(tx, r.y + 1, [span(disabled ? "" : state.placeholder, fg("faint", { bg: "panel" }))], tw);
  } else {
    // Keep the cursor's row in view when the text is taller than the panel.
    const first = Math.max(0, Math.min(view.cursor.y - g.textRows + 1, view.lines.length - g.textRows));
    for (let i = 0; i < g.textRows; i++) {
      const l = view.lines[first + i];
      if (l) frame.text(tx, r.y + 1 + i, disabled ? l.map((s) => ({ ...s, style: { ...s.style, fg: "muted" as const } })) : l, tw);
    }
    if (!disabled) frame.cursor = { x: tx + Math.min(tw - 1, view.cursor.x), y: r.y + 1 + (view.cursor.y - first) };
  }
  if (empty && !disabled) frame.cursor = { x: tx, y: r.y + 1 };
  frame.text(tx, r.y + 1 + g.textRows + 1, statusLine(state, tw), tw);
}

/** Mode, the model in use, the organisation, the context in use. */
export function statusLine(state: AppState, width: number): Line {
  const s = state.status;
  const mode = s.mode;
  const modeRole = mode === "unchecked" ? "danger" : mode === "ask" ? "user" : "accent";
  const parts: Span[] = [span(mode, fg(modeRole, { bold: true, bg: "panel" })), span(" · ", fg("faint", { bg: "panel" })), span(clean(s.model), fg("text", { bg: "panel" }))];
  if (s.organisation) parts.push(span(` ${clean(s.organisation)}`, fg("muted", { bg: "panel" })));
  const pct = contextPct(state);
  if (pct !== null) parts.push(span(" · ", fg("faint", { bg: "panel" })), span(`${pct}% context`, fg(pct >= 80 ? "warning" : "muted", { bg: "panel" })));
  return truncate(parts, width, true);
}

type Pair = [string, string];

export function hintPairs(state: AppState): Pair[] {
  const o = state.overlay;
  if (o.kind === "approval") return o.approval.note !== null ? [["enter", "send"], ["esc", "back"]] : [["↑↓", "scroll"], ["y/a/n/e", "answer"]];
  if (o.kind === "dialog") return o.dialog.readOnly ? [["↑↓", "scroll"], ["esc", "close"]] : [["↑↓", "move"], ["enter", "choose"], ["esc", "close"]];
  if (o.kind === "menu" && !state.menuDismissed) return [["tab", "complete"], ["enter", "run"], ["esc", "hide"]];
  return [["ctrl+p", "commands"], ["/", "menu"]];
}

export function drawHints(state: AppState, frame: Frame, g: Geometry): void {
  const y = g.hintY;
  if (y < 0 || y >= frame.height) return;
  const pairs = hintPairs(state);
  const right: Span[] = [];
  pairs.forEach(([k, l], i) => {
    if (i) right.push(span("  "));
    right.push(span(k, fg("text", { bold: true })), span(` ${l}`, fg("muted")));
  });
  const rw = right.reduce((n, s) => n + displayWidth(s.text), 0);
  const roomLeft = Math.max(0, g.hint.width - rw - 2);
  let left: Span[];
  const notice = state.notice ? [span(clean(state.notice.text), fg(state.notice.tone === "warning" ? "warning" : state.notice.tone === "info" ? "info" : "muted"))] : null;
  if (state.running) {
    left = [span(spinner(state.tick), fg("accent")), span(" "), ...(notice ?? [span(state.stopping ? "stopping" : "working", fg("muted"))])];
    if (!state.stopping) left.push(span("  esc", fg("text", { bold: true })), span(" interrupt", fg("muted")));
    else if (state.queued !== null) left.push(span("  esc", fg("text", { bold: true })), span(" take back the queued message", fg("muted")));
  } else left = notice ?? [span(middleCut(tildify(clean(state.cwd), state.home), Math.max(1, roomLeft)), fg("muted"))];
  if (state.queued !== null) left.push(span("  queued", fg("warning", { bold: true })));
  if (rw + 2 <= g.hint.width) frame.text(g.hint.x + g.hint.width - rw, y, right, rw);
  frame.text(g.hint.x, y, fit(truncate(left, roomLeft, true), roomLeft), roomLeft);
}
