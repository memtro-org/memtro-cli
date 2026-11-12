/**
 * The classifier: one forced function call to a model, asking whether a call is what the person asked for and safe
 * to run without asking them.
 *
 * It fails closed. A timeout (enforced here, whatever the transport does with `timeoutMs`), a rejection, an
 * interrupt, or any reply that is not exactly the verdict tool with a known decision and a reason, is the `fallback`
 * ask. It is called once per check: there is no retry, so a `block` cannot become anything else within a call.
 */

import type { Decision, ForcedCall, GateContext, PendingCall } from "../agent/types.js";
import { classifierSystemPrompt, classifierUserPrompt, VERDICT_TOOL } from "./prompt.js";

export interface ClassifierOptions {
  call: ForcedCall;
  model: string;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 60_000;
export const MAX_REASON_LENGTH = 300;
const MAX_TOKENS = 300;

export type ClassifierVerdict = { decision: "allow" | "ask" | "block"; reason: string };

/** Strict: an object with `decision` exactly one of the three and a non-empty string `reason`. Extra keys are ignored. */
export function parseVerdict(raw: unknown): ClassifierVerdict | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { decision, reason } = raw as Record<string, unknown>;
  if (decision !== "allow" && decision !== "ask" && decision !== "block") return null;
  if (typeof reason !== "string") return null;
  const clean = cleanReason(reason);
  if (!clean) return null;
  return { decision, reason: clean };
}

/** One line of plain text: control and bidi characters gone (a reason is printed to a terminal), length capped. */
export function cleanReason(reason: string): string {
  const flat = reason
    .replace(UNPRINTABLE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH - 1)}…` : flat;
}

/** Control characters, zero-width and bidi controls, line and paragraph separators, byte-order mark. */
const UNPRINTABLE = new RegExp(
  "[" +
    [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
      .map(([a, b]) => `${String.fromCharCode(a!)}-${String.fromCharCode(b!)}`)
      .join("") +
    "]",
  "g",
);

export const fallback = (reason: string): Decision => ({ verdict: "ask", reason, source: "fallback" });

function timeoutOf(options: ClassifierOptions): number {
  const t = options.timeoutMs;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.min(t, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

type Outcome = { kind: "reply"; value: unknown } | { kind: "failed" } | { kind: "timeout" } | { kind: "interrupted" };

/** Asks the classifier about one call. Never throws. */
export async function classify(call: PendingCall, ctx: GateContext, options: ClassifierOptions): Promise<Decision> {
  if (ctx.signal?.aborted) return fallback("Interrupted before the classifier answered, so this is put to you.");
  const timeoutMs = timeoutOf(options);
  const user = classifierUserPrompt({
    call,
    userMessages: ctx.userMessages,
    earlierCalls: ctx.earlierCalls,
    cwd: ctx.cwd,
    workspaceRoot: ctx.workspaceRoot,
  });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onOuterAbort: (() => void) | undefined;
  const stopped = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "timeout" });
      controller.abort();
    }, timeoutMs);
    onOuterAbort = () => {
      resolve({ kind: "interrupted" });
      controller.abort();
    };
    ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
  });

  const asked: Promise<Outcome> = Promise.resolve()
    .then(() =>
      options.call({
        model: options.model,
        system: classifierSystemPrompt(),
        user: user.text,
        tool: VERDICT_TOOL,
        maxTokens: MAX_TOKENS,
        timeoutMs,
        signal: controller.signal,
      }),
    )
    .then(
      (value): Outcome => ({ kind: "reply", value }),
      (): Outcome => ({ kind: "failed" }),
    );

  let outcome: Outcome;
  try {
    outcome = await Promise.race([asked, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onOuterAbort) ctx.signal?.removeEventListener("abort", onOuterAbort);
    controller.abort();
  }

  switch (outcome.kind) {
    case "interrupted":
      return fallback("Interrupted before the classifier answered, so this is put to you.");
    case "timeout":
      return fallback(`The classifier did not answer within ${Math.round(timeoutMs / 100) / 10} s, so this is put to you.`);
    case "failed":
      return fallback("The classifier could not be reached or failed, so this is put to you.");
    case "reply":
      break;
  }

  const verdict = parseVerdict(outcome.value);
  if (!verdict) return fallback("The classifier's answer could not be read, so this is put to you.");
  const said = `Classifier: ${verdict.reason}`;
  if (verdict.decision === "block") return { verdict: "deny", reason: said, source: "classifier" };
  if (verdict.decision === "ask") return { verdict: "ask", reason: said, source: "classifier" };
  if (user.callCut) {
    return {
      verdict: "ask",
      reason: `Classifier would allow it, but part of the call was too long to show it, so this is put to you. (${said})`,
      source: "classifier",
    };
  }
  return { verdict: "allow", reason: said, source: "classifier" };
}
