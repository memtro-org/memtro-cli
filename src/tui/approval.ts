import { isAbsolute, relative } from "node:path";
import type { Answer, Approver, Decision, PendingCall, SessionRule } from "../agent/types.js";
import { KeyRouter, PASTE_END, PASTE_START } from "./keys.js";
import { colourDiff, whyText } from "./render.js";
import { oneLine, visible } from "./sanitise.js";
import type { Style } from "./style.js";

/**
 * Asking the person whether a tool call may run.
 *
 * The prompt shows everything the decision rests on: the command in full (never cut, every control character made
 * visible, so a command cannot hide part of itself or redraw the prompt), the diff, the gate's reason and who gave
 * it. One key answers. Enter is not yes, nothing pasted answers, and nothing typed before the prompt appeared
 * answers it: consent is a key pressed on purpose, after reading.
 */

export const APPROVAL_DIFF_LINES = 60;
/** Keys arriving this soon after the prompt is drawn were typed before it was there to read. */
export const SETTLE_MS = 150;
/** A chunk this soon after the previous one is part of a burst (a paste, a held key), not a decision. */
export const BURST_MS = 30;

/** What "allow for this session" would cover, said exactly. */
export function describeRule(rule: SessionRule): string {
  switch (rule.kind) {
    case "command":
      return `exactly \`${oneLine(visible(rule.command))}\` for this session`;
    case "command-prefix":
      return `any \`${oneLine(visible(rule.words.join(" ")))} …\` for this session`;
    case "write-under":
      return `any file created, written or edited under ${oneLine(visible(rule.dir))} for this session`;
    case "tool":
      return `any call of ${oneLine(visible(rule.tool))} for this session`;
  }
}

/** The prompt, as text. Pure, so what a person is shown is tested rather than described. */
export function formatApproval(call: PendingCall, decision: Decision, suggested: SessionRule | null, o: { style: Style; classifierOn: boolean; diffLines?: number }): string {
  const st = o.style;
  const s = call.summary;
  const lines: string[] = ["", st.yellow(st.bold("Allow this?")), `  ${st.bold(oneLine(s.title))}`];
  if (s.command !== undefined) {
    const cmd = visible(s.command).split("\n");
    cmd.forEach((line, i) => lines.push(`  ${st.dim(i === 0 ? "$" : ">")} ${line}`));
  }
  if (s.diff) lines.push(...colourDiff(s.diff, st, o.diffLines ?? APPROVAL_DIFF_LINES).split("\n").map((l) => `    ${l}`));
  // One file through a symlink comes as [real, typed]: always say where it really goes, even under a diff whose
  // header names the typed path, so a link cannot pass off a write elsewhere as a local edit.
  const linked = s.paths?.length === 2 && s.paths[0] !== s.paths[1];
  if (linked) lines.push(`  ${st.dim("path")} ${visible(s.paths![1]!)} ${st.yellow(`(really ${visible(s.paths![0]!)})`)}`);
  else if (s.paths?.length && s.command === undefined && !s.diff) for (const p of s.paths) lines.push(`  ${st.dim("path")} ${visible(p)}`);
  if (s.command === undefined && !s.diff && !s.paths?.length) {
    const args = JSON.stringify(call.args);
    lines.push(`  ${st.dim("tool")} ${visible(call.tool)} ${st.dim(visible(args.length > 2000 ? `${args.slice(0, 2000)}… (${args.length - 2000} more characters)` : args))}`);
  }
  const why = whyText(decision, o.classifierOn);
  // An always-ask rule is the one reason a person must not skim past.
  lines.push(`  ${st.dim("why")}  ${decision.source === "rule" ? st.yellow(st.bold(why)) : why}`);
  const choices = [`${st.bold("y")} yes, once`];
  if (suggested) choices.push(`${st.bold("a")} yes to ${describeRule(suggested)}`);
  choices.push(`${st.bold("n")} no`, `${st.bold("e")} no, and say what to do instead`);
  lines.push(`  ${choices.join(st.dim("  ·  "))}`);
  return `${lines.join("\n")}\n`;
}

export type KeyChoice = "once" | "session" | "deny" | "note" | "interrupt";

/**
 * Which raw input counts as an answer. Pure over (chunk, time): pasted text, bursts, more than one key at once,
 * and anything in the first moments after the prompt appeared are ignored. Ctrl-C and Esc are always honoured,
 * because refusing is always safe.
 */
export class KeyGate {
  private pasting = false;
  private lastAt: number;

