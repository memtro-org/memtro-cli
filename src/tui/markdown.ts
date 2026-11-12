import { sanitise } from "./sanitise.js";
import { SGR } from "./style.js";

/**
 * Light Markdown for text that arrives in pieces.
 *
 * Headings are bold, `**bold**` is bold, `inline code` is coloured, and fenced code is passed through exactly as
 * written: inside a fence nothing is interpreted, so code that merely looks like Markdown is never changed. A
 * marker split across two deltas (`*` then `*`, two backticks then a third) is held back until the next character
 * says what it was; so is the start of each line until it is clear whether it opens or closes a fence.
 *
 * Without colour the text is passed through as written (sanitised), because Markdown is the honest form of it for
 * a pipe or a file. Styles never outlive their line, so an unclosed `**` cannot turn the rest of an answer bold.
 */
export interface MarkdownStream {
  push(delta: string): string;
  /** Whatever was held back, and every style closed. */
  end(): string;
}

export function createMarkdown(colour: boolean): MarkdownStream {
  return colour ? new Styled() : new Plain();
}

/** A carriage return or a high surrogate at the end of a delta waits for the next one. */
function carryOver(carry: string, delta: string): { text: string; carry: string } {
  let s = carry + delta;
  let keep = "";
  const last = s.charCodeAt(s.length - 1);
  if (s.endsWith("\r") || (last >= 0xd800 && last <= 0xdbff)) {
    keep = s.slice(-1);
    s = s.slice(0, -1);
  }
  return { text: sanitise(s), carry: keep };
}

class Plain implements MarkdownStream {
  private carry = "";
  push(delta: string): string {
    const r = carryOver(this.carry, delta);
    this.carry = r.carry;
    return r.text;
  }
  end(): string {
    const rest = sanitise(this.carry);
    this.carry = "";
    return rest;
  }
}

type Kind = "start" | "hold" | "text" | "heading" | "code";

class Styled implements MarkdownStream {
  private carry = "";
  /** The current line so far, while its kind is undecided ("start") or it is a fence line held whole ("hold"). */
  private head = "";
  private kind: Kind = "start";
  /** The open fence's marker (```, ~~~~), or null outside a fence. */
  private fence: string | null = null;
  /** A run of `*` or backticks not yet resolved. */
  private run = "";
  private bold = false;
  /** Length of the backtick run that opened the current code span; 0 outside one. */
  private code = 0;

  push(delta: string): string {
    const r = carryOver(this.carry, delta);
    this.carry = r.carry;
    let out = "";
    for (const ch of r.text) out += this.char(ch);
    return out;
  }

  end(): string {
    let out = "";
    if (this.carry) {
      for (const ch of sanitise(this.carry)) out += this.char(ch);
      this.carry = "";
    }
    if (this.kind === "start" || this.kind === "hold") {
      if (this.kind === "start" && this.head) out += this.decide(true);
      if (this.kind === "start" || this.kind === "hold") out += this.head;
    }
    out += this.closeInline();
    this.head = "";
    this.kind = "start";
    return out;
  }

  private char(ch: string): string {
    if (ch === "\n") return this.endLine();
    switch (this.kind) {
      case "start":
        this.head += ch;
        return this.decide(false);
      case "hold":
        this.head += ch;
        return "";
      case "code":
        return ch;
      default:
        return this.inline(ch);
    }
  }

