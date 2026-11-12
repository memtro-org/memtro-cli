import type { Answer, Decision, PendingCall, SessionRule } from "../../../agent/types.js";
import { ApprovalKeys, describeRule, HOLD_MS, TYPING_GAP_MS, type KeyChoice } from "../../approval.js";
import { whyText } from "../../render.js";
import { visible } from "../../sanitise.js";
import { renderDiff } from "../../md/index.js";
import type { Frame, Input, Line, Rect } from "../types.js";
import { clean, displayWidth, fg, span, wrapLine } from "./text.js";

/**
 * The approval panel: docked above the input, a warning-coloured bar, everything the decision rests on (the
 * command in full, the diff, the real target of a linked path, the reason and who gave it), and the choices.
 *
 * Deciding whether a key may answer is the shared `ApprovalKeys` (in `tui/approval.ts`, `KeyGate` plus the typing
 * gap and the hold), the same rules the inline prompt uses; this adds only what a full-screen reader needs around
 * them: they start when the panel has been drawn (not when it was asked for), nothing but a single key is ever fed
 * to the gate (pastes, wheel, focus, resize and scrolling keys only cancel a held answer and restart the typing
 * gap), and the screen's own measure of the quiet before an input (0 inside a chunk of several) counts too.
 */

export { HOLD_MS, TYPING_GAP_MS };

export interface ApprovalState {
  call: PendingCall;
  decision: Decision;
  suggested: SessionRule | null;
  classifierOn: boolean;
  /** Lines of the body scrolled off the top. */
  scroll: number;
  /** The note being typed after `e`, or null when the choices are shown. */
  note: string | null;
  /**
   * The body's last line has been on screen. Until it has, `y` and `a` allow nothing: a command or diff longer than
   * the panel cannot be approved on its first screenful, with the part that matters still below.
   */
  endSeen?: boolean;
}

export type ApprovalOutcome = { kind: "none" } | { kind: "answer"; answer: Answer; interrupt: boolean };

/** The body: everything between "Allow this?" and the choices, wrapped to `width`, never cut. Pure. */
export function approvalBody(a: ApprovalState, width: number): Line[] {
  const w = Math.max(10, width);
  const s = a.call.summary;
  const out: Line[] = [];
  for (const l of wrapLine([span(clean(s.title), fg("text", { bold: true }))], w)) out.push(l);
  if (s.command !== undefined) {
    visible(s.command)
      .split("\n")
      .forEach((line, i) => {
        const prefix = i === 0 ? "$ " : "> ";
        for (const l of wrapLine([span(prefix, fg("muted")), span(line, fg("text"))], w, { indent: 2, hardBreak: true })) out.push(l);
      });
  }
  if (s.diff) for (const l of renderDiff(s.diff, { width: w })) out.push(l);
  // One file through a symlink comes as [real, typed]: always say where it really goes.
  const linked = s.paths?.length === 2 && s.paths[0] !== s.paths[1];
  if (linked) {
    const line = [span("path ", fg("muted")), span(visible(s.paths![1]!).replace(/\n/g, "␊")), span(` (really ${visible(s.paths![0]!).replace(/\n/g, "␊")})`, fg("warning", { bold: true }))];
    for (const l of wrapLine(line, w, { indent: 5, hardBreak: true })) out.push(l);
  } else if (s.paths?.length && s.command === undefined && !s.diff) {
    for (const p of s.paths) for (const l of wrapLine([span("path ", fg("muted")), span(visible(p).replace(/\n/g, "␊"))], w, { indent: 5, hardBreak: true })) out.push(l);
  }
  if (s.command === undefined && !s.diff && !s.paths?.length) {
    const args = JSON.stringify(a.call.args);
    const shown = args.length > 2000 ? `${args.slice(0, 2000)}… (${args.length - 2000} more characters)` : args;
    for (const l of wrapLine([span("tool ", fg("muted")), span(clean(visible(a.call.tool))), span(` ${clean(visible(shown))}`, fg("muted"))], w, { indent: 5, hardBreak: true })) out.push(l);
  }
  const why = whyText(a.decision, a.classifierOn);
  for (const l of wrapLine([span("why ", fg("muted")), span(why, fg(a.decision.source === "rule" ? "warning" : "text", { bold: a.decision.source === "rule" }))], w, { indent: 4 })) out.push(l);
  return out;
}

