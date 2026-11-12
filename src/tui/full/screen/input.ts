import type { Input } from "../types.js";

/**
 * Bytes from the terminal to `Input`s.
 *
 * Pure and incremental: `feed` takes whatever chunk arrived and returns what it completes; a sequence cut between
 * chunks waits for the rest, so splitting the bytes anywhere gives the same result. A lone ESC waits too: it is an
 * Escape key only if nothing follows it soon, which the caller decides by calling `flush` after a short quiet time.
 *
 * Understood: legacy xterm/VT sequences (CSI and SS3, with modifiers), rxvt and Linux console variants, CSI-u (the
 * kitty keyboard protocol and fixterms), modifyOtherKeys (`CSI 27;mod;code~`), Alt as an ESC prefix, bracketed
 * paste, SGR mouse (only the wheel is reported), focus in/out. Replies to the screen's own queries (device
 * attributes, OSC colour, mode reports, keyboard-protocol flags, cursor position, XTVERSION) are handed to
 * `onReply` and never become keys. Anything else that starts with ESC is dropped whole.
 *
 * Pasted text is never decoded: everything between the paste marks is one `paste` input, newlines kept.
 */

export type Reply =
  | { kind: "da1"; params: string }
  | { kind: "da2"; params: string }
  | { kind: "kitty-flags"; flags: number }
  | { kind: "mode"; mode: number; value: number }
  | { kind: "osc"; code: number; body: string }
  | { kind: "cursor"; row: number; col: number }
  | { kind: "dcs"; body: string }
  | { kind: "window"; params: string };

/** A paste larger than this is cut (the rest is discarded until its end mark) and says so. */
export const PASTE_MAX_BYTES = 4 * 1024 * 1024;
export const PASTE_CUT_NOTE = "\n[paste cut: it was larger than 4 MB]";
/** Longest CSI/SS3 we wait for before deciding it is garbage. */
const MAX_CSI = 64;
/** Longest OSC/DCS/APC string we wait for. */
const MAX_STRING = 4096;

const PASTE_START = Buffer.from("\u001b[200~");
const PASTE_END = Buffer.from("\u001b[201~");

type Mods = { ctrl: boolean; alt: boolean; shift: boolean };
const NONE: Mods = { ctrl: false, alt: false, shift: false };

function key(name: string, m: Mods = NONE, text?: string): Input {
  const k: Input = { type: "key", name, ctrl: m.ctrl, alt: m.alt, shift: m.shift };
  if (text !== undefined) k.text = text;
  return k;
}

/** xterm modifier parameter (1 + bits: 1 shift, 2 alt, 4 ctrl, 8 meta) to flags. Meta counts as Alt. */
function mods(param: number | undefined): Mods {
  const b = Math.max(0, (param ?? 1) - 1);
  return { shift: (b & 1) !== 0, alt: (b & 2) !== 0 || (b & 8) !== 0, ctrl: (b & 4) !== 0 };
}

function withAlt(i: Input): Input {
  if (i.type !== "key") return i;
  const { text: _text, ...rest } = i;
  return { ...rest, alt: true };
}

/** A printable character typed with no modifier other than shift. */
function printable(ch: string, m: Mods = NONE): Input {
  if (ch === " ") return key("space", m, m.ctrl || m.alt ? undefined : " ");
  const lower = ch.toLowerCase();
  const isUpperLetter = lower !== ch && ch.toUpperCase() === ch;
  const shift = m.shift || isUpperLetter;
  return key(lower.length === 1 || [...lower].length === 1 ? lower : ch, { ...m, shift }, m.ctrl || m.alt ? undefined : ch);
}

/** A single C0 byte or DEL as a key. */
function controlKey(b: number): Input | null {
  switch (b) {
    case 0x0d:
      return key("enter");
    case 0x0a:
      return key("j", { ctrl: true, alt: false, shift: false });
    case 0x09:
      return key("tab");
    case 0x7f:
    case 0x08:
      return key("backspace");
    case 0x1b:
      return key("escape");
    case 0x00:
      return key("space", { ctrl: true, alt: false, shift: false });
    case 0x1c:
      return key("\\", { ctrl: true, alt: false, shift: false });
    case 0x1d:
      return key("]", { ctrl: true, alt: false, shift: false });
    case 0x1e:
      return key("^", { ctrl: true, alt: false, shift: false });
    case 0x1f:
      return key("/", { ctrl: true, alt: false, shift: false });
  }
  if (b >= 0x01 && b <= 0x1a) return key(String.fromCharCode(b + 0x60), { ctrl: true, alt: false, shift: false });
  return null;
}

