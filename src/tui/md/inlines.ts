/**
 * Inline Markdown: CommonMark's code spans, emphasis (the delimiter algorithm), links and images (inline and
 * reference), autolinks, escapes, entities and hard breaks; GitHub's strikethrough (`~~`) and bare addresses; and
 * MDX's inline tags and `{expressions}`.
 *
 * Linear in practice on any input: every scan that could repeat over the same text (a link destination, a tag's
 * closing partner, an expression's closing brace) draws on a work budget, and once it is spent the remaining
 * markers are read as text. Nesting deeper than a cap is flattened to its text.
 */
import type { Ctx } from "./ast.js";
import { normaliseLabel } from "./ast.js";
import { trimBareUrl } from "./links.js";
import { findInlineClose, parseTag, skipExpression, VOID } from "./mdx.js";

export type Inline =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "em" | "strong" | "del"; c: Inline[] }
  | { t: "link"; url: string; c: Inline[]; auto: boolean }
  | { t: "image"; url: string; alt: string }
  | { t: "br" }
  | { t: "soft" }
  | { t: "kbd"; s: string }
  | { t: "expr"; s: string }
  | { t: "group"; c: Inline[] };

/** Deepest nesting of inline structure kept; anything deeper is shown as its text. */
const MAX_INLINE_DEPTH = 24;
/** How deep tags inside tags are parsed. */
const MAX_TAG_DEPTH = 12;

type Kind = "text" | "code" | "em" | "strong" | "del" | "link" | "image" | "br" | "soft" | "kbd" | "expr" | "inl";

interface PNode {
  kind: Kind;
  text: string;
  url: string;
  auto: boolean;
  first: PNode | null;
  last: PNode | null;
  next: PNode | null;
  prev: PNode | null;
  inl: Inline[] | null;
}

function node(kind: Kind, text = ""): PNode {
  return { kind, text, url: "", auto: false, first: null, last: null, next: null, prev: null, inl: null };
}

interface Delim {
  node: PNode;
  ch: string;
  count: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delim | null;
  next: Delim | null;
}

interface Bracket {
  node: PNode;
  image: boolean;
  prev: Bracket | null;
  prevDelim: Delim | null;
  active: boolean;
  /** Offset just after `[`. */
  start: number;
}

const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", times: "×",
  divide: "÷", deg: "°", plusmn: "±", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", laquo: "«",
  raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", check: "✓", ne: "≠", le: "≤",
  ge: "≥", infin: "∞", micro: "µ", frac12: "½", frac14: "¼", frac34: "¾", prime: "′", Prime: "″", ensp: " ",
  emsp: " ", thinsp: " ", iexcl: "¡", iquest: "¿", dagger: "†", Dagger: "‡", permil: "‰", lambda: "λ",
};

/** A decoded character that would be a control or a direction override is shown as U+FFFD instead. */
function safeChar(cp: number): string {
  if (
    !Number.isFinite(cp) ||
    cp <= 0 ||
    cp > 0x10ffff ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0x200e ||
    cp === 0x200f ||
    cp === 0x061c
  ) {
    return "\ufffd";
  }
  return String.fromCodePoint(cp);
}

const ENTITY = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/y;
const BACKTICKS = /`+/y;
const PLAIN_RUN = /[^\n\\`*_~\[\]!<{&]+/y;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y;
const EMAIL = /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;

export interface InlineOptions {
  /** Resolves a normalised reference label to its destination, or undefined. */
  ref: (label: string) => string | undefined;
  ctx: Ctx;
  depth?: number;
}

class Parser {
  private pos = 0;
  private head = node("text");
  private tail: PNode = this.head;
  private delims: Delim | null = null;
  private brackets: Bracket | null = null;
  private buf = "";
  /** Backtick runs by length, as sorted start offsets, and a cursor into each. */
  private runs: Map<number, number[]> | null = null;
  private runCursor = new Map<number, number>();
  private noCommentClose = false;
  /** Where the next `}` at or after the last brace looked from is, -1 for none left, -2 before the first look. */
  private closeBraceAt = -2;

  constructor(
    private readonly src: string,
    private readonly opts: InlineOptions,
  ) {}

  private get depth(): number {
    return this.opts.depth ?? 0;
  }

  private spend(n: number): boolean {
    this.opts.ctx.budget.n -= n;
    return this.opts.ctx.budget.n >= 0;
  }

