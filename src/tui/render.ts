import type { AgentEvent, Answer, Decision, EndReason, Mode, PendingCall, Risk, ToolResult } from "../agent/types.js";
import { createMarkdown, type MarkdownStream } from "./markdown.js";
import { oneLine, sanitise, terminalText } from "./sanitise.js";
import { compactNumber, type TurnStats } from "./status.js";
import type { Style } from "./style.js";

/**
 * A turn's events as text. The renderer does no I/O: it hands each piece to a sink with the channel it belongs on,
 * `text` for the model's answer and `info` for everything else (tool lines, notices, errors). The interactive
 * session sends both to the terminal; `memtro run` sends the answer to stdout and the rest to stderr.
 */
export type Channel = "text" | "info";
export type Sink = (channel: Channel, text: string) => void;

export interface RenderOptions {
  style: Style;
  /** `collapsed`: one line saying how much thinking there was. `full`: the thinking itself, dimmed. */
  thinking: "collapsed" | "full" | "hidden";
  /** Both channels go to the same stream, so a partial answer line is ended before an info line. */
  shared: boolean;
  mode: Mode;
  diffLines?: number;
  outputLines?: number;
}

export const DIFF_LINES = 40;
export const OUTPUT_LINES = 8;

export class TurnRenderer {
  private md: MarkdownStream | null = null;
  /** The text channel has a line started and not ended. */
  private textOpen = false;
  private thinkingText = "";
  private thinkingLines = 0;
  private titles = new Map<string, string>();
  readonly stats: TurnStats;
  reason: EndReason | null = null;
  /** The last error event, which decides `run`'s exit code. */
  lastError: { message: string; retryable: boolean } | null = null;
  /** The last line of progress from a running tool, for a spinner's label. */
  lastProgress = "";

  constructor(
    private readonly sink: Sink,
    private readonly o: RenderOptions,
    model: string,
  ) {
    this.stats = { model, tokens: null, contextUsed: null, contextLimit: null, mode: o.mode };
  }

  event(e: AgentEvent): void {
    if (e.type !== "thinking") this.endThinking();
    switch (e.type) {
      case "turn-start":
        this.stats.model = e.model;
        return;
      case "routing":
        if (e.model) this.stats.model = e.model;
        return;
      case "text":
        return this.text(e.delta);
      case "thinking":
        return this.thinking(e.delta);
      case "tool-call":
        this.titles.set(e.call.id, e.call.summary.title);
        return this.info(toolCallLine(e.call, this.o.style));
      case "tool-decision":
        return this.info(decisionLine(e.decision, e.answer, this.o.style));
      case "tool-progress": {
        const lines = terminalText(e.text).split("\n").filter((l) => l.trim());
        if (lines.length) this.lastProgress = lines.at(-1)!;
        return;
      }
      case "tool-result":
        this.lastProgress = "";
        // A call refused before it was judged (bad arguments, no such tool) has no tool-call line of its own.
        if (!this.titles.has(e.id)) this.info(`${this.o.style.dim("○")} ${oneLine(e.tool)}`);
        return this.info(resultLines(e.result, this.o.style, { diffLines: this.o.diffLines, outputLines: this.o.outputLines }));
      case "usage":
        // A step the platform reported no usage for comes as zeros: that is "not reported", not "none".
        if (e.step.input || e.step.output) this.stats.tokens = (this.stats.tokens ?? 0) + e.step.input + e.step.output;
        this.stats.contextUsed = e.contextUsed;
        this.stats.contextLimit = e.contextLimit;
        return;
      case "compacted":
        return this.info(this.o.style.dim(`· Compacted the conversation: about ${compactNumber(e.before)} → ${compactNumber(e.after)} tokens.`));
      case "notice":
        return this.info(this.o.style.yellow(`· ${oneLine(e.text)}`));
      case "error":
        this.lastError = { message: e.message, retryable: e.retryable };
        return this.info(this.o.style.red(`✗ ${sanitise(e.message)}${e.retryable ? " (worth trying again)" : ""}`));
      case "turn-end":
        this.reason = e.reason;
        this.closeText();
        {
          const line = endLine(e.reason, this.o.style);
          if (line) this.info(line);
        }
        return;
    }
  }