/** Legacy `CSI n ~` numbers. */
const TILDE: Record<number, string> = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10",
  23: "f11", 24: "f12", 25: "f13", 26: "f14", 28: "f15", 29: "f16", 31: "f17", 32: "f18", 33: "f19", 34: "f20",
};

/** Final letters shared by CSI and SS3. */
const LETTER: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", E: "clear",
  P: "f1", Q: "f2", R: "f3", S: "f4",
};

/** Kitty's code points for keys with no character (the ones that matter here). */
const KITTY_FUNCTIONAL: Record<number, string> = {
  57399: "0", 57400: "1", 57401: "2", 57402: "3", 57403: "4", 57404: "5", 57405: "6", 57406: "7", 57407: "8", 57408: "9",
  57409: ".", 57410: "/", 57411: "*", 57412: "-", 57413: "+", 57414: "enter", 57415: "=",
  57417: "left", 57418: "right", 57419: "up", 57420: "down", 57421: "pageup", 57422: "pagedown", 57423: "home",
  57424: "end", 57425: "insert", 57426: "delete",
};
/** Kitty modifier keys pressed on their own: never reported. */
const isKittyModifierKey = (code: number) => code >= 57358 && code <= 57364 ? false : code >= 57441 && code <= 57454;

/** A key from a Unicode code point plus modifiers (CSI-u, modifyOtherKeys). */
function fromCodePoint(code: number, m: Mods, shifted?: number): Input | null {
  switch (code) {
    case 13:
      return key("enter", m);
    case 9:
      return key("tab", m);
    case 27:
      return key("escape", m);
    case 127:
    case 8:
      return key("backspace", m);
    case 32:
      return key("space", m, m.ctrl || m.alt ? undefined : " ");
  }
  const fn = KITTY_FUNCTIONAL[code];
  if (fn) return fn.length === 1 ? printable(fn, m) : key(fn, m);
  if (isKittyModifierKey(code) || (code >= 57344 && code <= 63743)) return null;
  if (code < 32 || (code >= 0x7f && code < 0xa0) || code > 0x10ffff) return null;
  const ch = String.fromCodePoint(code);
  if (m.ctrl || m.alt) return key(ch.toLowerCase(), m);
  const typed = m.shift ? (shifted ? String.fromCodePoint(shifted) : ch.toUpperCase()) : ch;
  return { type: "key", name: ch.toLowerCase(), text: typed, ctrl: false, alt: false, shift: m.shift };
}

const PARAM = /^[0-9;:]*$/;

/** Bytes in the UTF-8 sequence a lead byte starts; 0 for a byte that cannot start one. */
function utf8Length(c: number): number {
  if (c < 0x80) return 1;
  if (c >= 0xc2 && c < 0xe0) return 2;
  if (c >= 0xe0 && c < 0xf0) return 3;
  if (c >= 0xf0 && c < 0xf5) return 4;
  return 0;
}

