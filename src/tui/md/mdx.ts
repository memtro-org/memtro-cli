/**
 * MDX and HTML tags, read as text and never run.
 *
 * A tag is parsed for its name and its string attributes only. `{expression}` attributes are skipped over (their
 * braces balanced, their strings respected) and their contents are never looked at again: there is no evaluation
 * path. Known components become a terminal form chosen by name, case-insensitively; anything else shows its children
 * with no tag noise, and anything that does not parse is shown as the literal text it is.
 */
import type { Block, CalloutTone, Ctx } from "./ast.js";

export interface Tag {
  /** Lower-cased name ("note", "tabitem", "img"). */
  lname: string;
  name: string;
  /** String attributes by lower-cased name; an expression or bare attribute is recorded as null. */
  attrs: Map<string, string | null>;
  selfClosing: boolean;
  closing: boolean;
  /** Offset just after the tag's `>`. */
  end: number;
}

/** The longest tag (with its attributes) looked at; anything longer is text. */
const MAX_TAG = 4096;

/** Elements that never have children, whether or not they are written with `/>`. */
export const VOID = new Set(["br", "img", "hr", "wbr", "input", "source", "meta", "link", "col", "area", "embed", "param", "track"]);

/** Tags that live inside a paragraph: a line starting with one is prose, not a block. */
export const INLINE_TAGS = new Set([
  "a", "b", "i", "em", "strong", "code", "kbd", "sup", "sub", "span", "br", "img", "s", "del", "strike", "u", "ins",
  "mark", "small", "abbr", "cite", "q", "var", "samp", "tt", "font", "time",
]);