  /** Ends anything left open (a held-back marker, an unterminated line). */
  finish(): void {
    this.endThinking();
    this.closeText();
  }

  private text(delta: string): void {
    this.md ??= createMarkdown(this.o.style.on);
    const s = this.md.push(delta);
    if (!s) return;
    this.sink("text", s);
    this.textOpen = !s.endsWith("\n");
  }

  private closeText(): void {
    if (this.md) {
      const rest = this.md.end();
      this.md = null;
      if (rest) {
        this.sink("text", rest);
        this.textOpen = !rest.endsWith("\n");
      }
    }
    if (this.textOpen) {
      this.sink("text", "\n");
      this.textOpen = false;
    }
  }

  private thinking(delta: string): void {
    if (this.o.thinking === "hidden") return;
    if (this.o.thinking === "full") {
      if (this.o.shared) this.closeText();
      this.thinkingText += delta;
      const text = sanitise(delta);
      if (text) this.sink("info", this.o.style.dim(text));
      return;
    }
    this.thinkingText += delta;
  }

  private endThinking(): void {
    if (!this.thinkingText) return;
    const text = this.thinkingText;
    this.thinkingText = "";
    if (this.o.thinking === "full") {
      if (!text.endsWith("\n")) this.sink("info", "\n");
      return;
    }
    this.thinkingLines = text.trim() ? text.trim().split("\n").length : 0;
    if (this.thinkingLines) this.info(this.o.style.dim(`· thought for ${this.thinkingLines} line${this.thinkingLines === 1 ? "" : "s"}`));
  }

  /** Whole lines on the info channel, after ending a partial answer line when they share a stream. */
  private info(text: string): void {
    if (!text) return;
    // An answer line in progress is ended first: on a shared stream so the info line starts on its own, and on
    // stdout alone so the text of the next step does not run on from this one.
    this.closeText();
    this.sink("info", text.endsWith("\n") ? text : `${text}\n`);
  }
}

const RISK_MARK: Record<Risk, string> = { read: "○", write: "●", execute: "▶", "remote-read": "◇", "remote-act": "◆" };

export function toolCallLine(call: PendingCall, st: Style): string {
  const mark = RISK_MARK[call.risk] ?? "●";
  const colour = call.risk === "read" || call.risk === "remote-read" ? st.dim : call.risk === "remote-act" ? st.magenta : st.cyan;
  return `${colour(mark)} ${oneLine(call.summary.title)}`;
}

/** Who decided, in words a person reads. `classifierOn` tells "the safety check is off" from "could not be reached". */
export function sourceWords(d: Decision, classifierOn = true): string {
  switch (d.source) {
    case "mode":
      return d.verdict === "ask" ? "ask mode puts every write, command and remote action to you" : "the session's mode";
    case "rule":
      return d.verdict === "ask" ? "always asked" : "a built-in rule";
    case "session":
      return "something you allowed for this session";
    case "classifier":
      return d.verdict === "ask" ? "the safety check was unsure" : d.verdict === "deny" ? "the safety check refused it" : "the safety check allowed it";
    case "fallback":
      return classifierOn ? "the safety check could not be reached" : "the safety check is off";
  }
}

/** The gate's reason as shown: its "Classifier: " prefix is said by the source words already. */
export function reasonText(d: Decision): string {
  return oneLine(d.reason.replace(/^Classifier:\s*/, ""));
}

/**
 * The "why" line of an approval: who put it to the person and why, each said once. The gate's reasons often say
 * who already ("Ask mode: this is put to you.", "…, which is always put to you.", "The classifier did not answer…,
 * so this is put to you."), so a reason that does is shown alone, and the source words only where the reason
 * leaves them out. Nothing in the reason is dropped.
 */
