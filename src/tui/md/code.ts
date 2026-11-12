/**
 * Source code to coloured lines: one small tokenizer driven by the tables in languages.ts, carrying block comments
 * and multi-line strings from one line to the next. Linear in the input: every scan moves forward and sticky
 * expressions never re-read what is behind them.
 */
import type { HighlightCode, Line, Role, Span, Style } from "../full/types.js";
import { sanitise } from "../sanitise.js";
import { findLanguage, type Lang, type StringForm } from "./languages.js";
import { measurer, type Measure, type Measurer } from "./measure.js";
import { compact, expandTabs } from "./text.js";

interface State {
  /** Inside a block comment: the marker that ends it. */
  block: string | null;
  /** Inside a string that spans lines. */
  str: StringForm | null;
  /** Markup: inside a tag's attributes. */
  inTag: boolean;
  /** CSS: brace depth (properties live inside braces). */
  depth: number;
  /** Dockerfile and console: the previous line ended with a backslash. */
  cont: boolean;
}

const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y;
const IDENT = /[A-Za-z_$\u00c0-\uffff][\w$\u00c0-\uffff]*/y;
const IDENT_DASH = /[A-Za-z_\u00c0-\uffff][\w\u00c0-\uffff-]*/y;
const DOLLAR = /\$(?:\{[^}]{0,200}\}?|\(\(?|[A-Za-z_]\w*|[0-9@#?*!$-])/y;
const DECORATOR = /@[A-Za-z_][\w.]*/y;
const CHAR_LIT = /'(?:\\.[^'\s]{0,8}|[^'\\])'/y;
const LIFETIME = /'[A-Za-z_]\w*/y;
const PUNCT = /[{}()\[\];,.:<>=+\-*\/%!&|^~?\\]+/y;
const OTHER = /[^ \tA-Za-z0-9_$@'"`#\/\-{}()\[\];,.:<>=+*%!&|^~?\\\u00c0-\uffff]+/y;
const SPACES = /[ \t]+/y;

class Out {
  spans: Span[] = [];
  push(text: string, fg?: Role, extra?: Style): void {
    if (!text) return;
    const style: Style | undefined = fg || extra ? { ...(fg ? { fg } : {}), ...extra } : undefined;
    const last = this.spans[this.spans.length - 1];
    if (last && last.style?.fg === style?.fg && !last.style?.bold === !style?.bold && !last.style?.dim === !style?.dim) {
      last.text += text;
    } else this.spans.push({ text, style });
  }
}

function sticky(re: RegExp, line: string, i: number): string | null {
  re.lastIndex = i;
  const m = re.exec(line);
  return m && m.index === i ? m[0] : null;
}

/** Where a string that opened before `from` closes on this line (the index after its close), or -1. */
function closeOf(line: string, from: number, sf: StringForm): number {
  let j = from;
  while (j < line.length) {
    if (sf.escape && line[j] === "\\") {
      j += 2;
      continue;
    }
    if (line.startsWith(sf.close, j)) return j + sf.close.length;
    j++;
  }
  return -1;
}

function nextNonSpace(line: string, from: number): string {
  let j = from;
  while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
  return line[j] ?? "";
}

/** The tokenizer shared by every language, for `line` from `start`. */
function generic(line: string, start: number, lang: Lang, st: State, out: Out): void {
  const n = line.length;
  let i = start;
  if (st.block) {
    const idx = line.indexOf(st.block, i);
    if (idx < 0) {
      out.push(line.slice(i), "synComment");
      return;
    }
    out.push(line.slice(i, idx + st.block.length), "synComment");
    i = idx + st.block.length;
    st.block = null;
  }
  if (st.str) {
    const end = closeOf(line, i, st.str);
    if (end < 0) {
      out.push(line.slice(i), "synString");
      return;
    }
    out.push(line.slice(i, end), "synString");
    i = end;
    st.str = null;
  }
  const ident = lang.dashIdents ? IDENT_DASH : IDENT;
  outer: while (i < n) {
    const c = line[i]!;
    const sp = c === " " || c === "\t" ? sticky(SPACES, line, i) : null;
    if (sp) {
      out.push(sp);
      i += sp.length;
      continue;
    }
    for (const lc of lang.lineComment ?? []) {
      if (line.startsWith(lc, i) && (!lang.hashNeedsSpace || i === 0 || /\s/.test(line[i - 1]!))) {
        out.push(line.slice(i), "synComment");
        return;
      }
    }
    for (const [open, close] of lang.blockComment ?? []) {
      if (!line.startsWith(open, i)) continue;
      const idx = line.indexOf(close, i + open.length);
      if (idx < 0) {
        out.push(line.slice(i), "synComment");
        st.block = close;
        return;
      }
      out.push(line.slice(i, idx + close.length), "synComment");
      i = idx + close.length;
      continue outer;
    }
    if (lang.charQuote && c === "'") {
      const lit = sticky(CHAR_LIT, line, i);
      if (lit) {
        out.push(lit, "synString");
        i += lit.length;
        continue;
      }
      const life = sticky(LIFETIME, line, i);
      if (life) {
        out.push(life, "synType");
        i += life.length;
        continue;
      }
    }
    for (const sf of lang.strings) {
      if (!line.startsWith(sf.open, i)) continue;
      const end = closeOf(line, i + sf.open.length, sf);
      if (end < 0) {
        out.push(line.slice(i), "synString");
        if (sf.multiline) st.str = sf;
        return;
      }
      const isKey = lang.keyStrings && nextNonSpace(line, end) === ":";
      out.push(line.slice(i, end), isKey ? "synKeyword" : "synString");
      i = end;
      continue outer;
    }
    if (lang.dollarVars && c === "$") {
      const v = sticky(DOLLAR, line, i);
      if (v) {
        out.push(v, "synType");
        i += v.length;
        continue;
      }
    }
    if (lang.decorators && c === "@") {
      const d = sticky(DECORATOR, line, i);
      if (d) {
        out.push(d, "synFunction");
        i += d.length;
        continue;
      }
    }
    const prev = i > 0 ? line[i - 1]! : " ";
    if (((c >= "0" && c <= "9") || (c === "." && /\d/.test(line[i + 1] ?? ""))) && !/[\w$]/.test(prev)) {
      const num = sticky(NUMBER, line, i);
      if (num) {
        out.push(num, "synNumber");
        i += num.length;
        continue;
      }
    }
    if (/[A-Za-z_$\u00c0-\uffff]/.test(c)) {
      const word = sticky(ident, line, i);
      if (word) {
        const end = i + word.length;
        const key = lang.caseInsensitive ? word.toLowerCase() : word;
        let role: Role | undefined;
        if (lang.keywords.has(key) || (lang.mode === "docker" && lang.keywords.has(word.toUpperCase()))) role = "synKeyword";
        else if (lang.constants?.has(key)) role = "synNumber";
        else if (lang.macros && line[end] === "!") {
          out.push(`${word}!`, "synFunction");
          i = end + 1;
          continue;
        } else if (nextNonSpace(line, end) === "(" && lang.mode !== "css") role = "synFunction";
        else if (lang.types?.has(key)) role = "synType";
        else if (lang.capitalTypes && /^[A-Z]/.test(word) && /[a-z]/.test(word)) role = "synType";
        else if (lang.mode === "css" && st.depth > 0 && nextNonSpace(line, end) === ":") role = "synKeyword";
        out.push(word, role);
        i = end;
        continue;
      }
    }
    if (lang.mode === "css") {
      if (c === "{") st.depth++;
      else if (c === "}") st.depth = Math.max(0, st.depth - 1);
      if (c === "#" && /[\da-fA-F]/.test(line[i + 1] ?? "") && st.depth > 0) {
        const hex = /#[\da-fA-F]{3,8}\b/y;
        const h = sticky(hex, line, i);
        if (h) {
          out.push(h, "synNumber");
          i += h.length;
          continue;
        }
      }
      if ((c === "." || c === "#" || c === "@") && st.depth === 0 && /[A-Za-z_-]/.test(line[i + 1] ?? "")) {
        const sel = sticky(/[.#@][\w-]+/y, line, i)!;
        out.push(sel, c === "@" ? "synKeyword" : "synFunction");
        i += sel.length;
        continue;
      }
      if (c === "{" || c === "}") {
        out.push(c, "synPunct");
        i++;
        continue;
      }
    }
    const p = sticky(PUNCT, line, i);
    if (p) {
      out.push(p, "synPunct");
      i += p.length;
      continue;
    }
    const o = sticky(OTHER, line, i);
    if (o) {
      out.push(o);
      i += o.length;
      continue;
    }
    out.push(c);
    i++;
  }
}

function markupLine(line: string, lang: Lang, st: State, out: Out): void {
  const n = line.length;
  let i = 0;
  while (i < n) {
    if (st.block) {
      const idx = line.indexOf(st.block, i);
      if (idx < 0) {
        out.push(line.slice(i), "synComment");
        return;
      }
      out.push(line.slice(i, idx + st.block.length), "synComment");
      i = idx + st.block.length;
      st.block = null;
      continue;
    }
    if (st.inTag) {
      const c = line[i]!;
      if (c === ">" || (c === "/" && line[i + 1] === ">")) {
        const t = c === ">" ? ">" : "/>";
        out.push(t, "synPunct");
        i += t.length;
        st.inTag = false;
        continue;
      }
      if (c === '"' || c === "'") {
        const end = line.indexOf(c, i + 1);
        const stop = end < 0 ? n : end + 1;
        out.push(line.slice(i, stop), "synString");
        i = stop;
        continue;
      }
      const attr = sticky(/[^\s=>"'\/]+/y, line, i);
      if (attr) {
        out.push(attr, "synType");
        i += attr.length;
        continue;
      }
      out.push(c, c === "=" ? "synPunct" : undefined);
      i++;
      continue;
    }
    if (line.startsWith("<!--", i)) {
      st.block = "-->";
      out.push("<!--", "synComment");
      i += 4;
      continue;
    }
    const tag = sticky(/<\/?[A-Za-z!?][\w:.-]*/y, line, i);
    if (tag) {
      const slash = tag.startsWith("</") ? 2 : 1;
      out.push(tag.slice(0, slash), "synPunct");
      out.push(tag.slice(slash), "synKeyword");
      i += tag.length;
      st.inTag = true;
      continue;
    }
    const ent = sticky(/&#?\w+;/y, line, i);
    if (ent) {
      out.push(ent, "synNumber");
      i += ent.length;
      continue;
    }
    const text = sticky(/[^<&]+/y, line, i);
    if (text) {
      out.push(text);
      i += text.length;
      continue;
    }
    out.push(line[i]!);
    i++;
  }
  void lang;
}

function yamlLine(line: string, lang: Lang, st: State, out: Out): void {
  if (st.str) return generic(line, 0, lang, st, out);
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return out.push(line, "synComment");
  if (/^(---|\.\.\.)\s*$/.test(line)) return out.push(line, "synPunct");
  const m = /^(\s*(?:-\s+)*)((?:"[^"]*"|'[^']*'|[^\s#'"\-?:,\[\]{}][^#]*?))(\s*:)(?=\s|$)/.exec(line.slice(0, 256));
  let i = 0;
  if (m) {
    const lead = m[1]!;
    out.push(lead.replace(/-/g, ""), undefined);
    // Re-push the dashes as punctuation in place.
    if (lead.includes("-")) {
      out.spans.pop();
      for (const part of lead.split(/(-)/)) out.push(part, part === "-" ? "synPunct" : undefined);
    }
    out.push(m[2]!, "synKeyword");
    out.push(m[3]!, "synPunct");
    i = m[0].length;
  } else {
    const dash = /^(\s*)(-)(?=\s|$)/.exec(line);
    if (dash) {
      out.push(dash[1]!);
      out.push("-", "synPunct");
      i = dash[0].length;
    }
  }
  const rest = line.slice(i);
  const anchor = /^(\s*)([&*][\w-]+)/.exec(rest);
  if (anchor) {
    out.push(anchor[1]!);
    out.push(anchor[2]!, "synType");
    i += anchor[0].length;
  }
  generic(line, i, lang, st, out);
}

function tomlLine(line: string, lang: Lang, st: State, out: Out): void {
  if (st.str) return generic(line, 0, lang, st, out);
  const header = /^(\s*)(\[\[?[^\]]*\]\]?)/.exec(line);
  if (header) {
    out.push(header[1]!);
    out.push(header[2]!, "synType");
    return generic(line, header[0].length, lang, st, out);
  }
  const key = /^(\s*)([\w."'-]+)(\s*=)/.exec(line.slice(0, 256));
  if (key) {
    out.push(key[1]!);
    out.push(key[2]!, "synKeyword");
    out.push(key[3]!, "synPunct");
    return generic(line, key[0].length, lang, st, out);
  }
  generic(line, 0, lang, st, out);
}

function diffLine(line: string, out: Out): void {
  if (line.startsWith("+++") || line.startsWith("---")) out.push(line, undefined, { bold: true });
  else if (line.startsWith("+")) out.push(line, "added");
  else if (line.startsWith("-")) out.push(line, "removed");
  else if (line.startsWith("@@")) out.push(line, "info");
  else if (/^(diff |index |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(line)) out.push(line, "muted", { bold: true });
  else if (line.startsWith("\\")) out.push(line, "muted");
  else out.push(line);
}

function markdownLine(line: string, st: State, out: Out): void {
  if (/^\s*(```|~~~)/.test(line)) {
    st.inTag = !st.inTag;
    return out.push(line, "synPunct");
  }
  if (st.inTag) return out.push(line, "synString");
  if (/^#{1,6}(\s|$)/.test(line)) return out.push(line, "synKeyword", { bold: true });
  if (/^\s*>/.test(line)) return out.push(line, "synComment");
  let i = 0;
  const marker = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(line);
  if (marker) {
    out.push(marker[1]!);
    out.push(marker[2]!, "synPunct");
    out.push(marker[3]!);
    i = marker[0].length;
  }
  const re = /^(?:(`+)([^`]*?)\1|\[([^\]\n]*)\]\(([^)\s]*)\)|(\*\*|__)(.+?)\5)/;
  let last = i;
  const scan = /[`\[*_]/g;
  scan.lastIndex = i;
  let s: RegExpExecArray | null;
  while ((s = scan.exec(line))) {
    const m = re.exec(line.slice(s.index, s.index + 300));
    if (!m) continue;
    out.push(line.slice(last, s.index));
    if (m[1]) out.push(m[0], "synString");
    else if (m[4] !== undefined) {
      out.push("[", "synPunct");
      out.push(m[3]!, "synFunction");
      out.push("](", "synPunct");
      out.push(m[4], "synString");
      out.push(")", "synPunct");
    } else out.push(m[0], undefined, { bold: true });
    last = s.index + m[0].length;
    scan.lastIndex = last;
  }
  out.push(line.slice(last));
}

function dockerLine(line: string, lang: Lang, st: State, out: Out): void {
  const cont = st.cont;
  st.cont = /\\\s*$/.test(line);
  if (st.str || cont) return generic(line, 0, lang, st, out);
  if (/^\s*#/.test(line)) return out.push(line, "synComment");
  const m = /^(\s*)([A-Za-z]+)(?=\s|$)/.exec(line);
  if (m && lang.keywords.has(m[2]!.toUpperCase())) {
    out.push(m[1]!);
    out.push(m[2]!, "synKeyword");
    return generic(line, m[0].length, lang, st, out);
  }
  generic(line, 0, lang, st, out);
}

const PROMPT = /^(\s*(?:\$|%|❯|➜|>|PS [^>\n]{0,80}>|[\w.@-]{1,64}[:~][^$#\n]{0,80}[$#])\s)/;

function consoleLine(line: string, lang: Lang, st: State, out: Out): void {
  if (st.cont || st.str) {
    st.cont = /\\\s*$/.test(line);
    return generic(line, 0, lang, st, out);
  }
  const p = PROMPT.exec(line);
  if (!p) return out.push(line);
  out.push(p[1]!, "muted", { dim: true });
  st.cont = /\\\s*$/.test(line);
  generic(line, p[1]!.length, lang, st, out);
}

/** Highlights already-clean lines (no controls, tabs expanded). One `Line` per input line. */
export function highlightLines(lines: string[], language: string | undefined): Line[] {
  const lang = findLanguage(language);
  if (!lang) return lines.map((l) => (l ? [{ text: l }] : []));
  const st: State = { block: null, str: null, inTag: false, depth: 0, cont: false };
  return lines.map((line) => {
    const out = new Out();
    switch (lang.mode) {
      case "markup":
        markupLine(line, lang, st, out);
        break;
      case "yaml":
        yamlLine(line, lang, st, out);
        break;
      case "toml":
        tomlLine(line, lang, st, out);
        break;
      case "diff":
        diffLine(line, out);
        break;
      case "markdown":
        markdownLine(line, st, out);
        break;
      case "docker":
        dockerLine(line, lang, st, out);
        break;
      case "console":
        consoleLine(line, lang, st, out);
        break;
      default:
        generic(line, 0, lang, st, out);
    }
    return compact(out.spans);
  });
}

/** Clean code to lines: sanitised, split, tabs expanded (stops of four), then highlighted. */
export function codeToLines(code: string, language: string | undefined, m: Measurer): Line[] {
  const clean = sanitise(code).replace(/\r/g, "");
  const lines = clean.split("\n").map((l) => expandTabs(l, m));
  return highlightLines(lines, language);
}

export const highlightCode: HighlightCode & ((code: string, language: string | undefined, measure?: Measure) => Line[]) = (
  code,
  language,
  measure?: Measure,
) => codeToLines(code, language, measurer(measure));