const NAME = /[A-Za-z][\w.:-]*/y;
const ATTR_NAME = /[A-Za-z_:@$][\w.:@$-]*/y;
const UNQUOTED = /[^\s"'=<>`]+/y;

/**
 * Reads a tag at `pos` (which holds `<`). Returns null when it is not a tag, or "incomplete" when the text ends
 * inside what could still become one (for a stream that has not finished).
 */
export function parseTag(src: string, pos: number): Tag | null | "incomplete" {
  const limit = Math.min(src.length, pos + MAX_TAG);
  let i = pos + 1;
  let closing = false;
  if (src[i] === "/") {
    closing = true;
    i++;
  }
  NAME.lastIndex = i;
  const nm = NAME.exec(src);
  if (!nm) return i >= src.length ? "incomplete" : null;
  const name = nm[0];
  i = NAME.lastIndex;
  const attrs = new Map<string, string | null>();
  const ws = () => {
    while (i < limit && /\s/.test(src[i]!)) i++;
  };
  for (;;) {
    const before = i;
    ws();
    if (i >= limit) return limit === src.length ? "incomplete" : null;
    const ch = src[i]!;
    if (ch === ">") return { lname: name.toLowerCase(), name, attrs, selfClosing: false, closing, end: i + 1 };
    if (ch === "/") {
      if (i + 1 >= src.length) return "incomplete";
      if (src[i + 1] === ">") return { lname: name.toLowerCase(), name, attrs, selfClosing: true, closing, end: i + 2 };
      return null;
    }
    if (closing) return null;
    if (i === before) return null; // attributes are separated by whitespace
    if (ch === "{") {
      const end = skipExpression(src, i, limit);
      if (end < 0) return end === -2 ? "incomplete" : null;
      i = end; // a spread attribute: skipped
      continue;
    }
    ATTR_NAME.lastIndex = i;
    const an = ATTR_NAME.exec(src);
    if (!an) return null;
    const key = an[0].toLowerCase();
    i = ATTR_NAME.lastIndex;
    ws();
    if (src[i] !== "=") {
      if (!attrs.has(key)) attrs.set(key, null);
      continue;
    }
    i++;
    ws();
    if (i >= limit) return limit === src.length ? "incomplete" : null;
    const q = src[i]!;
    if (q === '"' || q === "'") {
      const close = src.indexOf(q, i + 1);
      if (close < 0 || close >= limit) return limit === src.length && close < 0 ? "incomplete" : null;
      if (!attrs.has(key)) attrs.set(key, decodeAttr(src.slice(i + 1, close)));
      i = close + 1;
    } else if (q === "{") {
      const end = skipExpression(src, i, limit);
      if (end < 0) return end === -2 ? "incomplete" : null;
      // `title={"Text"}` and `title={'Text'}` are plainly strings; anything else is an expression, not read.
      const inner = src.slice(i + 1, end - 1).trim();
      const lit = /^(["'`])([^"'`\\{}$]*)\1$/.exec(inner);
      if (!attrs.has(key)) attrs.set(key, lit ? lit[2]! : null);
      i = end;
    } else {
      UNQUOTED.lastIndex = i;
      const uv = UNQUOTED.exec(src);
      if (!uv) return null;
      if (!attrs.has(key)) attrs.set(key, uv[0]);
      i = UNQUOTED.lastIndex;
    }
  }
}

function decodeAttr(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The offset after a balanced `{…}` starting at `pos`, skipping strings and comments inside it; -1 when it does
 * not close within `limit`, -2 when the text ends first.
 */
export function skipExpression(src: string, pos: number, limit: number): number {
  let depth = 0;
  let i = pos;
  while (i < limit) {
    const ch = src[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < limit && src[i] !== ch) {
        if (src[i] === "\\") i++;
        i++;
      }
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0 || end >= limit) break;
      i = end + 1;
    }
    i++;
  }
  return limit >= src.length ? -2 : -1;
}

/** The text last asked about, lower-cased once, and where `</name` last appears in it, by name. */
let lowered: { src: string; lower: string; last: Map<string, number> } | null = null;

/**
 * Where the last `</name` in `src` starts (case-insensitively), or -1. An opening after it can never close, so a
 * page of unclosed tags costs one look each instead of a scan to the end each.
 */
function lastCloseAt(src: string, lname: string): number {
  if (!lowered || lowered.src !== src) lowered = { src, lower: src.toLowerCase(), last: new Map() };
  let at = lowered.last.get(lname);
  if (at === undefined) {
    at = lowered.lower.lastIndexOf(`</${lname}`);
    lowered.last.set(lname, at);
  }
  return at;
}

/**
 * Where the element opened before `from` closes: the matching `</name>` (case-insensitively, counting nested
 * openings of the same name, ignoring anything inside fenced code). "eof" when the text ends first; null when the
 * work budget ran out.
 */
export function findBlockClose(src: string, from: number, lname: string, ctx: Ctx): { start: number; end: number } | "eof" | null {
  if (lastCloseAt(src, lname) < from) return "eof";
  let depth = 0;
  let pos = from;
  let fence: string | null = null;
  let atLineStart = from === 0 || src[from - 1] === "\n";
  const n = src.length;
  while (pos < n) {
    const lineEnd = src.indexOf("\n", pos) < 0 ? n : src.indexOf("\n", pos);
    ctx.budget.n -= lineEnd - pos + 1;
    if (ctx.budget.n < 0) return null;
    if (atLineStart) {
      const m = /^[ \t]*(`{3,}|~{3,})/.exec(src.slice(pos, Math.min(lineEnd, pos + 64)));
      if (m) {
        const marker = m[1]!;
        if (fence === null) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length && !src.slice(pos, lineEnd).trim().slice(marker.length).trim()) fence = null;
        pos = lineEnd + 1;
        continue;
      }
    }
    if (fence !== null) {
      pos = lineEnd + 1;
      atLineStart = true;
      continue;
    }
    let q = src.indexOf("<", pos);
    while (q >= 0 && q < lineEnd) {
      if (src[q + 1] === "/") {
        const m = /^<\/([A-Za-z][\w.:-]*)\s*>/.exec(src.slice(q, Math.min(n, q + 256)));
        if (m && m[1]!.toLowerCase() === lname) {
          if (depth === 0) return { start: q, end: q + m[0].length };
          depth--;
        }
      } else if (src.slice(q + 1, q + 1 + lname.length).toLowerCase() === lname && /[\s/>]/.test(src[q + 1 + lname.length] ?? "")) {
        const tag = parseTag(src, q);
        if (tag && tag !== "incomplete" && !tag.selfClosing && !VOID.has(tag.lname)) depth++;
      }
      q = src.indexOf("<", q + 1);
    }
    pos = lineEnd + 1;
    atLineStart = true;
  }
  return "eof";
}

/** The matching `</name>` within one paragraph's text, or -1. */
export function findInlineClose(src: string, from: number, lname: string, ctx: Ctx): { start: number; end: number } | null {
  if (lastCloseAt(src, lname) < from) return null;
  let depth = 0;
  let q = src.indexOf("<", from);
  const startBudget = ctx.budget.n;
  while (q >= 0) {
    ctx.budget.n = startBudget - (q - from);
    if (ctx.budget.n < 0) return null;
    if (src[q + 1] === "/") {
      const m = /^<\/([A-Za-z][\w.:-]*)\s*>/.exec(src.slice(q, q + 256));
      if (m && m[1]!.toLowerCase() === lname) {
        if (depth === 0) return { start: q, end: q + m[0].length };
        depth--;
      }
    } else if (src.slice(q + 1, q + 1 + lname.length).toLowerCase() === lname && /[\s/>]/.test(src[q + 1 + lname.length] ?? "")) {
      const tag = parseTag(src, q);
      if (tag && tag !== "incomplete" && !tag.selfClosing && !VOID.has(tag.lname)) depth++;
    }
    q = src.indexOf("<", q + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The component table
// ---------------------------------------------------------------------------------------------------------------

/** Callout kinds by name, with the tone of their bar and the label shown. */
const CALLOUT_KINDS: Record<string, { tone: CalloutTone; label: string }> = {
  note: { tone: "info", label: "Note" },
  info: { tone: "info", label: "Info" },
  tip: { tone: "success", label: "Tip" },
  hint: { tone: "success", label: "Hint" },
  success: { tone: "success", label: "Success" },
  check: { tone: "success", label: "Check" },
  important: { tone: "heading", label: "Important" },
  warning: { tone: "warning", label: "Warning" },
  warn: { tone: "warning", label: "Warning" },
  caution: { tone: "warning", label: "Caution" },
  attention: { tone: "warning", label: "Attention" },
  danger: { tone: "danger", label: "Danger" },
  error: { tone: "danger", label: "Error" },
};

/** A callout's tone and label from a kind word ("NOTE", "warning", "Danger"); unknown kinds are notes labelled as written. */
export function calloutKind(kind: string): { tone: CalloutTone; label: string } {
  const known = CALLOUT_KINDS[kind.toLowerCase()];
  if (known) return known;
  const word = kind.trim();
  return { tone: "info", label: word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : "Note" };
}

/** Components whose name is the callout's kind. */
const CALLOUT_TAGS = new Set(["note", "tip", "warning", "info", "danger", "caution", "important", "check", "error", "success"]);
/** Components that take the kind from an attribute. */
const CALLOUT_GENERIC = new Set(["callout", "aside", "admonition", "alert"]);

/** The components rendered by their children only (tabs and groups keep their children in order). */
export const PASSTHROUGH = new Set(["tabs", "codegroup", "cardgroup", "columns", "column", "accordiongroup", "tabgroup"]);

function attr(tag: Tag, ...names: string[]): string {
  for (const n of names) {
    const v = tag.attrs.get(n);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Plain text of the paragraphs and headings in blocks, for a heading or title taken from children. */
export function blocksText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.k === "para" || b.k === "heading") out.push(b.text);
    else if (b.k === "plain") out.push(b.lines.join(" "));
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** An element and its parsed children to the blocks that show it. */
export function mapElement(tag: Tag, children: Block[], ctx: Ctx): Block[] {
  const n = tag.lname;
  if (CALLOUT_TAGS.has(n) || CALLOUT_GENERIC.has(n)) {
    const kind = CALLOUT_GENERIC.has(n) ? attr(tag, "type", "kind", "variant", "intent", "status", "severity") || "note" : n;
    const k = calloutKind(kind);
    return [{ k: "callout", tone: k.tone, label: k.label, title: attr(tag, "title", "label", "heading"), children }];
  }
  if (n === "tab" || n === "tabitem") {
    return [{ k: "section", style: "tab", title: attr(tag, "label", "title", "value", "name") || "Tab", href: "", children }];
  }
  if (n === "details" || n === "accordion" || n === "expandable" || n === "collapsible") {
    let title = attr(tag, "summary", "title", "label");
    let rest = children;
    const first = children[0];
    if (first && first.k === "para" && first.tag === "summary") {
      if (!title) title = first.text.replace(/\s+/g, " ").trim();
      rest = children.slice(1);
    }
    return [{ k: "section", style: "details", title: title || "Details", href: "", children: rest }];
  }
  if (n === "summary") {
    const text = blocksText(children);
    return text ? [{ k: "para", text, seq: ctx.seq++, tag: "summary", strong: true }] : [];
  }
  if (n === "steps") {
    // Consecutive steps become one numbered list; anything between them stays where it was, in order.
    const out: Block[] = [];
    let list: Extract<Block, { k: "list" }> | null = null;
    for (const b of children) {
      if (b.k === "section" && b.style === "step") {
        const kids: Block[] = b.title ? [{ k: "para", text: b.title, seq: ctx.seq++, strong: true }, ...b.children] : b.children;
        if (!list) {
          list = { k: "list", ordered: true, start: 1, delim: ".", loose: true, items: [] };
          out.push(list);
        }
        list.items.push({ task: null, children: kids });
      } else {
        list = null;
        out.push(b);
      }
    }
    return out;
  }
  if (n === "step") return [{ k: "section", style: "step", title: attr(tag, "title", "label"), href: "", children }];
  if (n === "card") {
    return [{ k: "section", style: "card", title: attr(tag, "title", "label"), href: attr(tag, "href", "link", "url"), children }];
  }
  if (n === "img" || n === "image") {
    const url = attr(tag, "src");
    return url || attr(tag, "alt") ? [{ k: "image", alt: attr(tag, "alt", "title"), url }] : [];
  }
  if (n === "frame" || n === "figure") {
    const caption = attr(tag, "caption");
    return caption ? [...children, { k: "para", text: caption, seq: ctx.seq++, muted: true }] : children;
  }
  if (n === "figcaption" || n === "caption") {
    const text = blocksText(children);
    return text ? [{ k: "para", text, seq: ctx.seq++, muted: true }] : [];
  }
  if (n === "hr") return [{ k: "hr" }];
  if (n === "br") return [];
  const h = /^h([1-6])$/.exec(n);
  if (h) {
    const text = blocksText(children);
    return text ? [{ k: "heading", level: Number(h[1]), text, seq: ctx.seq++ }] : [];
  }
  // Everything else, known group or unknown component: its children, with no tag noise.
  return children;
}