  constructor(
    private readonly shownAt: number,
    private readonly allowSession: boolean,
  ) {
    this.lastAt = shownAt;
  }

  feed(chunk: string, at: number): KeyChoice | null {
    const quiet = at - this.lastAt;
    this.lastAt = at;
    if (chunk.includes(PASTE_START)) this.pasting = !chunk.includes(PASTE_END);
    else if (this.pasting) {
      if (chunk.includes(PASTE_END)) this.pasting = false;
      return null;
    }
    if (chunk.includes(PASTE_START) || chunk.includes(PASTE_END)) return null;
    if (chunk === "\u0003") return "interrupt";
    if (chunk === "\u001b") return "deny";
    if (at - this.shownAt < SETTLE_MS) return null;
    if (quiet < BURST_MS) return null;
    if (Array.from(chunk).length !== 1) return null;
    switch (chunk) {
      case "y":
      case "Y":
        return "once";
      case "a":
      case "A":
        return this.allowSession ? "session" : null;
      case "n":
      case "N":
        return "deny";
      case "e":
      case "E":
        return "note";
      default:
        return null;
    }
  }
}

/** A key this soon after the input before it is typing, not a decision: it answers nothing. */
export const TYPING_GAP_MS = 300;
/** An answering key is held this long, and anything arriving meanwhile cancels it. */
export const HOLD_MS = 120;

export type KeyStep = { kind: "now"; choice: KeyChoice } | { kind: "held" } | { kind: "none" };

/**
 * The approval timing rules both interfaces use, on top of `KeyGate` (never instead of it). Typing is not a
 * decision: a key less than `TYPING_GAP_MS` after any input before it (the end of a word a person had not finished
 * typing when the prompt appeared, "today" ending in a y) answers nothing, and an answering key is held for `HOLD_MS`
 * and cancelled by any input in that time, so a key that turns out to be the first of a burst answers nothing.
 * Escape and Ctrl-C refuse at once, because refusing is always safe. Pure over time: the caller owns the clock and
 * the timer that calls `commit` (or `release`).
 */
export class ApprovalKeys {
  private readonly gate: KeyGate;
  private lastInputAt: number;
  private held: { choice: KeyChoice; at: number } | null = null;

  /** `lastInputAt`: when the input before the prompt arrived, if the caller saw any (typing carried over). */
  constructor(shownAt: number, allowSession: boolean, lastInputAt = Number.NEGATIVE_INFINITY) {
    this.gate = new KeyGate(shownAt, allowSession);
    this.lastInputAt = lastInputAt;
  }

  /** Input the gate is not fed (a decoded paste, the wheel, focus, a resize, a scrolling key): it cancels a held answer and starts the typing gap again. */
  other(at: number): void {
    this.held = null;
    this.lastInputAt = Math.max(this.lastInputAt, at);
  }

  /**
   * One raw chunk at `at`. `gap`, when the caller knows better (input it decoded but did not pass here, several
   * inputs in one chunk), is the quiet before this one; the shorter of the two counts.
   */
  feed(chunk: string, at: number, gap = Number.POSITIVE_INFINITY): KeyStep {
    const quiet = Math.min(at - this.lastInputAt, gap);
    this.held = null;
    this.lastInputAt = Math.max(this.lastInputAt, at);
    const choice = this.gate.feed(chunk, at);
    if (!choice) return { kind: "none" };
    if (choice === "interrupt" || (choice === "deny" && chunk === "\u001b")) return { kind: "now", choice };
    if (quiet < Math.max(BURST_MS, TYPING_GAP_MS)) return { kind: "none" };
    this.held = { choice, at };
    return { kind: "held" };
  }

  get holding(): boolean {
    return this.held !== null;
  }

  /** The held answer, once `HOLD_MS` has passed with nothing else arriving; null before then or if none. */
  commit(at: number): KeyChoice | null {
    const h = this.held;
    if (!h || at - h.at < HOLD_MS) return null;
    this.held = null;
    return h.choice;
  }

  /** Drops any held answer (the prompt closed some other way). */
  cancel(): void {
    this.held = null;
  }
}

export interface TtyApproverDeps {
  output: NodeJS.WritableStream;
  router: KeyRouter;
  style: Style;
  classifierOn: () => boolean;
  /** Reads one line of text in cooked mode, for `e`. */
  readNote: (prompt: string) => Promise<string>;
  /** Stop the spinner and anything else drawing, before the prompt is drawn. */
  beforePrompt?: () => void;
  afterPrompt?: () => void;
  /** Ctrl-C at the prompt: the call is refused, and this stops the turn. */
  onInterrupt?: () => void;
  /** The running turn's signal: when it is aborted (Esc, Ctrl-C, elsewhere) an open prompt closes itself as a refusal. */
  signal?: () => AbortSignal | null;
  now?: () => number;
}

