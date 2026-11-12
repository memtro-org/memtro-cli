import { findSlash, SLASH_COMMANDS, type ChoiceHost, type SlashCommandInfo } from "../../slash.js";
import type { Frame, Line, Rect, Span } from "../types.js";
import { rank } from "./match.js";
import { clean, fg, fit, span, truncate } from "./text.js";

/**
 * The menu over the input: slash commands as the first character is `/`, an argument's choices once a command's
 * name and a space are typed, and workspace files after an `@`. Built from the editor's text every time it changes
 * (`menuFor`), moved by keys (`moveMenu`), drawn above the input panel (`drawMenu`).
 */

export const MENU_ROWS = 10;
/** Files offered after `@`, at most, before filtering. */
export const FILES_CONSIDERED = 20_000;

export interface MenuItem {
  /** Left column: `/model`, `ask`, `src/x.ts`. */
  label: string;
  /** After the label, muted: an argument hint. */
  hint?: string;
  /** Right of the label column, muted. */
  detail?: string;
  /** Positions of the label's matched characters. */
  positions?: number[];
  current?: boolean;
  command?: SlashCommandInfo;
  /** For a choice: its value; for a file: its path. */
  value?: string;
}

export interface MenuState {
  kind: "slash" | "choice" | "file";
  query: string;
  items: MenuItem[];
  selected: number;
  top: number;
  /** For `choice`: the command whose argument this is. */
  command?: string;
  /** For `file`: the list is still being read. */
  loading?: boolean;
}

export interface MenuContext {
  host: ChoiceHost;
  /** Workspace files, or null while they are being listed. */
  files: string[] | null;
}

const ARG = /^\/([a-z]+) ([^\n]*)$/;
const NAME = /^\/([^\s]*)$/;
const AT = /(^|\s)@([^\s@]*)$/;

/** Which menu the text calls for, filtered and with the first row selected, or null. */
export function menuFor(text: string, ctx: MenuContext): MenuState | null {
  const name = NAME.exec(text);
  if (name) return slashMenu(name[1]!);
  const arg = ARG.exec(text);
  if (arg) {
    const cmd = findSlash(arg[1]!);
    if (!cmd?.choices) return null;
    const choices = cmd.choices(ctx.host);
    if (!choices.length) return null;
    const ranked = rank(choices, arg[2]!, (c) => c.value, (c) => c.detail ?? "");
    return {
      kind: "choice",
      command: cmd.name,
      query: arg[2]!,
      items: ranked.length
        ? ranked.map((r) => ({ label: r.item.value, positions: r.positions, value: r.item.value, ...(r.item.detail ? { detail: r.item.detail } : {}), ...(r.item.current ? { current: true } : {}) }))
        : [{ label: "No matching choices" }],
      selected: 0,
      top: 0,
    };
  }
  if (text.startsWith("/")) return null;
  const at = AT.exec(text);
  if (at) {
    const q = at[2]!;
    if (ctx.files === null) return { kind: "file", query: q, items: [{ label: "Listing files…" }], selected: 0, top: 0, loading: true };
    const files = ctx.files.slice(0, FILES_CONSIDERED);
    const ranked = q ? rank(files, q, (f) => f).slice(0, 200) : files.slice(0, 200).map((f) => ({ item: f, positions: [] as number[] }));
    return {
      kind: "file",
      query: q,
      items: ranked.length ? ranked.map((r) => ({ label: clean(r.item), value: r.item, positions: r.positions })) : [{ label: "No matching files" }],
      selected: 0,
      top: 0,
    };
  }
  return null;
}

function slashMenu(query: string): MenuState {
  const ranked = rank(SLASH_COMMANDS, query, (c) => c.name, (c) => c.summary, { sortEmpty: true });
  return {
    kind: "slash",
    query,
    items: ranked.length
      ? ranked.map((r) => ({ label: `/${r.item.name}`, ...(r.item.hint ? { hint: r.item.hint } : {}), detail: r.item.summary, command: r.item, positions: r.positions.map((p) => p + 1) }))
      : [{ label: "No matching commands" }],
    selected: 0,
    top: 0,
  };
}

/** A real row (not "No matching …" or "Listing files…"). */
export const selectable = (m: MenuState): boolean => Boolean(m.items[m.selected]?.command || m.items[m.selected]?.value !== undefined);

/** Up or down one row, wrapping; the window scrolls one row at a time to keep the selection in view. */
export function moveMenu(m: MenuState, delta: number): MenuState {
  const n = m.items.length;
  if (!n) return m;
  const selected = (((m.selected + delta) % n) + n) % n;
  return { ...m, selected, top: keepInView(m.top, selected, Math.min(MENU_ROWS, n)) };
}

function keepInView(top: number, selected: number, rows: number): number {
  if (selected < top) return selected;
  if (selected >= top + rows) return selected - rows + 1;
  return top;
}

export type MenuAction =
  /** Replace the editor's text and keep editing. */
  | { kind: "complete"; text: string }
  /** Run this slash command line. */
  | { kind: "run"; line: string }
  | { kind: "none" };

/** Tab: put the selection into the text. Never runs anything. */
export function tabAction(m: MenuState, text: string): MenuAction {
  const it = m.items[m.selected];
  if (!it) return { kind: "none" };
  if (m.kind === "slash" && it.command) return { kind: "complete", text: `/${it.command.name}${it.command.hint ? " " : ""}` };
  if (m.kind === "choice" && it.value !== undefined) return { kind: "complete", text: `/${m.command} ${it.value}` };
  if (m.kind === "file" && it.value !== undefined) return { kind: "complete", text: replaceAt(text, it.value) };
  return { kind: "none" };
}

