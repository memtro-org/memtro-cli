import { parseSlash } from "../../slash.js";
import type { Input } from "../types.js";
import { paletteDialog } from "./commands.js";
import { dialogGeometry, dialogInput, keepSelectedInView } from "./dialog.js";
import { editorHandle, editorSetText, editorTake } from "./editing.js";
import { enterAction, menuFor, moveMenu, selectable, tabAction, type MenuContext } from "./menu.js";
import type { AppState } from "./state.js";
import { scrollBy, scrollTo, topLine } from "./transcript.js";
import { geometry, transcriptLayout } from "./views.js";

/**
 * Keys to state, plus the effects `run.ts` carries out (sending a message, running a command, stopping a turn).
 * The approval panel's keys are not here: they go to its `ApprovalPanel`, which holds the `KeyGate`.
 */

export const DOUBLE_PRESS_MS = 2000;

export type Effect =
  | { kind: "send"; text: string }
  | { kind: "slash"; line: string }
  | { kind: "interrupt" }
  | { kind: "quit" }
  | { kind: "repaint" }
  | { kind: "suspend" }
  /** A dialog row was chosen. */
  | { kind: "choose"; dialog: import("./dialog.js").DialogState; id: string }
  /** The `@` menu needs the workspace's files. */
  | { kind: "files" };

export interface KeyContext {
  now: number;
  menu: MenuContext;
}

export interface Handled {
  state: AppState;
  effects: Effect[];
}

const done = (state: AppState, ...effects: Effect[]): Handled => ({ state, effects });

/** The menu that the editor's text calls for now. */
export function syncMenu(state: AppState, ctx: MenuContext): Handled {
  const m = menuFor(state.editor.text, ctx);
  if (!m) return done(state.overlay.kind === "menu" ? { ...state, overlay: { kind: "none" } } : state);
  if (state.overlay.kind !== "none" && state.overlay.kind !== "menu") return done(state);
  const effects: Effect[] = m.kind === "file" && m.loading ? [{ kind: "files" }] : [];
  return { state: { ...state, overlay: { kind: "menu", menu: m } }, effects };
}

function scrollView(state: AppState, how: "pageup" | "pagedown" | "halfup" | "halfdown" | "top" | "bottom" | "up3" | "down3"): AppState {
  if (state.view !== "conversation") return state;
  const g = geometry(state);
  const h = g.transcript?.height ?? 0;
  if (h <= 0) return state;
  const layout = transcriptLayout(state, g);
  const page = Math.max(1, h - 1);
  const half = Math.max(1, Math.floor(h / 2));
  let scroll = state.scroll;
  switch (how) {
    case "pageup":
      scroll = scrollBy(layout, scroll, -page, h);
      break;
    case "pagedown":
      scroll = scrollBy(layout, scroll, page, h);
      break;
    case "halfup":
      scroll = scrollBy(layout, scroll, -half, h);
      break;
    case "halfdown":
      scroll = scrollBy(layout, scroll, half, h);
      break;
    case "up3":
      scroll = scrollBy(layout, scroll, -3, h);
      break;
    case "down3":
      scroll = scrollBy(layout, scroll, 3, h);
      break;
    case "top":
      scroll = layout.total > h ? scrollTo(layout, 0, h) : scroll;
      break;
    case "bottom":
      scroll = { pinned: true, anchor: { key: 0, offset: 0 } };
      break;
  }
  return { ...state, scroll };
}

/** Pins the view if the scroll position is at or past the bottom (after the transcript shrank, say). */
export function settleScroll(state: AppState): AppState {
  if (state.scroll.pinned || state.view !== "conversation") return state;
  const g = geometry(state);
  const h = g.transcript?.height ?? 0;
  const layout = transcriptLayout(state, g);
  return { ...state, scroll: scrollTo(layout, topLine(layout, state.scroll, h), h) };
}

const isKey = (i: Input, name: string, m: { ctrl?: boolean; alt?: boolean } = {}): boolean =>
  i.type === "key" && i.name === name && i.ctrl === Boolean(m.ctrl) && i.alt === Boolean(m.alt);