  private flush(): void {
    if (!this.buf) return;
    this.append(node("text", this.buf));
    this.buf = "";
  }

  private append(n: PNode): void {
    this.tail.next = n;
    n.prev = this.tail;
    this.tail = n;
  }

  run(): Inline[] {
    const src = this.src;
    const n = src.length;
    while (this.pos < n) {
      const c = src[this.pos]!;
      switch (c) {
        case "\n":
          this.newline();
          break;
        case "\\":
          this.escape();
          break;
        case "`":
          this.backticks();
          break;
        case "*":
        case "_":
        case "~":
          this.delimRun(c);
          break;
        case "[":
          this.flush();
          this.openBracket(false, this.pos + 1);
          this.pos++;
          break;
        case "!":
          if (src[this.pos + 1] === "[") {
            this.flush();
            this.openBracket(true, this.pos + 2);
            this.pos += 2;
          } else {
            this.buf += "!";
            this.pos++;
          }
          break;
        case "]":
          this.closeBracket();
          break;
        case "<":
          this.angle();
          break;
        case "{":
          this.brace();
          break;
        case "&":
          this.entity();
          break;
        default: {
          PLAIN_RUN.lastIndex = this.pos;
          const m = PLAIN_RUN.exec(src);
          if (m) {
            this.buf += m[0];
            this.pos = PLAIN_RUN.lastIndex;
          } else {
            this.buf += c;
            this.pos++;
          }
        }
      }
    }
    this.flush();
    this.processEmphasis(null);
    return convert(this.head.next, 0, true);
  }

  private newline(): void {
    const hard = /  +$/.test(this.buf) || (this.buf === "" && this.tail.kind === "text" && /  +$/.test(this.tail.text));
    this.buf = this.buf.replace(/ +$/, "");
    if (this.tail.kind === "text" && this.buf === "") this.tail.text = this.tail.text.replace(/ +$/, "");
    this.flush();
    this.append(node(hard ? "br" : "soft"));
    this.pos++;
    while (this.src[this.pos] === " ") this.pos++;
  }

  private escape(): void {
    const next = this.src[this.pos + 1];
    if (next === "\n") {
      this.flush();
      this.append(node("br"));
      this.pos += 2;
      while (this.src[this.pos] === " ") this.pos++;
    } else if (next !== undefined && ASCII_PUNCT.test(next)) {
      this.buf += next;
      this.pos += 2;
    } else {
      this.buf += "\\";
      this.pos++;
    }
  }

