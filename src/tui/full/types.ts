/**
 * The seams of the full-screen interface, in one file.
 *
 * Three parts meet here: the screen (a grid of cells, painted by difference), the text renderers (Markdown and
 * everything else that turns content into styled lines), and the application (what is on screen and what a key
 * does). Each depends on these types and on none of the others' modules.
 *
 * One rule runs through all of it: nothing that came from a model, a tool, a file or the network reaches a cell
 * without passing `sanitise` (src/tui/sanitise.ts) first. A `Span`'s text is trusted to be clean; whoever builds a
 * span from outside text is the one who cleans it.
 */

/**
 * A colour by what it is for, never by value, so a theme can change every one of them.
 *
 * `page` is the terminal behind everything; `panel` the input and menus, one step raised; `dialog` a box over the
 * screen; `backdrop` the page behind a dialog. `accent` is the single interactive colour (a selected row, a
 * link, the input's bar); `onAccent` is text drawn on it.
 */
export type Role =
  | "page" | "panel" | "dialog" | "backdrop" | "rule"
  | "text" | "muted" | "faint" | "onAccent"
  | "accent" | "user" | "success" | "warning" | "danger" | "info" | "heading"
  | "codeBg" | "added" | "addedBg" | "removed" | "removedBg"
  | "synKeyword" | "synString" | "synNumber" | "synComment" | "synFunction" | "synType" | "synPunct";

export interface Style {
  fg?: Role;
  bg?: Role;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** An address the terminal may open (OSC 8). Always http(s) or mailto, already checked; never from raw text. */
  link?: string;
}

/** A run of text in one style. No newlines, no control characters: the builder has cleaned it. */
export interface Span {
  text: string;
  style?: Style;
}

/** One row of text. Its width is the sum of its spans' display widths (`displayWidth`), never `.length`. */
export type Line = Span[];

export interface Rgb { r: number; g: number; b: number }

export interface Theme {
  name: string;
  dark: boolean;
  colours: Record<Role, Rgb>;
}

/** How much colour the terminal can show; the screen degrades a theme to it. */
export type ColourDepth = "truecolor" | "256" | "16" | "none";

// ---------------------------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------------------------

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * What one repaint draws into. Coordinates are cells from the top left. Everything clips to the frame and to the
 * `clip` given; drawing outside is ignored, never an error. A wide character takes two cells and is never split:
 * if only one cell is left it is replaced by a space.
 */
export interface Frame {
  readonly width: number;
  readonly height: number;
  /** Fills cells with a background role (and spaces), keeping nothing that was there. */
  fill(rect: Rect, bg: Role): void;
  /** Draws a line starting at x,y, cut to `maxWidth` cells. Spans without `bg` keep the cell's background. */
  text(x: number, y: number, line: Line, maxWidth: number): void;
  /** Darkens everything already drawn in the rect towards `backdrop` (for behind a dialog). */
  dim(rect: Rect): void;
  /** Where the terminal's cursor should be after this frame, or null to hide it. */
  cursor: { x: number; y: number } | null;
}

/** What the screen reads from the keyboard, mouse and terminal, already decoded. */
export type Input =
  /**
   * A key. `name` is a lower-case key name ("a", "enter", "tab", "escape", "backspace", "delete", "up", "down",
   * "left", "right", "home", "end", "pageup", "pagedown", "space", "f1"…) and `text` is what it types, when it
   * types something. A printable key with no modifier has `text` set and `ctrl`/`alt` false.
   */
  | { type: "key"; name: string; text?: string; ctrl: boolean; alt: boolean; shift: boolean }
  /** Text pasted in one go (bracketed paste). Never interpreted as keys, never able to answer a prompt. */
  | { type: "paste"; text: string }
  | { type: "wheel"; direction: "up" | "down"; x: number; y: number }
  | { type: "resize"; width: number; height: number }
  | { type: "focus"; focused: boolean };

/**
 * The screen as the application sees it. `start` enters the alternate screen and the modes it needs; `stop`
 * leaves every one of them, and is safe to call twice and from a signal handler.
 */
export interface Screen {
  readonly width: number;
  readonly height: number;
  readonly depth: ColourDepth;
  start(): void;
  stop(): void;
  /** Asks for a repaint soon. `draw` is called at most once per tick with a fresh frame; only differences are written. */
  invalidate(): void;
  onDraw(draw: (frame: Frame) => void): void;
  onInput(handler: (input: Input) => void): void;
  /** Milliseconds since the last input arrived, for the approval prompt's settle rule. */
  sinceInput(): number;
}

// ---------------------------------------------------------------------------------------------------------------
// Text renderers
// ---------------------------------------------------------------------------------------------------------------

export interface MarkdownOptions {
  /** Cells available. Every returned line fits it. */
  width: number;
  /** True while the text is still arriving: an unfinished fence, table or emphasis must still render sensibly. */
  streaming: boolean;
}

/** Markdown (CommonMark, GitHub's tables, task lists and strikethrough) and MDX, to lines. Pure. Cleans its input. */
export type RenderMarkdown = (source: string, options: MarkdownOptions) => Line[];

/** Source code to lines, one per source line (not wrapped), coloured for `language` when it is known. Pure. Cleans its input. */
export type HighlightCode = (code: string, language: string | undefined) => Line[];

/** A unified diff to lines, with added and removed rows coloured and line numbers when the diff carries them. Pure. Cleans its input. */
export type RenderDiff = (diff: string, options: { width: number }) => Line[];