/** Everything but the approval panel's keys. */
export function handleInput(state: AppState, input: Input, ctx: KeyContext): Handled {
  if (input.type === "focus") return done(state);
  if (input.type === "resize") return done({ ...state, width: input.width, height: input.height });

  const o = state.overlay;
  if (o.kind === "dialog") {
    if (input.type === "wheel") {
      const { dialog } = dialogInput(o.dialog, { type: "key", name: input.direction, ctrl: false, alt: false, shift: false }, 1);
      return done({ ...state, overlay: { kind: "dialog", dialog } });
    }
    const g = dialogGeometry(o.dialog, state.width, state.height);
    const { dialog, result } = dialogInput(o.dialog, input, g.bodyHeight);
    const kept = keepSelectedInView(dialog, dialogGeometry(dialog, state.width, state.height));
    if (result.kind === "close") return done({ ...state, overlay: { kind: "none" } });
    if (result.kind === "choose") return done({ ...state, overlay: { kind: "none" } }, { kind: "choose", dialog: o.dialog, id: result.row.id });
    return done({ ...state, overlay: { kind: "dialog", dialog: kept } });
  }
  if (o.kind === "approval") return done(state);

  if (input.type === "wheel") return done(scrollView(state, input.direction === "up" ? "up3" : "down3"));

  // Keys that mean the same whatever is open.
  if (isKey(input, "l", { ctrl: true })) return done(state, { kind: "repaint" });
  if (isKey(input, "z", { ctrl: true })) return done(state, { kind: "suspend" });
  if (isKey(input, "pageup")) return done(scrollView(state, "pageup"));
  if (isKey(input, "pagedown")) return done(scrollView(state, "pagedown"));
  if (isKey(input, "u", { ctrl: true, alt: true })) return done(scrollView(state, "halfup"));
  if (isKey(input, "d", { ctrl: true, alt: true })) return done(scrollView(state, "halfdown"));
  if (isKey(input, "g", { ctrl: true })) return done(scrollView(state, "top"));
  if (isKey(input, "g", { ctrl: true, alt: true })) return done(scrollView(state, "bottom"));

  const menuOpen = o.kind === "menu" && !state.menuDismissed;
  if (menuOpen && input.type === "key") {
    const m = o.menu;
    if (isKey(input, "up") || isKey(input, "p", { ctrl: true })) return done({ ...state, overlay: { kind: "menu", menu: moveMenu(m, -1) } });
    if (isKey(input, "down") || isKey(input, "n", { ctrl: true })) return done({ ...state, overlay: { kind: "menu", menu: moveMenu(m, 1) } });
    if (isKey(input, "escape")) return done({ ...state, menuDismissed: true });
    if (isKey(input, "tab")) {
      const a = tabAction(m, state.editor.text);
      if (a.kind !== "complete") return done(state);
      editorSetText(state.editor, a.text);
      return syncMenu({ ...state, menuDismissed: false }, ctx.menu);
    }
    if (isKey(input, "enter") && selectable(m)) {
      const a = enterAction(m, state.editor.text);
      if (a.kind === "complete") {
        editorSetText(state.editor, a.text);
        return syncMenu({ ...state, menuDismissed: false }, ctx.menu);
      }
      if (a.kind === "run") {
        editorSetText(state.editor, "");
        return done({ ...state, overlay: { kind: "none" } }, { kind: "slash", line: a.line });
      }
    }
  }

  if (isKey(input, "p", { ctrl: true }) && !menuOpen) {
    const g = { ...state, overlay: { kind: "dialog" as const, dialog: paletteDialog() } };
    return done(g);
  }

  if (isKey(input, "escape")) {
    if (state.running && !state.stopping) return done({ ...state, stopping: true }, { kind: "interrupt" });
    if (state.queued !== null) {
      // The queued message goes back into the editor rather than away: it was typed, so it is kept.
      if (!state.editor.text) editorSetText(state.editor, state.queued);
      return done({ ...state, queued: null, notice: { text: "The queued message will not be sent.", tone: "plain", at: ctx.now } });
    }
    return done(state);
  }

  if (isKey(input, "c", { ctrl: true })) {
    if (state.running) {
      if (state.stopping && ctx.now - state.lastCtrlC < DOUBLE_PRESS_MS) return done(state, { kind: "quit" });
      return done({ ...state, stopping: true, lastCtrlC: ctx.now, notice: { text: "Stopping… Ctrl-C again to quit.", tone: "warning", at: ctx.now } }, { kind: "interrupt" });
    }
    if (state.editor.text) {
      editorSetText(state.editor, "");
      return syncMenu({ ...state, lastCtrlC: ctx.now, notice: { text: "Cleared. Ctrl-C again to quit.", tone: "plain", at: ctx.now } }, ctx.menu);
    }
    if (ctx.now - state.lastCtrlC < DOUBLE_PRESS_MS) return done(state, { kind: "quit" });
    return done({ ...state, lastCtrlC: ctx.now, notice: { text: "Ctrl-C again (or Ctrl-D) to quit.", tone: "plain", at: ctx.now } });
  }

  if (isKey(input, "d", { ctrl: true }) && !state.editor.text) return done(state, { kind: "quit" });

  // Home and End scroll the conversation only when there is no text for them to move through.
  if (!state.editor.text && isKey(input, "home")) return done(scrollView(state, "top"));
  if (!state.editor.text && isKey(input, "end")) return done(scrollView(state, "bottom"));

  const before = state.editor.text;
  const r = editorHandle(state.editor, input);
  if (r === "submit") return submit(state, ctx);
  if (r === "ignored") return done(state);
  let next: AppState = state.notice && before !== state.editor.text ? { ...state, notice: null } : state;
  if (before !== state.editor.text) next = { ...next, menuDismissed: false };
  return syncMenu(next, ctx.menu);
}

/** Enter with no menu in the way: a command, a message, or a message queued behind the running turn. */
function submit(state: AppState, ctx: KeyContext): Handled {
  const text = state.editor.text;
  if (!text.trim()) return done(state);
  if (state.running) {
    if (state.queued !== null) return done({ ...state, notice: { text: "A message is already queued; Esc twice takes it back.", tone: "warning", at: ctx.now } });
    editorTake(state.editor);
    // The hint row says "queued" for as long as it is.
    return syncMenu({ ...state, queued: text }, ctx.menu);
  }
  editorTake(state.editor);
  const s = { ...state, overlay: { kind: "none" as const }, notice: null };
  if (parseSlash(text)) return done(s, { kind: "slash", line: text.trim() });
  return done(s, { kind: "send", text });
}