  private backticks(): void {
    BACKTICKS.lastIndex = this.pos;
    const m = BACKTICKS.exec(this.src)!;
    const len = m[0].length;
    const after = this.pos + len;
    const close = this.nextRun(len, after);
    if (close < 0) {
      this.buf += m[0];
      this.pos = after;
      return;
    }
    let content = this.src.slice(after, close).replace(/\n/g, " ");
    if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()) content = content.slice(1, -1);
    this.flush();
    this.append(node("code", content));
    this.pos = close + len;
  }

  /** The start of the next backtick run of exactly `len` at or after `from`, or -1. Amortised linear. */
  private nextRun(len: number, from: number): number {
    if (!this.runs) {
      this.runs = new Map();
      const re = /`+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(this.src))) {
        const list = this.runs.get(m[0].length) ?? [];
        list.push(m.index);
        this.runs.set(m[0].length, list);
      }
    }
    const list = this.runs.get(len);
    if (!list) return -1;
    let i = this.runCursor.get(len) ?? 0;
    while (i < list.length && list[i]! < from) i++;
    this.runCursor.set(len, i);
    return i < list.length ? list[i]! : -1;
  }

  private delimRun(ch: string): void {
    const src = this.src;
    let end = this.pos;
    while (src[end] === ch) end++;
    const count = end - this.pos;
    const run = src.slice(this.pos, end);
    if (ch === "~" && count !== 2) {
      this.buf += run;
      this.pos = end;
      return;
    }
    const before = this.pos > 0 ? src[this.pos - 1]! : "\n";
    const after = end < src.length ? src[end]! : "\n";
    const afterWs = WHITESPACE.test(after);
    const beforeWs = WHITESPACE.test(before);
    const afterP = UNICODE_PUNCT.test(after);
    const beforeP = UNICODE_PUNCT.test(before);
    const left = !afterWs && (!afterP || beforeWs || beforeP);
    const right = !beforeWs && (!beforeP || afterWs || afterP);
    let canOpen: boolean;
    let canClose: boolean;
    if (ch === "_") {
      canOpen = left && (!right || beforeP);
      canClose = right && (!left || afterP);
    } else {
      canOpen = left;
      canClose = right;
    }
    this.flush();
    const n = node("text", run);
    this.append(n);
    this.pos = end;
    if (!canOpen && !canClose) return;
    const d: Delim = { node: n, ch, count, orig: count, canOpen, canClose, prev: this.delims, next: null };
    if (this.delims) this.delims.next = d;
    this.delims = d;
  }

  private openBracket(image: boolean, start: number): void {
    const n = node("text", image ? "![" : "[");
    this.append(n);
    this.brackets = { node: n, image, prev: this.brackets, prevDelim: this.delims, active: true, start };
  }

  private closeBracket(): void {
    const closeAt = this.pos;
    this.pos++;
    const opener = this.brackets;
    if (!opener) {
      this.buf += "]";
      return;
    }
    if (!opener.active) {
      this.brackets = opener.prev;
      this.buf += "]";
      return;
    }
    let dest: string | null = null;
    let end = this.pos;
    if (this.src[this.pos] === "(") {
      const r = this.linkTail(this.pos);
      if (r) {
        dest = r.dest;
        end = r.end;
      }
    }
    if (dest === null) {
      const raw = closeAt - opener.start <= 999 ? this.src.slice(opener.start, closeAt) : null;
      let label: string | null = null;
      if (this.src[this.pos] === "[") {
        const close = this.labelEnd(this.pos);
        if (close >= 0) {
          const inner = this.src.slice(this.pos + 1, close);
          label = inner.trim() ? inner : raw;
          end = close + 1;
        }
      } else label = raw;
      if (label !== null && label.length <= 999) {
        const found = this.opts.ref(normaliseLabel(label));
        if (found !== undefined) dest = found;
        else end = this.pos;
      }
    }
    if (dest === null) {
      this.brackets = opener.prev;
      this.buf += "]";
      return;
    }
    this.flush();
    const link = node(opener.image ? "image" : "link");
    link.url = dest;
    const first = opener.node.next;
    if (first) {
      link.first = first;
      link.last = this.tail;
      first.prev = null;
      this.tail.next = null;
    }
    opener.node.next = null;
    opener.node.text = "";
    this.tail = opener.node;
    this.append(link);
    this.processEmphasis(opener.prevDelim);
    this.brackets = opener.prev;
    if (!opener.image) for (let b = this.brackets; b; b = b.prev) if (!b.image) b.active = false;
    this.pos = end;
  }

  /** The offset of the `]` ending a link label starting at `pos` (`[`), or -1. */
  private labelEnd(pos: number): number {
    const limit = Math.min(this.src.length, pos + 1001);
    for (let i = pos + 1; i < limit; i++) {
      const c = this.src[i];
      if (c === "\\") i++;
      else if (c === "[") return -1;
      else if (c === "]") return i;
    }
    return -1;
  }

  /** `(destination "title")` at `pos`, or null. */
  private linkTail(pos: number): { dest: string; end: number } | null {
    const src = this.src;
    const n = Math.min(src.length, pos + 4096);
    let i = pos + 1;
    const skipWs = () => {
      let nl = 0;
      while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\n")) {
        if (src[i] === "\n" && ++nl > 1) return false;
        i++;
      }
      return true;
    };
    const fail = (): null => {
      this.spend(i - pos);
      return null;
    };
    if (this.opts.ctx.budget.n < 0) return null;
    if (!skipWs()) return fail();
    let dest = "";
    if (src[i] === "<") {
      const start = i + 1;
      i++;
      while (i < n && src[i] !== ">" && src[i] !== "\n" && src[i] !== "<") {
        if (src[i] === "\\") i++;
        i++;
      }
      if (src[i] !== ">") return fail();
      dest = src.slice(start, i);
      i++;
    } else {
      const start = i;
      let depth = 0;
      while (i < n) {
        const c = src[i]!;
        if (c === " " || c === "\n" || c === "\t") break;
        if (c === "\\" && i + 1 < n && ASCII_PUNCT.test(src[i + 1]!)) {
          i += 2;
          continue;
        }
        if (c === "(") {
          if (++depth > 32) return fail();
        } else if (c === ")") {
          if (depth === 0) break;
          depth--;
        }
        i++;
      }
      dest = src.slice(start, i);
    }
    const beforeTitle = i;
    if (!skipWs()) return fail();
    const q = src[i];
    if (i > beforeTitle && (q === '"' || q === "'" || q === "(")) {
      const close = q === "(" ? ")" : q;
      i++;
      while (i < n && src[i] !== close) {
        if (src[i] === "\\") i++;
        i++;
      }
      if (i >= n) return fail();
      i++;
      if (!skipWs()) return fail();
    }
    if (src[i] !== ")") return fail();
    i++;
    this.spend(i - pos);
    return { dest: unescape(dest), end: i };
  }

  private angle(): void {
    const src = this.src;
    const pos = this.pos;
    AUTOLINK.lastIndex = pos;
    let m = AUTOLINK.exec(src);
    if (m) {
      this.flush();
      const l = node("link");
      l.url = m[1]!;
      l.auto = true;
      this.append(l);
      this.pos = AUTOLINK.lastIndex;
      return;
    }
    EMAIL.lastIndex = pos;
    m = EMAIL.exec(src);
    if (m) {
      this.flush();
      const l = node("link");
      l.url = `mailto:${m[1]!}`;
      l.auto = true;
      l.first = l.last = node("text", m[1]!);
      this.append(l);
      this.pos = EMAIL.lastIndex;
      return;
    }
    if (src.startsWith("<!--", pos)) {
      const end = this.noCommentClose ? -1 : src.indexOf("-->", pos + 4);
      if (end >= 0) {
        this.pos = end + 3;
        return;
      }
      this.noCommentClose = true;
    } else if (/[A-Za-z]/.test(src[pos + 1] ?? "") && this.depth < MAX_TAG_DEPTH && this.opts.ctx.budget.n > 0) {
      if (this.tag()) return;
    }
    this.buf += "<";
    this.pos++;
  }

  /** An inline HTML or JSX element at `pos`; false when it does not parse or does not close. */
  private tag(): boolean {
    const src = this.src;
    const tag = parseTag(src, this.pos);
    if (!tag || tag === "incomplete" || tag.closing) return false;
    this.spend(tag.end - this.pos);
    const n = tag.lname;
    const emit = (inl: Inline[]) => {
      this.flush();
      const p = node("inl");
      p.inl = inl;
      this.append(p);
    };
    if (tag.selfClosing || VOID.has(n)) {
      if (n === "br") emit([{ t: "br" }]);
      else if (n === "img" || n === "image") {
        const url = tag.attrs.get("src") ?? "";
        emit([{ t: "image", url: url ?? "", alt: tag.attrs.get("alt") ?? "" }]);
      } else emit([]);
      this.pos = tag.end;
      return true;
    }
    const close = findInlineClose(src, tag.end, n, this.opts.ctx);
    if (!close) return false;
    const inner = src.slice(tag.end, close.start);
    const sub = (): Inline[] => parseInlines(inner, { ...this.opts, depth: this.depth + 1 });
    switch (n) {
      case "b":
      case "strong":
        emit([{ t: "strong", c: sub() }]);
        break;
      case "i":
      case "em":
      case "cite":
      case "var":
        emit([{ t: "em", c: sub() }]);
        break;
      case "del":
      case "s":
      case "strike":
        emit([{ t: "del", c: sub() }]);
        break;
      case "code":
      case "tt":
      case "samp":
        emit([{ t: "code", s: decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s*\n\s*/g, " ") }]);
        break;
      case "kbd":
        emit([{ t: "kbd", s: plainText(sub()).trim() }]);
        break;
      case "a": {
        const href = tag.attrs.get("href");
        emit(typeof href === "string" && href ? [{ t: "link", url: href, c: sub(), auto: false }] : [{ t: "group", c: sub() }]);
        break;
      }
      default:
        emit([{ t: "group", c: sub() }]);
    }
    this.pos = close.end;
    return true;
  }

  private brace(): void {
    const src = this.src;
    const limit = Math.min(src.length, this.pos + 2000);
    // No `}` before the limit: it cannot close, and nothing is scanned (a page of `{a ` would otherwise scan 2000
    // characters per brace).
    if (this.closeBraceAt !== -1 && this.closeBraceAt < this.pos) this.closeBraceAt = src.indexOf("}", this.pos);
    const reachable = this.closeBraceAt >= 0 && this.closeBraceAt < limit;
    const end = reachable && this.opts.ctx.budget.n > 0 ? skipExpression(src, this.pos, limit) : -1;
    if (end < 0) {
      // A scan that failed cost up to the limit, and is charged that.
      if (reachable) this.spend(limit - this.pos);
      this.buf += "{";
      this.pos++;
      return;
    }
    this.spend(end - this.pos);
    const text = src.slice(this.pos, end);
    this.pos = end;
    // `{/* a comment */}` is MDX's comment: dropped.
    if (/^\{\s*\/\*[\s\S]*\*\/\s*\}$/.test(text)) return;
    this.flush();
    const e = node("expr", text.replace(/\s*\n\s*/g, " "));
    this.append(e);
  }

  private entity(): void {
    ENTITY.lastIndex = this.pos;
    const m = ENTITY.exec(this.src);
    if (m) {
      let ch: string | undefined;
      if (m[1]) ch = safeChar(Number.parseInt(m[1], 10));
      else if (m[2]) ch = safeChar(Number.parseInt(m[2], 16));
      else ch = ENTITIES[m[3]!];
      if (ch !== undefined) {
        this.buf += ch;
        this.pos = ENTITY.lastIndex;
        return;
      }
    }
    this.buf += "&";
    this.pos++;
  }

  /** CommonMark's process_emphasis over the delimiters above `bottom`. */
  private processEmphasis(bottom: Delim | null): void {
    if (this.delims === bottom) return;
    let closer: Delim | null = this.delims;
    while (closer && closer.prev !== bottom) closer = closer.prev;
    const openersBottom = new Map<string, Delim | null>();
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const key = closer.ch + (closer.ch === "~" ? "" : String(closer.orig % 3)) + (closer.canOpen ? "o" : "");
      const floor = openersBottom.has(key) ? openersBottom.get(key)! : bottom;
      let opener: Delim | null = closer.prev;
      let found = false;
      while (opener && opener !== bottom && opener !== floor) {
        if (opener.ch === closer.ch && opener.canOpen) {
          if (closer.ch === "~") {
            if (opener.count === closer.count) {
              found = true;
              break;
            }
          } else {
            const odd =
              (opener.canClose || closer.canOpen) &&
              (opener.orig + closer.orig) % 3 === 0 &&
              !(opener.orig % 3 === 0 && closer.orig % 3 === 0);
            if (!odd) {
              found = true;
              break;
            }
          }
        }
        opener = opener.prev;
      }
      if (found && opener) {
        const use = closer.ch === "~" ? closer.count : closer.count >= 2 && opener.count >= 2 ? 2 : 1;
        opener.count -= use;
        closer.count -= use;
        opener.node.text = opener.node.text.slice(0, opener.count);
        closer.node.text = closer.node.text.slice(0, closer.count);
        const wrap = node(closer.ch === "~" ? "del" : use === 2 ? "strong" : "em");
        const first = opener.node.next;
        const last = closer.node.prev;
        if (first && last && first !== closer.node) {
          wrap.first = first;
          wrap.last = last;
          first.prev = null;
          last.next = null;
        }
        opener.node.next = wrap;
        wrap.prev = opener.node;
        wrap.next = closer.node;
        closer.node.prev = wrap;
        // Delimiters between the pair are now inside it and can match nothing outside.
        opener.next = closer;
        closer.prev = opener;
        if (opener.count === 0) this.removeDelim(opener);
        if (closer.count === 0) {
          const next: Delim | null = closer.next;
          this.removeDelim(closer);
          closer = next;
        }
      } else {
        openersBottom.set(key, closer.prev);
        const next: Delim | null = closer.next;
        if (!closer.canOpen) this.removeDelim(closer);
        closer = next;
      }
    }
    while (this.delims && this.delims !== bottom) this.removeDelim(this.delims);
  }

  private removeDelim(d: Delim): void {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    if (this.delims === d) this.delims = d.prev;
    d.prev = d.next = null;
  }
}

function unescape(text: string): string {
  return decodeEntities(text.replace(/\\([!-\/:-@\[-`{-~])/g, "$1"));
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (all, dec, hex, name) => {
    if (dec) return safeChar(Number.parseInt(dec, 10));
    if (hex) return safeChar(Number.parseInt(hex, 16));
    return ENTITIES[name] ?? all;
  });
}