  /** Looks at the start of a line and settles its kind once it can; until then returns "" and keeps waiting. */
  private decide(complete: boolean): string {
    const head = this.head;
    const spaces = /^ */.exec(head)![0].length;
    const rest = head.slice(spaces);
    if (this.fence) {
      if (spaces > 3) return this.become("code", head);
      if (rest === "") return complete ? this.become("code", head) : "";
      const fc = this.fence[0]!;
      if (rest[0] !== fc) return this.become("code", head);
      const n = runLength(rest, fc);
      if (n === rest.length && !complete && n < this.fence.length) return "";
      if (n >= this.fence.length) {
        this.kind = "hold";
        return "";
      }
      return this.become("code", head);
    }
    if (spaces > 3) return this.becomeText(head);
    if (rest === "") return complete ? this.becomeText(head) : "";
    const c = rest[0]!;
    if (c === "`" || c === "~") {
      const n = runLength(rest, c);
      if (n >= 3) {
        this.kind = "hold";
        return "";
      }
      if (n === rest.length && !complete) return "";
      return this.becomeText(head);
    }
    if (c === "#") {
      const n = runLength(rest, "#");
      if (n === rest.length && !complete) return "";
      if (n <= 6 && (n === rest.length || rest[n] === " ")) {
        this.kind = "heading";
        let out = SGR.bold;
        for (const ch of rest.slice(n).replace(/^ +/, "")) out += this.inline(ch);
        return out;
      }
      return this.becomeText(head);
    }
    return this.becomeText(head);
  }

  private become(kind: Kind, text: string): string {
    this.kind = kind;
    return text;
  }

  private becomeText(head: string): string {
    this.kind = "text";
    let out = "";
    for (const ch of head) out += this.inline(ch);
    return out;
  }

  private endLine(): string {
    let out = "";
    if (this.kind === "start") {
      out += this.decide(true);
      if (this.kind === "start") out += this.head; // a blank line
    }
    if (this.kind === "hold") out += this.fenceLine(this.head);
    out += this.closeInline();
    this.head = "";
    this.kind = "start";
    return `${out}\n`;
  }

  /** A whole line that starts with a run of three or more fence characters. */
  private fenceLine(line: string): string {
    const rest = line.replace(/^ */, "");
    const fc = rest[0]!;
    const n = runLength(rest, fc);
    const after = rest.slice(n);
    if (this.fence) {
      if (fc === this.fence[0] && n >= this.fence.length && after.trim() === "") {
        this.fence = null;
        return `${SGR.dim}${line}${SGR.dimOff}`;
      }
      return line; // looks like a fence, but is content
    }
    if (fc === "`" && after.includes("`")) {
      // Not a fence by CommonMark's rule (a backtick fence's info string has no backticks): ordinary text.
      this.kind = "text";
      let out = "";
      for (const ch of line) out += this.inline(ch);
      return out;
    }
    this.fence = rest.slice(0, n);
    return `${SGR.dim}${line}${SGR.dimOff}`;
  }

  private inline(ch: string): string {
    if (ch === "*" || ch === "`") {
      const out = this.run && this.run[0] !== ch ? this.flushRun() : "";
      this.run += ch;
      return out;
    }
    return this.flushRun() + ch;
  }

  private flushRun(): string {
    const r = this.run;
    this.run = "";
    if (!r) return "";
    if (r[0] === "`") {
      if (this.code === 0) {
        this.code = r.length;
        return SGR.code;
      }
      if (this.code === r.length) {
        this.code = 0;
        return SGR.codeOff;
      }
      return r;
    }
    if (this.code || this.kind === "heading" || r.length !== 2) return r;
    this.bold = !this.bold;
    return this.bold ? SGR.bold : SGR.boldOff;
  }

  /** Ends the line's styles: a pending run is shown as written, and anything open is closed. */
  private closeInline(): string {
    let out = "";
    const r = this.run;
    // A run that closes something open does so; one that would open something at the end of a line is literal.
    if ((r[0] === "`" && this.code === r.length) || (r === "**" && this.bold)) out += this.flushRun();
    else out += r;
    this.run = "";
    if (this.code) out += SGR.codeOff;
    if (this.bold || this.kind === "heading") out += SGR.boldOff;
    this.code = 0;
    this.bold = false;
    return out;
  }
}

function runLength(s: string, ch: string): number {
  let n = 0;
  while (s[n] === ch) n++;
  return n;
}