export class InputDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private pasting = false;
  private paste: Buffer[] = [];
  private pasteBytes = 0;
  private pasteCut = false;

  constructor(private readonly onReply: (reply: Reply) => void = () => {}) {}

  /** What the decoder is holding: a lone ESC waiting for `flush`, an unfinished paste, part of a sequence, or nothing. */
  get pending(): "none" | "escape" | "paste" | "partial" {
    if (this.pasting) return "paste";
    if (this.buf.length === 1 && this.buf[0] === 0x1b) return "escape";
    return this.buf.length ? "partial" : "none";
  }

  feed(chunk: Buffer | string): Input[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    const out: Input[] = [];
    this.parse(out, false);
    return out;
  }

  /**
   * Called after a quiet moment: whatever is waiting is decided. A lone ESC is Escape; an ESC with an unfinished
   * sequence after it is dropped; an unfinished UTF-8 character is dropped. An unfinished paste is NOT ended here
   * (a slow link may pause mid-paste); `endPaste` does that.
   */
  flush(): Input[] {
    const out: Input[] = [];
    if (this.pasting) return out;
    this.parse(out, true);
    return out;
  }

  /** Ends a paste whose end mark never came (after a long quiet time), delivering what arrived. */
  endPaste(): Input[] {
    if (!this.pasting) return [];
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    this.appendPaste(rest);
    return [this.finishPaste()];
  }

  private appendPaste(b: Buffer): void {
    if (!b.length) return;
    if (this.pasteBytes + b.length > PASTE_MAX_BYTES) {
      const room = PASTE_MAX_BYTES - this.pasteBytes;
      if (room > 0) this.paste.push(b.subarray(0, room));
      this.pasteBytes = PASTE_MAX_BYTES;
      this.pasteCut = true;
      return;
    }
    this.paste.push(b);
    this.pasteBytes += b.length;
  }

  private finishPaste(): Input {
    let text = Buffer.concat(this.paste).toString("utf8");
    // A cut in the middle of a character leaves a replacement char at the end; drop it.
    if (this.pasteCut) text = text.replace(/�$/, "") + PASTE_CUT_NOTE;
    text = text.replace(/\r\n?/g, "\n");
    // A nested start mark inside a paste is not content.
    text = text.split("\u001b[200~").join("");
    this.pasting = false;
    this.paste = [];
    this.pasteBytes = 0;
    this.pasteCut = false;
    return { type: "paste", text };
  }

  private parse(out: Input[], final: boolean): void {
    let i = 0;
    const b = this.buf;
    while (i < b.length) {
      if (this.pasting) {
        const end = b.indexOf(PASTE_END, i);
        if (end < 0) {
          // keep a tail that might be the start of the end mark
          const keep = Math.min(PASTE_END.length - 1, b.length - i);
          let cut = b.length - keep;
          // only hold back bytes that could begin the end mark
          while (cut < b.length && b[cut] !== 0x1b) cut++;
          this.appendPaste(b.subarray(i, cut));
          i = cut;
          break;
        }
        this.appendPaste(b.subarray(i, end));
        i = end + PASTE_END.length;
        out.push(this.finishPaste());
        continue;
      }
      const c = b[i]!;
      if (c === 0x1b) {
        if (b.length - i >= PASTE_START.length && b.subarray(i, i + PASTE_START.length).equals(PASTE_START)) {
          this.pasting = true;
          i += PASTE_START.length;
          continue;
        }
        const r = this.escape(b, i, final);
        if (r === null) break; // incomplete: wait
        i = r.next;
        if (r.input) out.push(r.input);
        continue;
      }
      if (c < 0x20 || c === 0x7f) {
        const k = controlKey(c);
        if (k) out.push(k);
        i++;
        continue;
      }
      // UTF-8 text, one character at a time
      const len = utf8Length(c);
      if (len === 0) {
        i++; // stray continuation byte or C1 in 8-bit form: dropped
        continue;
      }
      if (i + len > b.length) {
        if (final) i = b.length; // an unfinished character is dropped
        break;
      }
      let ok = true;
      for (let k = 1; k < len; k++) if ((b[i + k]! & 0xc0) !== 0x80) ok = false;
      if (!ok) {
        i++;
        continue;
      }
      const ch = b.subarray(i, i + len).toString("utf8");
      i += len;
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x80 && cp < 0xa0) continue; // C1 controls are never keys
      out.push(printable(ch));
    }
    this.buf = i >= b.length ? Buffer.alloc(0) : b.subarray(i);
  }

  /**
   * Decodes the escape sequence at `i`. Returns null when it is incomplete (and `final` is false), else where it
   * ends and the input it makes (or none, for a reply or something dropped).
   */
  private escape(b: Buffer, i: number, final: boolean): { next: number; input?: Input } | null {
    if (i + 1 >= b.length) return final ? { next: i + 1, input: key("escape") } : null;
    const n = b[i + 1]!;
    if (n === 0x5b) return this.csi(b, i, i + 2, final, false);
    if (n === 0x4f) return this.ss3(b, i, final, false);
    // OSC and DCS only in the shapes replies take (ESC ] digits ; and ESC P followed by a reply's first byte);
    // otherwise ESC ] and ESC P are Alt+] and Alt+P. APC, PM and SOS are never asked for, so ESC _ ^ X are Alt keys.
    if (n === 0x5d) {
      let j = i + 2;
      while (j < b.length && b[j]! >= 0x30 && b[j]! <= 0x39) j++;
      if (j >= b.length) {
        if (!final) return null;
      } else if (j > i + 2 && b[j] === 0x3b) return this.stringSeq(b, i, final);
    }
    if (n === 0x50) {
      if (i + 2 >= b.length) {
        if (!final) return null;
      } else if (/[0-9>+$!|]/.test(String.fromCharCode(b[i + 2]!))) return this.stringSeq(b, i, final);
    }
    if (n === 0x1b) {
      // ESC ESC: Alt+ a sequence (some terminals send Alt+arrow so), or Alt+Escape.
      if (i + 2 >= b.length) return final ? { next: i + 2, input: key("escape", { ctrl: false, alt: true, shift: false }) } : null;
      const m = b[i + 2]!;
      if (m === 0x5b || m === 0x4f) {
        const r = m === 0x5b ? this.csi(b, i + 1, i + 3, final, true) : this.ss3(b, i + 1, final, true);
        if (r === null) return null;
        return { next: r.next, input: r.input ? withAlt(r.input) : undefined };
      }
      return { next: i + 2, input: key("escape", { ctrl: false, alt: true, shift: false }) };
    }
    // Alt + a key
    if (n < 0x20 || n === 0x7f) {
      const k = controlKey(n);
      return { next: i + 2, input: k ? withAlt(k) : undefined };
    }
    const len = utf8Length(n);
    if (len === 0) return { next: i + 1, input: key("escape") };
    if (i + 1 + len > b.length) return final ? { next: b.length } : null;
    const ch = b.subarray(i + 1, i + 1 + len).toString("utf8");
    const p = printable(ch, { ctrl: false, alt: true, shift: false });
    return { next: i + 1 + len, input: p };
  }

  /** OSC, DCS, APC, PM, SOS: up to BEL or ST. Replies are reported; nothing here is ever a key. */
  private stringSeq(b: Buffer, i: number, final: boolean): { next: number; input?: Input } | null {
    const kind = b[i + 1]!;
    for (let j = i + 2; j < b.length; j++) {
      const c = b[j]!;
      if (j - i > MAX_STRING) return { next: j }; // runaway: drop what we have, resync
      if (c === 0x07 || (c === 0x1b && j + 1 < b.length && b[j + 1] === 0x5c)) {
        const body = b.subarray(i + 2, j).toString("utf8");
        const next = c === 0x07 ? j + 1 : j + 2;
        if (kind === 0x5d) {
          const m = /^(\d+);([\s\S]*)$/.exec(body);
          if (m) this.onReply({ kind: "osc", code: Number(m[1]), body: m[2]! });
        } else if (kind === 0x50) this.onReply({ kind: "dcs", body });
        return { next };
      }
      if (c === 0x1b && j + 1 < b.length && b[j + 1] !== 0x5c) {
        // a new sequence before the terminator: the string was broken; drop it and decode from here
        return { next: j };
      }
    }
    return final ? { next: b.length } : null;
  }

  private ss3(b: Buffer, i: number, final: boolean, _alt: boolean): { next: number; input?: Input } | null {
    let j = i + 2;
    while (j < b.length && b[j]! >= 0x30 && b[j]! <= 0x39) j++;
    if (j >= b.length) return final ? { next: b.length } : null;
    const f = String.fromCharCode(b[j]!);
    const digits = b.subarray(i + 2, j).toString("latin1");
    const m = digits ? mods(Number(digits)) : NONE;
    const next = j + 1;
    const name = LETTER[f];
    if (name) return { next, input: key(name, m) };
    // rxvt: Ctrl + arrows
    const rxvt: Record<string, string> = { a: "up", b: "down", c: "right", d: "left" };
    if (rxvt[f]) return { next, input: key(rxvt[f]!, { ...m, ctrl: true }) };
    // keypad in application mode
    if (f === "M") return { next, input: key("enter", m) };
    const kp: Record<string, string> = { j: "*", k: "+", l: ",", m: "-", n: ".", o: "/", p: "0", q: "1", r: "2", s: "3", t: "4", u: "5", v: "6", w: "7", x: "8", y: "9", X: "=" };
    if (kp[f]) return { next, input: printable(kp[f]!, m) };
    return { next };
  }

  private csi(b: Buffer, i: number, start: number, final: boolean, _alt: boolean): { next: number; input?: Input } | null {
    // Linux console function keys: ESC [ [ A..E
    if (start < b.length && b[start] === 0x5b) {
      if (start + 1 >= b.length) return final ? { next: b.length } : null;
      const f = b[start + 1]!;
      if (f >= 0x41 && f <= 0x45) return { next: start + 2, input: key(`f${f - 0x40}`) };
      return { next: start + 2 };
    }
    // X10 mouse: ESC [ M b x y (three raw bytes): dropped
    if (start < b.length && b[start] === 0x4d) {
      if (start + 4 > b.length) return final ? { next: b.length } : null;
      return { next: start + 4 };
    }
    let j = start;
    while (j < b.length) {
      const c = b[j]!;
      if (c >= 0x40 && c <= 0x7e) break;
      if (c < 0x20 || c > 0x7e) return { next: j }; // not a CSI after all: drop the prefix, resync on this byte
      if (j - start > MAX_CSI) return { next: j };
      j++;
    }
    if (j >= b.length) return final ? { next: b.length } : null;
    const next = j + 1;
    const raw = b.subarray(start, j).toString("latin1");
    const fin = String.fromCharCode(b[j]!);
    return { next, input: this.csiInput(raw, fin) };
  }

  private csiInput(raw: string, fin: string): Input | undefined {
    const priv = /^[<>?=]/.test(raw) ? raw[0]! : "";
    let body = priv ? raw.slice(1) : raw;
    let inter = "";
    const im = /[\x20-\x2f]+$/.exec(body);
    if (im) {
      inter = im[0];
      body = body.slice(0, -inter.length);
    }
    if (!PARAM.test(body)) return undefined;
    const params = body === "" ? [] : body.split(";");
    const num = (k: number) => {
      const v = params[k]?.split(":")[0];
      return v === undefined || v === "" ? undefined : Number(v);
    };

    // Replies to queries
    if (priv === "?" && fin === "c") {
      this.onReply({ kind: "da1", params: body });
      return undefined;
    }
    if (priv === ">" && fin === "c") {
      this.onReply({ kind: "da2", params: body });
      return undefined;
    }
    if (priv === "?" && fin === "u") {
      this.onReply({ kind: "kitty-flags", flags: num(0) ?? 0 });
      return undefined;
    }
    if (inter === "$" && fin === "y") {
      this.onReply({ kind: "mode", mode: num(0) ?? 0, value: num(1) ?? 0 });
      return undefined;
    }
    if (fin === "t" && !priv) {
      this.onReply({ kind: "window", params: body });
      return undefined;
    }

    // Mouse (SGR): only the vertical wheel is an input.
    if (priv === "<" && (fin === "M" || fin === "m")) {
      const btn = num(0) ?? 0;
      const x = (num(1) ?? 1) - 1;
      const y = (num(2) ?? 1) - 1;
      if (fin === "M" && (btn & 64) && !(btn & 32) && (btn & 3) < 2) {
        return { type: "wheel", direction: (btn & 3) === 0 ? "up" : "down", x: Math.max(0, x), y: Math.max(0, y) };
      }
      return undefined;
    }
    if (priv || inter) return undefined;

    if (fin === "I" && params.length === 0) return { type: "focus", focused: true };
    if (fin === "O" && params.length === 0) return { type: "focus", focused: false };

    // Cursor position report: ESC [ row ; col R. ESC [ 1 ; mod R is Shift/Ctrl/Alt+F3 in xterm's legacy encoding.
    if (fin === "R" && params.length === 2 && !(num(0) === 1 && (num(1) ?? 0) >= 2 && (num(1) ?? 0) <= 16)) {
      this.onReply({ kind: "cursor", row: num(0) ?? 0, col: num(1) ?? 0 });
      return undefined;
    }

    if (fin === "u") {
      // CSI code[:shifted[:base]] ; mods[:event] ; text u
      const parts = (params[0] ?? "").split(":");
      const code = Number(parts[0]);
      if (!Number.isFinite(code) || parts[0] === "") return undefined;
      const modParts = (params[1] ?? "1").split(":");
      const event = Number(modParts[1] ?? "1");
      if (event === 3) return undefined; // key release
      const m = mods(Number(modParts[0] || "1"));
      const shifted = parts[1] ? Number(parts[1]) : undefined;
      return fromCodePoint(code, m, shifted) ?? undefined;
    }

    if (fin === "~") {
      const n = num(0);
      if (n === 27 && params.length >= 3) {
        // modifyOtherKeys: CSI 27 ; mods ; code ~
        return fromCodePoint(num(2) ?? 0, mods(num(1))) ?? undefined;
      }
      if (n === 200 || n === 201) return undefined; // handled by the caller (200) or stray (201)
      const name = n === undefined ? undefined : TILDE[n];
      if (!name) return undefined;
      return key(name, mods(num(1)));
    }

    if (fin === "Z") return key("tab", { ...mods(num(1)), shift: true });

    // rxvt: Shift + arrows as lower-case finals
    const rxvt: Record<string, string> = { a: "up", b: "down", c: "right", d: "left" };
    if (rxvt[fin] && params.length === 0) return key(rxvt[fin]!, { ctrl: false, alt: false, shift: true });

    const name = LETTER[fin];
    if (name) {
      // CSI 1;mods X, or CSI mods X (some terminals drop the 1)
      const m = params.length >= 2 ? mods(num(1)) : NONE;
      return key(name, m);
    }
    return undefined;
  }
}