/** Plain text of inlines (alt text, a kbd label, comparisons). Iterative, so depth costs nothing. */
export function plainText(inl: Inline[]): string {
  let out = "";
  const stack: Inline[] = [...inl].reverse();
  while (stack.length) {
    const x = stack.pop()!;
    switch (x.t) {
      case "text":
      case "code":
      case "kbd":
      case "expr":
        out += x.s;
        break;
      case "br":
      case "soft":
        out += " ";
        break;
      case "image":
        out += x.alt;
        break;
      case "link":
        if (x.c.length === 0) out += x.url;
        else for (let i = x.c.length - 1; i >= 0; i--) stack.push(x.c[i]!);
        break;
      default:
        for (let i = x.c.length - 1; i >= 0; i--) stack.push(x.c[i]!);
    }
  }
  return out;
}

/** Text of a node chain, iteratively (for nesting beyond the cap). */
function chainText(first: PNode | null): string {
  let out = "";
  const stack: PNode[] = [];
  let n: PNode | null = first;
  while (n || stack.length) {
    if (!n) {
      n = stack.pop()!.next;
      continue;
    }
    if (n.kind === "text" || n.kind === "code" || n.kind === "kbd" || n.kind === "expr") out += n.text;
    else if (n.kind === "br" || n.kind === "soft") out += " ";
    else if (n.kind === "inl" && n.inl) out += plainText(n.inl);
    if (n.first) {
      stack.push(n);
      n = n.first;
      continue;
    }
    n = n.next;
  }
  return out;
}