export function whyText(d: Decision, classifierOn = true): string {
  const words = sourceWords(d, classifierOn);
  const raw = oneLine(d.reason ?? "").trim();
  if (!raw) return words;
  const reason = reasonText(d);
  const joined = `${words}: ${reason}`;
  switch (d.source) {
    case "mode":
      if (/^Ask mode\b/i.test(raw)) return words;
      return /put to you|nothing is judged/i.test(raw) ? safetyCheck(raw) : joined;
    case "rule":
      return /always (put to you|asked)/i.test(raw) ? raw : joined;
    case "session":
      return /^You allowed\b/.test(raw) ? raw : joined;
    case "classifier": {
      const tooLong = /^Classifier would allow it, but (.+?)\.?\s*\(Classifier:\s*(.*)\)$/s.exec(raw);
      if (tooLong) return `the safety check would allow it, but ${tooLong[1]}${tooLong[2] ? `; its reason: ${tooLong[2]}` : ""}`;
      return joined;
    }
    case "fallback":
      return /put to you/i.test(raw) ? safetyCheck(raw) : joined;
  }
}

/** The gate says "classifier"; everything a person reads says "safety check". */
function safetyCheck(text: string): string {
  return text.replace(/\bthe classifier\b/g, "the safety check").replace(/\bThe classifier\b/g, "The safety check").replace(/\bno classifier\b/g, "no safety check");
}

export function decisionLine(d: Decision, answer: Answer | undefined, st: Style): string {
  if (answer) {
    if (answer.kind === "deny") return st.red(`  ✗ not run${answer.note ? `: ${oneLine(answer.note)}` : " (you said no)"}`);
    return answer.kind === "session" ? st.dim("  ✓ allowed for this session") : "";
  }
  if (d.verdict === "deny") return st.red(`  ✗ refused (${sourceWords(d)}): ${reasonText(d)}`);
  if (d.verdict === "allow" && d.source === "classifier") return st.dim(`  ✓ ${reasonText(d)}`);
  return "";
}

export function colourDiff(diff: string, st: Style, max = DIFF_LINES): string {
  const lines = sanitise(diff).replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, max).map((l) => {
    if (l.startsWith("+++") || l.startsWith("---")) return st.bold(l);
    if (l.startsWith("@@")) return st.cyan(l);
    if (l.startsWith("+")) return st.green(l);
    if (l.startsWith("-")) return st.red(l);
    return l;
  });
  if (lines.length > max) shown.push(st.dim(`… ${lines.length - max} more line${lines.length - max === 1 ? "" : "s"}`));
  return shown.join("\n");
}

/** The last `n` lines, with a note of how many came before. */
export function tail(text: string, n: number, st: Style): string[] {
  const lines = terminalText(text).replace(/\n+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  const kept = lines.slice(-n);
  return lines.length > n ? [st.dim(`… ${lines.length - n} earlier line${lines.length - n === 1 ? "" : "s"}`), ...kept] : kept;
}

const indent = (lines: string[], prefix = "  ") => lines.map((l) => `${prefix}${l}`).join("\n");

export function resultLines(r: ToolResult, st: Style, o: { diffLines?: number; outputLines?: number } = {}): string {
  const d = r.display;
  if (d?.kind === "diff" && !d.diff.trim()) return st.dim("  ↳ no change");
  if (d?.kind === "diff") return indent(colourDiff(d.diff, st, o.diffLines ?? DIFF_LINES).split("\n"));
  if (d?.kind === "command") {
    const out = tail(d.output, o.outputLines ?? OUTPUT_LINES, st).map((l) => st.dim(`│ ${l}`));
    const code = d.exitCode === null ? st.red("stopped before it exited") : d.exitCode === 0 ? st.dim("exit 0") : st.red(`exit ${d.exitCode}`);
    return indent([...out, code]);
  }
  if (d?.kind === "text") {
    const lines = tail(d.text, o.outputLines ?? OUTPUT_LINES, st);
    return indent(lines.map((l) => (r.isError ? st.red(l) : st.dim(l))));
  }
  const text = sanitise(r.content).trim();
  if (r.isError) return st.red(`  ✗ ${oneLine(text.split("\n")[0] ?? "") || "failed"}`);
  const n = text ? text.split("\n").length : 0;
  return st.dim(n ? `  ↳ ${n} line${n === 1 ? "" : "s"}` : "  ↳ (nothing)");
}

/** The loop says why a turn stopped at its length or step limit itself (a notice); only an interrupt needs a line. */
export function endLine(reason: EndReason, st: Style): string {
  switch (reason) {
    case "interrupted":
      return st.yellow("Interrupted.");
    default:
      return "";
  }
}