/**
 * Enter. On a command: run it when the typed name is exactly a command, or a prefix of the selected one that no
 * other command shares; otherwise a command that takes an argument, or that acts, is completed first, and any other
 * runs. On a choice: run the command with it. On a file: insert it.
 */
export function enterAction(m: MenuState, text: string): MenuAction {
  const it = m.items[m.selected];
  if (!it) return { kind: "none" };
  if (m.kind === "slash" && it.command) {
    const typed = m.query;
    const exact = SLASH_COMMANDS.some((c) => c.name === typed);
    if (exact) return { kind: "run", line: `/${typed}` };
    const prefixOf = SLASH_COMMANDS.filter((c) => typed && c.name.startsWith(typed));
    if (prefixOf.length === 1 && prefixOf[0] === it.command) return { kind: "run", line: `/${it.command.name}` };
    if (it.command.hint) return { kind: "complete", text: `/${it.command.name} ` };
    // A command that acts runs only from its own name: one matched on its description ("/rev" finding /logout's
    // "Revoke…"), or a prefix it shares ("/lo"), is completed, and a second Enter runs it.
    if (it.command.acts) return { kind: "complete", text: `/${it.command.name}` };
    return { kind: "run", line: `/${it.command.name}` };
  }
  if (m.kind === "choice" && it.value !== undefined) return { kind: "run", line: `/${m.command} ${it.value}` };
  if (m.kind === "file" && it.value !== undefined) return { kind: "complete", text: replaceAt(text, it.value) };
  return { kind: "none" };
}

/** The `@query` at the end of the text replaced by the path and a space. A path with a space is quoted. */
function replaceAt(text: string, path: string): string {
  const m = /(^|\s)@([^\s@]*)$/.exec(text);
  const ref = /\s/.test(path) ? `"${path}"` : path;
  if (!m) return `${text}${ref} `;
  return `${text.slice(0, m.index + m[1]!.length)}${ref} `;
}

/** The menu over `anchor` (the input panel's rect): same left edge and width, its bottom row just above. */
export function menuRect(m: MenuState, anchor: Rect): Rect {
  const rows = Math.min(MENU_ROWS, m.items.length, Math.max(1, anchor.y));
  return { x: anchor.x, y: anchor.y - rows, width: anchor.width, height: rows };
}

export function drawMenu(m: MenuState, frame: Frame, anchor: Rect, o: { noColour: boolean }): void {
  const r = menuRect(m, anchor);
  if (r.height <= 0 || r.width < 8) return;
  frame.fill(r, "panel");
  const inner = r.width - 4;
  // The no-colour marker ("> ") comes before the label, so the column makes room for it.
  const marker = o.noColour ? 2 : 0;
  const labelCol = Math.min(Math.floor(inner / 2), Math.max(...m.items.map((it) => it.label.length + (it.hint ? it.hint.length + 1 : 0))) + 2 + marker);
  const scroll = m.items.length > r.height;
  for (let row = 0; row < r.height; row++) {
    const i = m.top + row;
    const it = m.items[i];
    if (!it) break;
    const selected = i === m.selected && (it.command !== undefined || it.value !== undefined);
    const line = menuRow(it, labelCol, inner, selected, o.noColour);
    if (selected && !o.noColour) frame.fill({ x: r.x + 1, y: r.y + row, width: r.width - 2, height: 1 }, "accent");
    frame.text(r.x + 2, r.y + row, line, inner);
  }
  // Side bars: the left one plain, the right one a scrollbar when there is more than fits.
  for (let row = 0; row < r.height; row++) {
    frame.text(r.x, r.y + row, [span("▏", fg("rule", { bg: "panel" }))], 1);
    const thumb = scroll && row === Math.floor((m.top / Math.max(1, m.items.length - r.height)) * (r.height - 1));
    frame.text(r.x + r.width - 1, r.y + row, [span(thumb ? "┃" : "▕", fg(thumb ? "muted" : "rule", { bg: "panel" }))], 1);
  }
}

function menuRow(it: MenuItem, labelCol: number, width: number, selected: boolean, noColour: boolean): Line {
  const on = selected && !noColour;
  const text = on ? fg("onAccent", { bg: "accent", bold: true }) : fg(it.command || it.value !== undefined ? "text" : "muted", { bold: Boolean(it.command) });
  const quiet = on ? fg("onAccent", { bg: "accent" }) : fg("muted");
  const label: Span[] = [];
  const marker = noColour ? (selected ? "> " : "  ") : "";
  if (marker) label.push(span(marker, text));
  label.push(...highlight(it.label, it.positions ?? [], text, on ? text : fg("accent", { bold: true })));
  if (it.hint) label.push(span(` ${it.hint}`, quiet));
  if (it.current) label.push(span(" ●", on ? text : fg("accent")));
  const left = fit(truncate(label, Math.max(1, labelCol - 1), true), labelCol);
  const detail = it.detail ? [span(clean(it.detail), quiet)] : [];
  const line = [...left, ...detail];
  return on ? fit(line, width, "accent") : truncate(line, width, true);
}

/** The label with matched characters in another style. */
function highlight(text: string, positions: number[], base: Span["style"], hit: Span["style"]): Span[] {
  if (!positions.length) return [span(text, base)];
  const set = new Set(positions);
  const out: Span[] = [];
  let i = 0;
  for (const ch of text) {
    const style = set.has(i) ? hit : base;
    const last = out.at(-1);
    if (last && last.style === style) last.text += ch;
    else out.push(span(ch, style));
    i += ch.length;
  }
  return out;
}
