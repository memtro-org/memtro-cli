import { oneLine, sanitise, visible } from "../../sanitise.js";
import { displayWidth, lineWidth, truncate, wrapLine } from "../screen/width.js";
import type { Line, Role, Span, Style } from "../types.js";

/**
 * Small helpers for building lines. Everything that came from outside goes through `clean` or `cleanLines` (which
 * use the existing `sanitise`) before it becomes a span: a span's text holds no control character, no newline and
 * no tab.
 */

/** One line of outside text, safe for a span: controls made visible, newlines and tabs turned into spaces. */
export function clean(text: string): string {
  return oneLine(text);
}

/** Outside text kept as its lines: each sanitised, tabs expanded to the next multiple of four. */
export function cleanLines(text: string): string[] {
  return sanitise(text.replace(/\r\n/g, "\n"))
    .replace(/\n+$/, "")
    .split("\n")
    .map(expandTabs);
}

/** A command as it would run, every control and invisible character shown (`visible`), as lines. */
export function commandLines(command: string): string[] {
  return visible(command).split("\n");
}

function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) {
    if (ch === "\t") out += " ".repeat(4 - (out.length % 4));
    else out += ch;
  }
  return out;
}

export const span = (text: string, style?: Style): Span => (style ? { text, style } : { text });

export const fg = (role: Role, extra: Omit<Style, "fg"> = {}): Style => ({ fg: role, ...extra });

export { displayWidth, lineWidth, truncate, wrapLine };

/** The line cut to `width`, then padded with spaces in `bg` (when given) to exactly `width` cells. */
export function fit(line: Line, width: number, bg?: Role): Line {
  if (width <= 0) return [];
  const w = lineWidth(line);
  const cut = w > width ? truncate(line, width, true) : line;
  const rest = width - lineWidth(cut);
  const out = bg ? cut.map((s) => ({ text: s.text, style: { ...s.style, bg: s.style?.bg ?? bg } })) : [...cut];
  if (rest > 0) out.push({ text: " ".repeat(rest), ...(bg ? { style: { bg } } : {}) });
  return out;
}

/** Every span given a background, unless it has one already. */
export function onBg(line: Line, bg: Role): Line {
  return line.map((s) => ({ text: s.text, style: { ...s.style, bg: s.style?.bg ?? bg } }));
}

/** Wraps plain (already clean) text to lines of `width` cells, all in one style. Empty text is one empty line. */
export function wrapText(text: string, width: number, style?: Style): Line[] {
  if (width <= 0) return [];
  if (!text) return [[]];
  return wrapLine([span(text, style)], width);
}

/** `/a/very/long/path/here` shortened in the middle to fit `width`: `/a/very/…/here`. */
export function middleCut(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? "…" : "";
  const chars = Array.from(text);
  let left = Math.ceil((width - 1) / 2);
  let right = width - 1 - left;
  // Characters may be wide; trim until it fits.
  for (;;) {
    const s = `${chars.slice(0, left).join("")}…${right > 0 ? chars.slice(-right).join("") : ""}`;
    if (displayWidth(s) <= width || (left === 0 && right === 0)) return s;
    if (left >= right && left > 0) left--;
    else right--;
  }
}

/** A home directory shown as `~`. */
export function tildify(path: string, home: string | undefined): string {
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
