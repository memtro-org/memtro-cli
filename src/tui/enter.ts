import type { Input } from "./full/types.js";

/**
 * When Enter sends, and when it is part of a paste.
 *
 * A terminal that marks pastes (bracketed paste) says which bytes were pasted, and a newline inside the marks never
 * sends. A terminal that does not (or a program typing into one) delivers a pasted block as a burst of bytes, and
 * without a rule each newline in it would send the message, or run a slash command, or choose a dialog's row, or
 * send an approval note. The rule, the same in the full-screen and the inline interface:
 *
 * - An Enter that arrives in the same read chunk as printable input (before it or after it), or together with
 *   another Enter, is part of a burst: it inserts a newline instead of sending.
 * - So is an Enter arriving less than `PASTE_ENTER_MS` after printable input or after an Enter judged part of a
 *   burst (a long paste reaches the program as several chunks moments apart).
 * - Any other Enter (a key pressed on its own) sends, exactly as before.
 *
 * The cost: a fast typist over a slow link, whose "ls" and Enter the network coalesced into one chunk, gets a new
 * line instead of a sent message. Enter again (on its own) sends it; the trailing newline is dropped.
 *
 * Pure over (events, time): the caller owns the clock. Shift+Enter, Alt+Enter and Ctrl+Enter are already newlines
 * and are left alone; the kitty keyboard protocol's and modifyOtherKeys' plain Enter decode to the same Enter and are
 * judged the same.
 */

/**
 * The window after printable input in which a lone Enter is still part of the burst. The same 30 ms as the approval
 * prompt's burst rule (`BURST_MS` in approval.ts): a pasted block arrives in one chunk, or in chunks well under a
 * millisecond apart locally and a few milliseconds apart over a network, while a person's Enter after the last key
 * of a word comes far later than 30 ms (the occasional rollover, two keys pressed almost together, is the cost
 * described above).
 */
export const PASTE_ENTER_MS = 30;

/** What one decoded event is, to this rule. */
export type Arrival = "text" | "enter" | "other";

export class EnterRule {
  private lastTextAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly windowMs = PASTE_ENTER_MS) {}

  /**
   * One read chunk's events in order, arriving at `at`. Returns, for each `enter` among them in order, whether it
   * sends (true) or is a newline (false).
   */
  judge(events: readonly Arrival[], at: number): boolean[] {
    let enters = 0;
    let text = false;
    for (const e of events) {
      if (e === "enter") enters++;
      else if (e === "text") text = true;
    }
    if (enters === 0) {
      if (text) this.lastTextAt = at;
      return [];
    }
    const burst = text || enters > 1 || at - this.lastTextAt < this.windowMs;
    if (burst) this.lastTextAt = at;
    return new Array<boolean>(enters).fill(!burst);
  }
}

/** A plain Enter: what sends. */
function isPlainEnter(i: Input): boolean {
  return i.type === "key" && i.name === "enter" && !i.ctrl && !i.alt && !i.shift;
}

/** The full-screen decoder's events as the rule sees them. A paste, a typed character, Tab and Ctrl-J (a raw LF) are text. */
export function arrivalOf(i: Input): Arrival {
  if (isPlainEnter(i)) return "enter";
  if (i.type === "paste") return "text";
  if (i.type !== "key") return "other";
  if (i.text !== undefined && !i.ctrl && !i.alt) return "text";
  if (i.name === "tab" && !i.ctrl && !i.alt) return "text";
  if (isRawLf(i)) return "text";
  return "other";
}

/** Ctrl-J: what the decoder makes of a raw LF byte. */
function isRawLf(i: Input | undefined): boolean {
  return i !== undefined && i.type === "key" && i.name === "j" && i.ctrl && !i.alt && !i.shift;
}

/** The newline an Enter in a burst becomes: Ctrl-J, which the editor already reads as a newline and nothing else reads as sending. */
export const BURST_NEWLINE: Input = { type: "key", name: "j", ctrl: true, alt: false, shift: false };

/**
 * One chunk's decoded inputs with every Enter that is part of a burst turned into a newline. CR LF (an Enter the
 * decoder reads as Enter then Ctrl-J) is one line end: judged as one Enter, and it becomes one newline or one Enter.
 */
export function applyEnterRule(rule: EnterRule, inputs: readonly Input[], at: number): Input[] {
  const arrivals: Arrival[] = [];
  const pairedLf = new Set<number>();
  inputs.forEach((i, n) => {
    if (isRawLf(i) && n > 0 && isPlainEnter(inputs[n - 1]!)) {
      pairedLf.add(n);
      return;
    }
    arrivals.push(arrivalOf(i));
  });
  const verdicts = rule.judge(arrivals, at);
  const out: Input[] = [];
  let v = 0;
  inputs.forEach((i, n) => {
    if (pairedLf.has(n)) return; // its Enter stands for both
    if (isPlainEnter(i)) out.push(verdicts[v++] ? i : BURST_NEWLINE);
    else out.push(i);
  });
  return out;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * Raw chunks to arrivals for the inline prompt (`node:readline`), counting line ends the way readline does: CR LF is
 * one, a lone CR or LF is one. Text between paste marks is text and its newlines are not Enters (the prompt already
 * keeps them); the marks may be split across chunks, so this keeps whether a paste is open. Escape sequences are
 * other input.
 */
export class ChunkArrivals {
  private pasting = false;
  /** Whether the last chunk held any pasted text or paste mark: a line end readline reports from it is pasted. */
  touchedPaste = false;

  of(chunk: string): Arrival[] {
    const out: Arrival[] = [];
    let i = 0;
    const n = chunk.length;
    this.touchedPaste = this.pasting;
    while (i < n) {
      if (this.pasting) {
        this.touchedPaste = true;
        const end = chunk.indexOf(PASTE_END, i);
        if (end > i || (end < 0 && i < n)) out.push("text");
        if (end < 0) return out;
        this.pasting = false;
        i = end + PASTE_END.length;
        continue;
      }
      if (chunk.startsWith(PASTE_START, i)) {
        this.pasting = true;
        this.touchedPaste = true;
        i += PASTE_START.length;
        continue;
      }
      const c = chunk.charCodeAt(i);
      if (c === 0x0d) {
        out.push("enter");
        i += chunk.charCodeAt(i + 1) === 0x0a ? 2 : 1;
        continue;
      }
      if (c === 0x0a) {
        out.push("enter");
        i++;
        continue;
      }
      if (c === 0x1b) {
        out.push("other");
        i = skipEscape(chunk, i);
        continue;
      }
      if (c === 0x09) out.push("text");
      else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) out.push("other");
      else out.push("text");
      i++;
    }
    return out;
  }
}

/** Where the escape sequence at `i` ends: CSI to its final byte, SS3 and Alt+key two or three characters. */
function skipEscape(s: string, i: number): number {
  const next = s.charCodeAt(i + 1);
  if (next === 0x5b) {
    let j = i + 2;
    while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
    return Math.min(s.length, j + 1);
  }
  if (next === 0x4f) return Math.min(s.length, i + 3);
  return Math.min(s.length, i + (Number.isNaN(next) ? 1 : 2));
}
