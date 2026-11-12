/** The parsed document: what the block parser produces and the layout draws. */

export type Align = "left" | "right" | "center" | null;

export type CalloutTone = "info" | "success" | "warning" | "danger" | "heading";

export interface ListItem {
  /** null: not a task; true/false: a checked or open task box. */
  task: boolean | null;
  children: Block[];
}

export type Block =
  /** Inline Markdown text. `seq` orders it against reference definitions (see `Ctx.refs`). */
  | { k: "para"; text: string; seq: number; tag?: string; strong?: boolean; muted?: boolean }
  | { k: "heading"; level: number; text: string; seq: number }
  | { k: "code"; lang: string; title: string; lines: string[]; open: boolean }
  | { k: "hr" }
  | { k: "quote"; children: Block[] }
  | { k: "list"; ordered: boolean; start: number; delim: string; loose: boolean; items: ListItem[] }
  | { k: "table"; head: string[]; align: Align[]; rows: string[][]; seq: number }
  | { k: "callout"; tone: CalloutTone; label: string; title: string; children: Block[] }
  /** A titled group from an MDX component: a tab, a details block, a card, a step. */
  | { k: "section"; style: "tab" | "details" | "card" | "step"; title: string; href: string; children: Block[] }
  | { k: "image"; alt: string; url: string }
  /** Text shown as it is, cleaned and wrapped, with no Markdown read into it (beyond a cap, or what failed to parse). */
  | { k: "plain"; lines: string[] };

export interface RefDef {
  dest: string;
  seq: number;
}

/** Shared state for one render. */
export interface Ctx {
  streaming: boolean;
  /** Link reference definitions by normalised label; the first definition of a label wins. */
  refs: Map<string, RefDef>;
  /** Increments for every block that can hold or use a reference, in document order. */
  seq: number;
  /** Work left for scans that could otherwise go quadratic on hostile input (unmatched tags, links, braces). */
  budget: { n: number };
  /** How many JSX openings failed to match; beyond a cap `<` at a line start is ordinary text. */
  jsxFailures: number;
  /** An HTML comment was found with no `-->` after it, so no later one can close either. */
  noCommentClose?: boolean;
}

export function normaliseLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