/** The choices (or the note being typed), wrapped so the session rule is never cut. Pure. */
export function approvalChoices(a: ApprovalState, width: number): Line[] {
  if (a.note !== null) {
    return [
      ...wrapLine([span("Note for the model: ", fg("warning", { bold: true })), span(clean(a.note), fg("text"))], width, { hardBreak: true }),
      [span("enter", fg("text", { bold: true })), span(" deny with this note  ", fg("muted")), span("esc", fg("text", { bold: true })), span(" back to the choices", fg("muted"))],
    ];
  }
  const parts: Line[] = [[span("y", fg("text", { bold: true })), span(" allow once", fg("muted"))]];
  if (a.suggested) parts.push([span("a", fg("text", { bold: true })), span(` allow ${ruleWords(a)}`, fg("muted"))]);
  parts.push([span("n", fg("text", { bold: true })), span(" deny", fg("muted"))], [span("e", fg("text", { bold: true })), span(" deny with a note", fg("muted"))]);
  // As many choices to a row as fit; a choice longer than the row wraps on its own.
  const rows: Line[] = [];
  let row: Line = [];
  let used = 0;
  for (const p of parts) {
    const pw = p.reduce((n, s) => n + displayWidth(s.text), 0);
    if (used && used + 3 + pw > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    if (used) {
      row.push(span("   "));
      used += 3;
    }
    if (pw > width) {
      if (row.length) rows.push(row);
      rows.push(...wrapLine(p, width, { indent: 2 }));
      row = [];
      used = 0;
      continue;
    }
    row.push(...p);
    used += pw;
  }
  if (row.length) rows.push(row);
  return rows;
}

/** Longer than this (or more than one line), "exactly this command" points at the command shown in full above it. */
export const RULE_COMMAND_INLINE = 60;

/**
 * What `a` would allow, exactly. A rule for exactly this command, when the command is long, says "the command
 * above" rather than repeating it: the whole command is already in the panel, and a second copy of a long one would
 * push the command itself out of view.
 */
export function ruleWords(a: ApprovalState): string {
  const r = a.suggested!;
  if (r.kind === "command" && r.command === a.call.summary.command) {
    const shown = visible(r.command);
    if (shown.includes("\n") || shown.length > RULE_COMMAND_INLINE) return "exactly the command above, for this session";
  }
  return describeRule(r);
}

export interface ApprovalGeometry {
  rect: Rect;
  innerX: number;
  innerWidth: number;
  bodyY: number;
  bodyHeight: number;
  body: Line[];
  choices: Line[];
}

/** The panel's place: its bottom just above `inputTop`, as tall as it needs up to `maxHeight`. */
export function approvalGeometry(a: ApprovalState, x: number, width: number, inputTop: number, maxHeight: number): ApprovalGeometry {
  const innerX = x + 3;
  const innerWidth = Math.max(10, width - 5);
  const body = approvalBody(a, innerWidth);
  const choices = approvalChoices(a, innerWidth);
  // pad, "Allow this?", body…, blank, choices…, pad
  const fixed = 1 + 1 + 1 + choices.length + 1;
  const bodyHeight = Math.max(1, Math.min(body.length, maxHeight - fixed));
  const height = fixed + bodyHeight;
  const y = Math.max(0, inputTop - height);
  return { rect: { x, y, width, height }, innerX, innerWidth, bodyY: y + 2, bodyHeight, body, choices };
}

export function clampScroll(a: ApprovalState, g: Pick<ApprovalGeometry, "body" | "bodyHeight">): number {
  return Math.max(0, Math.min(a.scroll, g.body.length - g.bodyHeight));
}

export function drawApproval(a: ApprovalState, frame: Frame, g: ApprovalGeometry): void {
  const r = g.rect;
  frame.fill(r, "panel");
  for (let i = 0; i < r.height; i++) frame.text(r.x, r.y + i, [span("┃", fg("warning", { bg: "panel" }))], 1);
  frame.text(g.innerX, r.y + 1, [span("Allow this?", fg("warning", { bold: true, bg: "panel" }))], g.innerWidth);
  const scroll = clampScroll(a, g);
  const above = scroll > 0;
  const below = scroll + g.bodyHeight < g.body.length;
  if (above || below) {
    const text = [above ? "↑ more above" : "", below ? (a.endSeen ? "↓ more below" : "↓ more below: read to the end to allow") : ""].filter(Boolean).join("  ");
    const tw = displayWidth(text);
    frame.text(g.innerX + g.innerWidth - tw, r.y + 1, [span(text, fg("muted", { bg: "panel" }))], tw);
  }
  for (let i = 0; i < g.bodyHeight; i++) {
    const l = g.body[scroll + i];
    if (l) frame.text(g.innerX, g.bodyY + i, l, g.innerWidth);
  }
  const cy = g.bodyY + g.bodyHeight + 1;
  g.choices.forEach((l, i) => frame.text(g.innerX, cy + i, l, g.innerWidth));
  if (a.note !== null) {
    const last = g.choices.length - 2;
    const lw = g.choices[last] ? g.choices[last]!.reduce((n, s) => n + displayWidth(s.text), 0) : 0;
    frame.cursor = { x: Math.min(g.innerX + lw, g.innerX + g.innerWidth - 1), y: cy + Math.max(0, last) };
  } else frame.cursor = null;
}

const SCROLL_KEYS = new Set(["up", "down", "pageup", "pagedown", "home", "end"]);

/**
 * The panel's keys. Holds the shared `ApprovalKeys` (created when the panel is first drawn), which holds any held answer. Time comes
 * from the caller, so the rules are tested with a clock of the test's choosing.
 */
export class ApprovalPanel {
  state: ApprovalState;
  private keys: ApprovalKeys | null = null;

  constructor(call: PendingCall, decision: Decision, suggested: SessionRule | null, classifierOn: boolean) {
    this.state = { call, decision, suggested, classifierOn, scroll: 0, note: null };
  }

  /** The panel is on screen as of `at`: the settle time runs from here. Only the first call counts. */
  drawn(at: number): void {
    this.keys ??= new ApprovalKeys(at, this.state.suggested !== null);
  }

  get isDrawn(): boolean {
    return this.keys !== null;
  }

  /** An answer held for `HOLD_MS`, if nothing else arrived since. */
  commit(at: number): ApprovalOutcome {
    const c = this.keys?.commit(at) ?? null;
    return c ? this.choose(c) : { kind: "none" };
  }

  /** Whether an answer is being held (the caller schedules `commit`). */
  get holding(): boolean {
    return this.keys?.holding ?? false;
  }

  /**
   * One decoded input at time `at`. `gap` is the screen's `sinceInput()` as it arrived: the quiet before the chunk
   * it came in, and 0 when several inputs came in one chunk. `bodyHeight` is how many body lines are on screen (for
   * paging); `shown` is false when the screen cannot show the whole panel. Returns an answer only for Escape,
   * Ctrl-C and a note sent with Enter; a deliberate single key is held
   * (see `commit`).
   */
  input(input: Input, at: number, gap: number, bodyHeight: number, bodyLines: number, shown = true): ApprovalOutcome {
    const st = this.state;
    const keyInput = input.type === "key" ? input : null;
    const scrolling = keyInput !== null && SCROLL_KEYS.has(keyInput.name) && !keyInput.ctrl && !keyInput.alt;
    const chunk = keyInput && st.note === null && !scrolling ? chunkOf(keyInput) : null;
    // Anything that is not a key the gate judges still cancels an answer being held and restarts the typing gap.
    if (chunk === null) this.keys?.other(at);

    if (input.type === "paste") {
      if (st.note !== null) this.state = { ...st, note: st.note + clean(input.text) };
      return { kind: "none" };
    }
    if (input.type === "wheel") {
      this.scroll(input.direction === "up" ? -3 : 3, bodyHeight, bodyLines);
      return { kind: "none" };
    }
    if (input.type !== "key") return { kind: "none" };

    if (st.note !== null) return this.noteKey(input);

    if (scrolling) {
      const page = Math.max(1, bodyHeight - 1);
      const delta = input.name === "up" ? -1 : input.name === "down" ? 1 : input.name === "pageup" ? -page : input.name === "pagedown" ? page : input.name === "home" ? -bodyLines : bodyLines;
      this.scroll(delta, bodyHeight, bodyLines);
      return { kind: "none" };
    }

    if (chunk === null) return { kind: "none" };
    // Allowing needs the whole body to have been shown: what fits now, or the end scrolled to at some point.
    if (!this.state.endSeen && st.scroll + bodyHeight >= bodyLines) this.state = { ...this.state, endSeen: true };
    // Nor can a panel the screen is too small to show whole allow anything; refusing still works.
    if ((!this.state.endSeen || !shown) && /^[yYaA]$/.test(chunk)) {
      this.keys?.other(at);
      return { kind: "none" };
    }
    // Refusing is always safe: Escape and Ctrl-C are honoured even before the panel has settled.
    if (!this.keys) {
      if (chunk === "\u001b") return this.choose("deny");
      if (chunk === "\u0003") return this.choose("interrupt");
      return { kind: "none" };
    }
    const step = this.keys.feed(chunk, at, gap);
    return step.kind === "now" ? this.choose(step.choice) : { kind: "none" };
  }

  /** The turn was interrupted while the panel was open. */
  aborted(): ApprovalOutcome {
    this.keys?.cancel();
    return { kind: "answer", answer: { kind: "deny", note: "The person interrupted the turn." }, interrupt: false };
  }

  private choose(choice: KeyChoice): ApprovalOutcome {
    switch (choice) {
      case "once":
        return { kind: "answer", answer: { kind: "once" }, interrupt: false };
      case "session":
        return this.state.suggested ? { kind: "answer", answer: { kind: "session", rule: this.state.suggested }, interrupt: false } : { kind: "none" };
      case "deny":
        return { kind: "answer", answer: { kind: "deny" }, interrupt: false };
      case "interrupt":
        return { kind: "answer", answer: { kind: "deny", note: "The person interrupted instead of answering." }, interrupt: true };
      case "note":
        this.state = { ...this.state, note: "" };
        return { kind: "none" };
    }
  }

  private noteKey(k: Extract<Input, { type: "key" }>): ApprovalOutcome {
    const note = this.state.note ?? "";
    if (k.ctrl && k.name === "c") return this.choose("interrupt");
    if (k.name === "escape") {
      this.state = { ...this.state, note: null };
      return { kind: "none" };
    }
    if (k.name === "enter" || k.name === "return") {
      const t = note.trim();
      return { kind: "answer", answer: t ? { kind: "deny", note: `The person's note: ${t}` } : { kind: "deny" }, interrupt: false };
    }
    if (k.name === "backspace") this.state = { ...this.state, note: Array.from(note).slice(0, -1).join("") };
    else if (k.ctrl && k.name === "u") this.state = { ...this.state, note: "" };
    else if (k.text && !k.ctrl && !k.alt) this.state = { ...this.state, note: note + clean(k.text) };
    return { kind: "none" };
  }

  private scroll(delta: number, bodyHeight: number, bodyLines: number): void {
    const max = Math.max(0, bodyLines - bodyHeight);
    const scroll = Math.max(0, Math.min(max, this.state.scroll + delta));
    this.state = { ...this.state, scroll, ...(scroll + bodyHeight >= bodyLines ? { endSeen: true } : {}) };
  }
}

/** The raw text a key stands for, as `KeyGate` has always been fed: one character, Escape or Ctrl-C. */
function chunkOf(k: Extract<Input, { type: "key" }>): string | null {
  if (k.name === "escape" && !k.ctrl) return "\u001b";
  if (k.ctrl && k.name === "c") return "\u0003";
  if (k.ctrl || k.alt) return null;
  if (k.name === "enter" || k.name === "return") return "\r";
  if (k.name === "tab") return "\t";
  if (k.text !== undefined) return k.text;
  if (k.name === "space") return " ";
  return null;
}