const BARE_URL = /(?:https?:\/\/|www\.)[^\s<]*/gi;

/** Text with GitHub's bare addresses turned into autolinks. */
function linkify(text: string, out: Inline[]): void {
  if (!/https?:\/\/|www\./i.test(text)) {
    out.push({ t: "text", s: text });
    return;
  }
  let last = 0;
  BARE_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_URL.exec(text))) {
    const start = m.index;
    const prev = start > 0 ? text[start - 1]! : " ";
    if (!/[\s*_~(\["']/.test(prev)) continue;
    const url = trimBareUrl(m[0]);
    const domain = /^(?:https?:\/\/|www\.)([^/?#\s]*)/i.exec(url)?.[1] ?? "";
    if (!/^[\w-]+(\.[\w-]+)+/.test(domain) && !/^(localhost|\[[\d:a-f]+\]|[\d.]+)(:\d+)?$/i.test(domain)) continue;
    if (start > last) out.push({ t: "text", s: text.slice(last, start) });
    const dest = /^www\./i.test(url) ? `http://${url}` : url;
    out.push({ t: "link", url: dest, c: [{ t: "text", s: url }], auto: true });
    last = start + url.length;
    BARE_URL.lastIndex = last;
  }
  if (last < text.length) out.push({ t: "text", s: text.slice(last) });
}

function convert(first: PNode | null, depth: number, linkable: boolean): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flushText = () => {
    if (!text) return;
    if (linkable) linkify(text, out);
    else out.push({ t: "text", s: text });
    text = "";
  };
  for (let n = first; n; n = n.next) {
    if (n.kind === "text") {
      text += n.text;
      continue;
    }
    flushText();
    if (depth >= MAX_INLINE_DEPTH && n.first) {
      out.push({ t: "text", s: chainText(n.first) });
      continue;
    }
    switch (n.kind) {
      case "code":
      case "kbd":
      case "expr":
        out.push({ t: n.kind, s: n.text });
        break;
      case "br":
      case "soft":
        out.push({ t: n.kind });
        break;
      case "em":
      case "strong":
      case "del":
        out.push({ t: n.kind, c: convert(n.first, depth + 1, linkable) });
        break;
      case "link":
        out.push({ t: "link", url: n.url, c: n.auto && !n.first ? [] : convert(n.first, depth + 1, false), auto: n.auto });
        break;
      case "image":
        out.push({ t: "image", url: n.url, alt: chainText(n.first) });
        break;
      case "inl":
        if (n.inl) out.push(...n.inl);
        break;
    }
  }
  flushText();
  return out;
}

/** Inline Markdown to a tree. Never throws; text that matches nothing is text. */
export function parseInlines(src: string, opts: InlineOptions): Inline[] {
  if ((opts.depth ?? 0) > MAX_TAG_DEPTH) return [{ t: "text", s: src.replace(/\n/g, " ") }];
  return new Parser(src, opts).run();
}