export function createTtyApprover(d: TtyApproverDeps): Approver {
  const now = d.now ?? Date.now;
  return {
    async ask(call, decision, suggested): Promise<Answer> {
      d.beforePrompt?.();
      d.output.write(formatApproval(call, decision, suggested, { style: d.style, classifierOn: d.classifierOn() }));
      const wasAttached = d.router.isAttached;
      d.router.attach();
      const signal = d.signal?.() ?? null;
      const choice = await new Promise<KeyChoice | "aborted">((resolve) => {
        // Typing that began before the prompt appeared counts: the router saw it, on its way to the running turn.
        const keys = new ApprovalKeys(now(), suggested !== null, d.router.lastInputAt ?? undefined);
        let timer: ReturnType<typeof setTimeout> | null = null;
        const stopTimer = () => {
          if (timer) clearTimeout(timer);
          timer = null;
        };
        const finish = (c: KeyChoice | "aborted") => {
          stopTimer();
          keys.cancel();
          pop();
          signal?.removeEventListener("abort", onAbort);
          resolve(c);
        };
        const onAbort = () => finish("aborted");
        const pop = d.router.push((chunk, at) => {
          stopTimer();
          const step = keys.feed(chunk, at);
          if (step.kind === "now") return finish(step.choice);
          if (step.kind !== "held") return;
          // Held: it answers only if nothing else arrives first (any chunk lands above and stops this timer).
          timer = setTimeout(() => {
            timer = null;
            const c = keys.commit(Number.POSITIVE_INFINITY);
            if (c) finish(c);
          }, HOLD_MS);
        });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      const st = d.style;
      try {
        switch (choice) {
          case "once":
            d.output.write(`  ${st.green("yes")}\n`);
            return { kind: "once" };
          case "session":
            d.output.write(`  ${st.green(`yes to ${describeRule(suggested!)}`)}\n`);
            return { kind: "session", rule: suggested! };
          case "deny":
            d.output.write(`  ${st.red("no")}\n`);
            return { kind: "deny" };
          case "aborted":
            d.output.write(`  ${st.red("no (the turn was interrupted)")}\n`);
            return { kind: "deny", note: "The person interrupted the turn." };
          case "interrupt":
            d.output.write(`  ${st.red("no (interrupted)")}\n`);
            d.onInterrupt?.();
            return { kind: "deny", note: "The person interrupted instead of answering." };
          case "note": {
            d.router.detach();
            const note = (await d.readNote(`  ${st.red("no")}; what should it do instead? `)).trim();
            return note ? { kind: "deny", note: `The person's note: ${note}` } : { kind: "deny" };
          }
        }
      } finally {
        if (wasAttached) d.router.attach();
        else d.router.detach();
        d.afterPrompt?.();
      }
    },
  };
}

/** Whether every path sits under the root. */
function allUnder(paths: string[] | undefined, root: string): boolean {
  if (!paths?.length) return false;
  return paths.every((p) => {
    const rel = relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** What the model is told when a call needed a person and there was none: why, and which flag would have done. */
export function headlessNote(call: PendingCall, decision: Decision, suggested: SessionRule | null, workspaceRoot: string): string {
  // The loop puts this after "… and was not approved.", as a sentence of its own.
  const base = "Nobody was available to approve it (this is a memtro run with nobody at the terminal);";
  let flag: string;
  if (decision.source === "rule") flag = "it is always asked about, so only starting the run with --unchecked would permit it.";
  else if (call.risk === "write" && allUnder(call.summary.paths, workspaceRoot)) flag = "starting the run with --allow-edits would permit this.";
  else if (call.risk === "execute" && suggested?.kind === "command-prefix") flag = `starting the run with --allow "${suggested.words.join(" ")}" would permit this.`;
  else if (call.risk === "execute" && suggested?.kind === "command") flag = `starting the run with --allow "${suggested.command}" would permit this.`;
  else flag = "only starting the run with --unchecked would permit this.";
  return `${base} ${flag} Tell the person that, or do the task another way.`;
}

/** Nobody to ask: every question is a refusal, with the reason and the way round it in the note. */
export function headlessApprover(workspaceRoot: string): Approver {
  return {
    async ask(call, decision, suggested) {
      return { kind: "deny", note: headlessNote(call, decision, suggested, workspaceRoot) };
    },
  };
}
