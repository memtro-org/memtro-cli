import type { ColourDepth, Theme } from "../types.js";
import { invisibleAt, sgrParams, type CellStyle } from "./colour.js";
import { sameCell, sameStyle, type Cell, type CellFrame } from "./frame.js";
import { isControl } from "./width.js";

/**
 * The bytes that turn what the terminal shows into the next frame.
 *
 * Only cells that changed are written. The cursor is moved only where the next changed cell is not where the
 * last write left it, styles are set only when they change, and a link (OSC 8) is opened around a linked run and
 * closed before anything else. With synchronized output the whole update is one atomic paint; the cursor is hidden
 * while writing and put where the frame says afterwards.
 *
 * The writer is the last line of defence: whatever a cell holds, no control character leaves here as content, and
 * no position outside the frame is addressed.
 */

const ESC = "\u001b";
export const SYNC_START = `${ESC}[?2026h`;
export const SYNC_END = `${ESC}[?2026l`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
const LINK_CLOSE = `${ESC}]8;;${ESC}\\`;

/** Whether an address may be offered to the terminal as a link: http(s) or mailto, parseable, no controls, bounded. */
export function safeLink(url: string | undefined): string | null {
  if (!url || url.length > 2048) return null;
  if (/[\u0000- \u007f-\u009f]/.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "mailto:") return null;
  // OSC 8 takes the URI verbatim up to the terminator; ';' is fine, ESC and BEL are excluded above.
  return url;
}

export interface WriterState {
  /** What the terminal shows now, or null when unknown (first paint, after resize or resume). */
  shown: CellFrame | null;
  cursorVisible: boolean;
  cursorAt: { x: number; y: number } | null;
}

export function initialWriterState(): WriterState {
  return { shown: null, cursorVisible: true, cursorAt: null };
}

export interface DiffOptions {
  theme: Theme;
  depth: ColourDepth;
  /** Wrap the update in synchronized-output marks (only when the terminal said it understands them). */
  sync: boolean;
}

/** A grapheme whose width terminals do not agree on: more than one code point, or an emoji-range code point. */
function uncertain(ch: string): boolean {
  if (ch.length === 1) return false;
  const cp = ch.codePointAt(0)!;
  return ch.length > (cp > 0xffff ? 2 : 1) || cp >= 0x1f000;
}

const cup = (x: number, y: number) => `${ESC}[${y + 1};${x + 1}H`;

/**
 * The output that changes `state.shown` into `next`, and updates `state` to match. Returns "" when nothing changed.
 * A null `shown`, or one of another size, repaints every cell.
 */
export function diffFrame(next: CellFrame, state: WriterState, o: DiffOptions): string {
  const prev = state.shown && state.shown.width === next.width && state.shown.height === next.height ? state.shown : null;
  const W = next.width;
  const H = next.height;
  let body = "";
  let cx = -1; // where the terminal's cursor is, -1 unknown
  let cy = -1;
  let style: CellStyle | null = null; // current SGR, null unknown
  let link: string | null = null;

  const moveTo = (x: number, y: number) => {
    if (cx === x && cy === y) return;
    if (cy === y && cx >= 0 && x > cx) {
      const n = x - cx;
      body += n === 1 ? `${ESC}[C` : `${ESC}[${n}C`;
    } else if (cy === y && cx >= 0 && x === 0) {
      body += "\r";
    } else body += cup(x, y);
    cx = x;
    cy = y;
  };

  const setStyle = (c: Cell) => {
    if (style && sameStyle(style, c)) return;
    body += `${ESC}[0${sgrParams(c, o.theme, o.depth).map((p) => `;${p}`).join("")}m`;
    style = c;
  };

  const setLink = (url: string | null) => {
    if (url === link) return;
    if (link !== null) body += LINK_CLOSE;
    if (url !== null) body += `${ESC}]8;;${url}${ESC}\\`;
    link = url;
  };

  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      const i = y * W + x;
      const c = next.cells[i]!;
      // A wide character is written from its lead cell; its covered half is never addressed on its own.
      const lead = c.w === 0 ? null : c;
      const width = c.w === 2 && x + 1 < W ? 2 : 1;
      let changed = !prev || !sameCell(prev.cells[i]!, c);
      if (!changed && width === 2) changed = !sameCell(prev!.cells[i + 1]!, next.cells[i + 1]!);
      // A covered half that changed while its lead did not means the lead must be redrawn: handled by the lead.
      if (c.w === 0) {
        if (prev && !sameCell(prev.cells[i]!, c) && x > 0 && next.cells[i - 1]!.w !== 2) {
          // orphaned covered half (should not happen): paint a space
          moveTo(x, y);
          setLink(null);
          setStyle(c);
          body += " ";
          cx += 1;
        }
        x += 1;
        continue;
      }
      if (!changed) {
        x += width;
        continue;
      }
      moveTo(x, y);
      setLink(safeLink(lead!.link));
      setStyle(lead!);
      let ch = lead!.ch;
      if (!ch || isControl(ch) || invisibleAt(lead!, o.depth)) ch = width === 2 ? "  " : " ";
      if (c.w === 2 && width === 1) ch = " "; // a wide lead in the last column cannot be drawn
      if (width === 2 && uncertain(ch)) {
        // Paint both cells first: a terminal that draws this cluster one cell wide still shows the second cell.
        body += `  ${cup(x, y)}`;
      }
      body += ch;
      cx += width;
      // Pending wrap at the right edge, or a cluster terminals disagree about (emoji sequences, flags, presentation
      // selectors): the position is not trusted, so the next write moves explicitly and a disagreement stays in
      // its own cell instead of shifting the rest of the row.
      if (cx >= W || uncertain(ch)) cx = -1;
      x += width;
    }
  }
  setLink(null);

  const cursor = next.cursor && next.cursor.x >= 0 && next.cursor.y >= 0 && next.cursor.x < W && next.cursor.y < H ? next.cursor : null;
  const cursorMoved = cursor !== null && (!state.cursorAt || state.cursorAt.x !== cursor.x || state.cursorAt.y !== cursor.y);
  const visibilityChanged = (cursor !== null) !== state.cursorVisible;

  state.shown = next;
  if (!body && !cursorMoved && !visibilityChanged) return "";

  let out = "";
  if (state.cursorVisible && body) out += HIDE_CURSOR;
  out += body;
  if (body) out += `${ESC}[0m`;
  if (cursor) {
    out += cup(cursor.x, cursor.y);
    if (!state.cursorVisible || body) out += SHOW_CURSOR;
    state.cursorVisible = true;
    state.cursorAt = { ...cursor };
  } else {
    if (state.cursorVisible && !body) out += HIDE_CURSOR;
    state.cursorVisible = false;
    state.cursorAt = null;
  }
  return o.sync && body ? `${SYNC_START}${out}${SYNC_END}` : out;
}
