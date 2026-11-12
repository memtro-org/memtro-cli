import type { Answer, Decision, Mode, PendingCall, Risk, SessionRule, ToolResult } from "../../../agent/types.js";
import type { Editor } from "../editor.js";
import type { ApprovalState } from "./approval.js";
import type { DialogState } from "./dialog.js";
import type { MenuState } from "./menu.js";

/**
 * Everything the full-screen interface shows, in one value. `draw(state, frame, theme)` paints it; `applyEvent` and
 * `handleInput` move it on. The editor is the one mutable part (it is S's model of the text being typed).
 */

export type View = "start" | "conversation";

interface Base {
  /** Unique within a state, for caches and for keeping an item at the top of the view across a resize. */
  key: number;
}

export type Item =
  | (Base & { kind: "user"; text: string })
  | (Base & { kind: "assistant"; text: string; done: boolean })
  | (Base & { kind: "thinking"; text: string; done: boolean })
  | (Base & ToolItem)
  | (Base & { kind: "notice"; text: string; tone: "warning" | "info" | "plain" })
  | (Base & { kind: "error"; text: string; retryable: boolean })
  | (Base & { kind: "compaction"; before: number; after: number })
  /** The muted line after an answer: who answered and what it cost. */
  | (Base & { kind: "footer"; model: string; tokens: number | null; interrupted: boolean });

export interface ToolItem {
  kind: "tool";
  id: string;
  tool: string;
  risk: Risk | null;
  title: string;
  command?: string;
  decision?: Decision;
  answer?: Answer;
  /** The approval panel is open for this call. */
  asking: boolean;
  /** Output so far, while it runs. */
  progress: string;
  result?: ToolResult;
}

export interface Status {
  model: string;
  mode: Mode;
  organisation: string | null;
  /** Tokens over the session, when the platform reported any. */
  tokens: number | null;
  contextUsed: number | null;
  contextLimit: number | null;
}

/** Where the transcript is looked at from. Pinned follows the newest line; otherwise an item stays at the top. */
export interface Scroll {
  pinned: boolean;
  /** The item at the top of the view and how many of its lines are above the view. */
  anchor: { key: number; offset: number };
}

export type Overlay =
  | { kind: "none" }
  | { kind: "menu"; menu: MenuState }
  | { kind: "dialog"; dialog: DialogState }
  | { kind: "approval"; approval: ApprovalState };

export interface AppState {
  view: View;
  width: number;
  height: number;
  items: Item[];
  nextKey: number;
  /** The session's title: the first message, cut. */
  title: string;
  editor: Editor;
  overlay: Overlay;
  /** The person pressed Escape on a menu: it stays hidden until the text changes. */
  menuDismissed: boolean;
  scroll: Scroll;
  status: Status;
  /** A turn (or a compaction) is running. */
  running: boolean;
  /** Set when the person asked the running turn to stop. */
  stopping: boolean;
  /** The model that answered this turn (from `routing`), else the one asked. */
  turnModel: string;
  /** Tokens this turn, when any step reported them. */
  turnTokens: number | null;
  /** A message typed while a turn ran, sent when it ends. */
  queued: string | null;
  /** One line under the input (a hint, a confirmation), with when it was set so it can fade. */
  notice: { text: string; tone: "warning" | "info" | "plain"; at: number } | null;
  /** Lines shown on the start screen above the input (an update, a fallback). */
  startNotices: string[];
  /** Advances while something runs, for the spinner. */
  tick: number;
  verbose: boolean;
  version: string;
  cwd: string;
  home: string | undefined;
  placeholder: string;
  /** The time of the last Ctrl-C at an empty prompt, for "twice to quit". */
  lastCtrlC: number;
  themeName: "auto" | "dark" | "light";
  /** The colour depth is "none": selection is shown with a marker as well as a colour. */
  noColour: boolean;
}

export const PLACEHOLDERS = [
  'Ask anything… "Why does the cart test fail?"',
  'Ask anything… "What did we decide about retries?"',
  'Ask anything… "Add a --dry-run flag to the deploy script"',
  'Ask anything… "Summarise what changed this week"',
];

export function createState(o: {
  editor: Editor;
  width: number;
  height: number;
  status: Status;
  version: string;
  cwd: string;
  home?: string;
  verbose?: boolean;
  startNotices?: string[];
  themeName?: "auto" | "dark" | "light";
  noColour?: boolean;
  seed?: number;
}): AppState {
  return {
    view: "start",
    width: o.width,
    height: o.height,
    items: [],
    nextKey: 1,
    title: "",
    editor: o.editor,
    overlay: { kind: "none" },
    menuDismissed: false,
    scroll: { pinned: true, anchor: { key: 0, offset: 0 } },
    status: o.status,
    running: false,
    stopping: false,
    turnModel: o.status.model,
    turnTokens: null,
    queued: null,
    notice: null,
    startNotices: o.startNotices ?? [],
    tick: 0,
    verbose: o.verbose ?? false,
    version: o.version,
    cwd: o.cwd,
    home: o.home,
    placeholder: PLACEHOLDERS[(o.seed ?? 0) % PLACEHOLDERS.length]!,
    lastCtrlC: 0,
    themeName: o.themeName ?? "auto",
    noColour: o.noColour ?? false,
  };
}

/** What a pending approval needs, kept outside the state's drawing so `run.ts` can resolve it. */
export interface ApprovalRequest {
  call: PendingCall;
  decision: Decision;
  suggested: SessionRule | null;
  classifierOn: boolean;
}
