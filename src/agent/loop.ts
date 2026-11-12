import { randomBytes } from "node:crypto";
import type { ApiClient } from "../api/client.js";
import { streamTurn } from "../api/chat.js";
import { errorText } from "../errors.js";
import { applyCompaction, estimateTokens, isSummaryMessage, KEEP_RECENT_TOKENS, planCompaction, shouldCompact, summaryRequest } from "./compaction.js";
import { findContextFiles } from "./context-files.js";
import { backoffMs, MAX_RETRIES, retryable, sleep } from "./retry.js";
import { buildSystemPrompt, readGitSummary } from "./system-prompt.js";
import type {
  Agent,
  AgentEvent,
  Answer,
  Approver,
  Decision,
  EndReason,
  Gate,
  Message,
  PendingCall,
  SessionMeta,
  SessionStore,
  Tool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  Usage,
} from "./types.js";

/**
 * The loop: one turn is the person's message, then model steps until the model stops asking for tools.
 *
 * Each step is one streamed request (`memtro.tools: false`, so the platform runs exactly one model step). Tool
 * calls are taken in the order given and each is validated, judged by the gate, put to the person when the gate
 * says `ask`, then run one at a time. Every call gets exactly one tool result, whatever happens to it (bad
 * arguments, refused, failed, interrupted), so the conversation is always one the platform will accept next time,
 * including after a crash, since every message is saved in the order it was added.
 */

export interface AgentOptions {
  client: ApiClient;
  model: string;
  tools: Tool[];
  gate: Gate;
  approver: Approver;
  store: SessionStore;
  cwd: string;
  workspaceRoot: string;
  /** "owner/name" from git, as pi-memtro sends. */
  project: string | null;
  contextLimit: (model: string) => number | null;
  resume?: { meta: SessionMeta; messages: Message[] };
  maxSteps?: number;
  now?: () => Date;
}

export const DEFAULT_MAX_STEPS = 100;
/** How long a tool that was told to stop gets to stop before the turn ends without it. */
const STOP_GRACE_MS = 3000;
const TITLE_CHARS = 80;

type StepOutcome = { kind: "ok"; text: string; calls: ToolCallRequest[]; finish: string | null; usage: Usage | null } | { kind: "interrupted" } | { kind: "error" };

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
const abortError = () => new DOMException("Interrupted.", "AbortError");

/** Rejects with an AbortError as soon as `signal` is aborted, whatever `promise` is doing. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const failed = (content: string): ToolResult => ({ content, isError: true });

/**
 * What the model is told when a call was not run because it needed approval and did not get it. The approver's
 * note is a sentence of its own: the person's words ("The person's note: use pnpm"), or why nobody could answer.
 */
export function declinedResult(decision: Decision, note?: string): ToolResult {
  const n = note?.trim();
  const sentence = n ? ` ${/[.!?]$/.test(n) ? n : `${n}.`}` : " The person said no.";
  return failed(
    `Not run: this call needed the person's approval (${decision.reason.replace(/\.$/, "")}) and was not approved.${sentence}` +
      ` Do not retry the same call unchanged; ${n ? "follow the note" : "take a different approach, or ask the person what they want"}.`,
  );
}

/** What the model is told when the safety check refused a call outright. */
export function refusedResult(decision: Decision): ToolResult {
  return failed(
    `Not run: the safety check refused this call: ${decision.reason.replace(/\.$/, "")}. Do not retry the same call unchanged; take a different approach, or explain to the person what you need and why.`,
  );
}

export const INTERRUPTED_BEFORE = "Not run: the person interrupted the turn before this call ran.";
export const INTERRUPTED_DURING = "Interrupted: the person stopped the turn while this call was running; it may have done part of its work.";

export function createAgent(options: AgentOptions): Agent {
  const o = options;
  const now = o.now ?? (() => new Date());
  const maxSteps = o.maxSteps ?? DEFAULT_MAX_STEPS;
  const sessionId = o.resume?.meta.id ?? `cli-${randomBytes(8).toString("hex")}`;
  let model = o.model;
  let created = o.resume !== undefined;
  let messages: Message[] = o.resume ? [...o.resume.messages] : [];
  /** What the person typed this session: the gate's only statement of intent. Never a summary or a tool result. */
  const userTexts: string[] = messages.filter((m): m is Message & { role: "user" } => m.role === "user" && !isSummaryMessage(m)).map((m) => m.content);
  const session: Usage = { input: 0, output: 0 };
  let lastInput = o.resume ? estimateTokens(o.resume.messages) : 0;
  let saveWarned = false;
  let prompt: string | null = null;

  const systemPrompt = (): string =>
    (prompt ??= buildSystemPrompt(
      {
        cwd: o.cwd,
        workspaceRoot: o.workspaceRoot,
        project: o.project,
        git: readGitSummary(o.cwd),
        platform: process.platform,
        date: now().toISOString().slice(0, 10),
      },
      o.tools.map((t) => t.spec),
      findContextFiles(o.workspaceRoot, o.cwd),
    ));

  const memtro = (): Record<string, unknown> => ({ tools: false, session: sessionId, ...(o.project ? { project: o.project } : {}) });
  const limit = () => o.contextLimit(model);
  const keepTokens = () => {
    const l = limit();
    return l ? Math.min(KEEP_RECENT_TOKENS, Math.floor(l * 0.3)) : KEEP_RECENT_TOKENS;
  };

  /** Saving failed: say so once, keep going. The conversation in memory is still whole. */
  function* saveFailed(err: unknown): Generator<AgentEvent> {
    if (saveWarned) return;
    saveWarned = true;
    yield { type: "notice", text: `Could not save this session (${errorText(err)}); it carries on, but cannot be resumed.` };
  }

  function* push(message: Message): Generator<AgentEvent> {
    messages.push(message);
    if (!created) return;
    try {
      o.store.appendMessage(sessionId, message);
    } catch (err) {
      yield* saveFailed(err);
    }
  }

  function* ensureCreated(text: string): Generator<AgentEvent> {
    if (created) return;
    created = true;
    const first = text.trim().split("\n")[0] ?? "";
    const title = first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1)}…` : first;
    try {
      o.store.create({ id: sessionId, cwd: o.cwd, started: now().toISOString(), model, title });
      for (const m of messages) o.store.appendMessage(sessionId, m);
    } catch (err) {
      yield* saveFailed(err);
    }
  }

  async function* compactNow(signal: AbortSignal, manual: boolean): AsyncGenerator<AgentEvent> {
    const keptFrom = planCompaction(messages, keepTokens());
    if (keptFrom === null) {
      if (manual) yield { type: "notice", text: "Nothing to compact yet: the conversation is only its most recent turn." };
      return;
    }
    const before = estimateTokens(messages);
    let summary = "";
    try {
      for await (const c of streamTurn(o.client, {
        model,
        messages: summaryRequest(messages.slice(0, keptFrom)),
        tools: [],
        // Nothing retrieved into a summary of our own words, and nothing learned from it a second time.
        memtro: { tools: false, retrieve: false, memory: "off", session: sessionId },
        signal,
      })) {
        if (c.type === "text") summary += c.delta;
        else if (c.type === "usage") {
          session.input += c.usage.input;
          session.output += c.usage.output;
        } else if (c.type === "finish" && c.reason === "length") summary = "";
      }
    } catch (err) {
      yield { type: "notice", text: signal.aborted ? "Compaction was interrupted; the conversation is as it was." : `Compaction failed (${errorText(err)}); the conversation is as it was.` };
      return;
    }
    if (!summary.trim()) {
      yield { type: "notice", text: "Compaction failed (the summary came back empty or cut off); the conversation is as it was." };
      return;
    }
    messages = applyCompaction(messages, summary, keptFrom);
    if (created) {
      try {
        o.store.appendCompaction(sessionId, summary, keptFrom);
      } catch (err) {
        yield* saveFailed(err);
      }
    }
    const after = estimateTokens(messages);
    lastInput = after + estimateTokens([{ role: "system", content: systemPrompt() }]);
    yield { type: "compacted", before, after };
  }

  async function* step(signal: AbortSignal): AsyncGenerator<AgentEvent, StepOutcome> {
    for (let attempt = 0; ; attempt++) {
      let text = "";
      let started = false;
      const calls: ToolCallRequest[] = [];
      let finish: string | null = null;
      let usage: Usage | null = null;
      try {
        for await (const c of streamTurn(o.client, {
          model,
          messages: [{ role: "system", content: systemPrompt() }, ...messages],
          tools: o.tools.map((t) => t.spec),
          memtro: memtro(),
          signal,
        })) {
          if (c.type === "text") {
            started = true;
            text += c.delta;
            yield { type: "text", delta: c.delta };
          } else if (c.type === "thinking") {
            // Shown, never sent back: the platform cannot take it (facts A4/A5).
            started = true;
            yield { type: "thinking", delta: c.delta };
          } else if (c.type === "routing") yield { type: "routing", model: c.model, detail: c.detail };
          else if (c.type === "usage") usage = c.usage;
          else if (c.type === "tool-call") calls.push(c.call);
          else if (c.type === "finish") finish = c.reason;
        }
        return { kind: "ok", text, calls, finish, usage };
      } catch (err) {
        if (signal.aborted || isAbort(err)) {
          // What the person saw stays in the record; no tool call was received, since calls only count whole.
          if (text) yield* push({ role: "assistant", content: text });
          return { kind: "interrupted" };
        }
        if (!started && retryable(err) && attempt < MAX_RETRIES) {
          const wait = backoffMs(attempt, err);
          yield { type: "notice", text: `${errorText(err)} Trying again in ${Math.max(1, Math.round(wait / 1000))}s (${attempt + 1} of ${MAX_RETRIES}).` };
          try {
            await sleep(wait, signal);
          } catch {
            return { kind: "interrupted" };
          }
          continue;
        }
        if (text) yield* push({ role: "assistant", content: text });
        yield { type: "error", message: errorText(err), retryable: retryable(err) };
        return { kind: "error" };
      }
    }
  }

  /** One tool result, saved and shown. Every call goes through here exactly once. */
  function* answer(call: ToolCallRequest, result: ToolResult): Generator<AgentEvent> {
    yield* push({ role: "tool", tool_call_id: call.id, content: result.content });
    yield { type: "tool-result", id: call.id, tool: call.name, result };
  }

  async function* handleCall(call: ToolCallRequest, signal: AbortSignal, earlierCalls: string[]): AsyncGenerator<AgentEvent, "done" | "interrupted"> {
    let raw: unknown;
    try {
      raw = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch (err) {
      yield* answer(call, failed(`The arguments for ${call.name} were not valid JSON (${errorText(err)}). Send them again as one JSON object.`));
      return "done";
    }
    const tool = o.tools.find((t) => t.spec.name === call.name);
    if (!tool) {
      yield* answer(call, failed(`There is no tool named "${call.name}". The tools available are: ${o.tools.map((t) => t.spec.name).join(", ") || "none"}.`));
      return "done";
    }
    const tctx = { cwd: o.cwd, workspaceRoot: o.workspaceRoot };
    let pending: PendingCall;
    try {
      const v = tool.validate(raw);
      if (!v.ok) {
        yield* answer(call, failed(`Invalid arguments for ${call.name}: ${v.error}`));
        return "done";
      }
      const risk = tool.risk(v.args, tctx);
      const summary = await raceAbort(Promise.resolve(tool.summarise(v.args, tctx)), signal);
      pending = { id: call.id, tool: call.name, args: v.args, risk, summary };
    } catch (err) {
      if (signal.aborted) {
        yield* answer(call, failed(INTERRUPTED_BEFORE));
        return "interrupted";
      }
      yield* answer(call, failed(`Could not prepare the ${call.name} call: ${errorText(err)}`));
      return "done";
    }
    yield { type: "tool-call", call: pending };

    let decision: Decision;
    try {
      decision = await raceAbort(o.gate.check(pending, { userMessages: [...userTexts], earlierCalls: [...earlierCalls], cwd: o.cwd, workspaceRoot: o.workspaceRoot, signal }), signal);
    } catch (err) {
      if (signal.aborted) {
        yield* answer(call, failed(INTERRUPTED_BEFORE));
        return "interrupted";
      }
      // The gate promises never to throw; if it does, the cautious answer.
      decision = { verdict: "ask", reason: `The safety check failed (${errorText(err)})`, source: "fallback" };
    }
    earlierCalls.push(pending.summary.title);

    if (decision.verdict === "ask") {
      let suggested = null;
      try {
        suggested = o.gate.suggestRule(pending);
      } catch {
        suggested = null;
      }
      let given: Answer;
      try {
        given = await raceAbort(o.approver.ask(pending, decision, suggested), signal);
      } catch (err) {
        if (signal.aborted) {
          yield* answer(call, failed(INTERRUPTED_BEFORE));
          return "interrupted";
        }
        given = { kind: "deny", note: `The approval prompt failed (${errorText(err)}).` };
      }
      yield { type: "tool-decision", id: call.id, decision, answer: given };
      if (given.kind === "deny") {
        yield* answer(call, declinedResult(decision, given.note));
        return "done";
      }
      if (given.kind === "session") o.gate.remember(given.rule);
    } else {
      yield { type: "tool-decision", id: call.id, decision };
      if (decision.verdict === "deny") {
        yield* answer(call, refusedResult(decision));
        return "done";
      }
    }
    if (signal.aborted) {
      yield* answer(call, failed(INTERRUPTED_BEFORE));
      return "interrupted";
    }

    // Run it, passing its progress on as it comes.
    const progress: string[] = [];
    let wake: (() => void) | null = null;
    const nudge = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const ctx: ToolContext = {
      cwd: o.cwd,
      workspaceRoot: o.workspaceRoot,
      signal,
      onProgress: (text) => {
        progress.push(text);
        nudge();
      },
    };
    type Outcome = { ok: true; result: ToolResult } | { ok: false; err: unknown };
    const state: { outcome: Outcome | null } = { outcome: null };
    const running = (async () => {
      try {
        return { ok: true as const, result: await tool.run(pending.args, ctx) };
      } catch (err) {
        return { ok: false as const, err };
      }
    })().then((r) => {
      state.outcome = r;
      nudge();
      return r;
    });
    const onAbort = () => nudge();
    signal.addEventListener("abort", onAbort);
    try {
      for (;;) {
        while (progress.length) yield { type: "tool-progress", id: call.id, text: progress.shift()! };
        if (state.outcome || signal.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (state.outcome || progress.length || signal.aborted) nudge();
        });
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) {
      // The tool has the signal and stops what it started; give it a moment to say what it got to.
      const settled = state.outcome ?? (await Promise.race([running, new Promise<null>((r) => setTimeout(() => r(null), STOP_GRACE_MS).unref())]));
      while (progress.length) yield { type: "tool-progress", id: call.id, text: progress.shift()! };
      const got = settled && settled.ok ? settled.result.content : "";
      yield* answer(call, failed(got ? `${INTERRUPTED_DURING}\nWhat it returned:\n${got}` : INTERRUPTED_DURING));
      return "interrupted";
    }
    const done = state.outcome;
    if (!done) throw new Error("unreachable: tool finished without an outcome");
    yield* answer(call, done.ok ? done.result : failed(`The ${call.name} tool failed: ${errorText(done.err)}`));
    return "done";
  }

  function* answerInterrupted(calls: ToolCallRequest[]): Generator<AgentEvent> {
    for (const c of calls) yield* answer(c, failed(INTERRUPTED_BEFORE));
  }

  const end = (reason: EndReason): AgentEvent => ({ type: "turn-end", reason });

  async function* run(text: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { type: "turn-start", session: sessionId, model };
    yield* ensureCreated(text);
    if (shouldCompact(lastInput, limit())) yield* compactNow(signal, false);
    yield* push({ role: "user", content: text });
    userTexts.push(text);
    const earlierCalls: string[] = [];

    for (let n = 0; ; n++) {
      if (signal.aborted) { yield end("interrupted"); return; }
      if (n >= maxSteps) {
        yield { type: "notice", text: `Stopped after ${maxSteps} steps without the model finishing. Say "continue" to let it carry on.` };
        { yield end("step-limit"); return; }
      }
      if (n > 0 && shouldCompact(lastInput, limit())) {
        yield* compactNow(signal, false);
        if (signal.aborted) { yield end("interrupted"); return; }
      }

      const out = yield* step(signal);
      if (out.kind === "interrupted") { yield end("interrupted"); return; }
      if (out.kind === "error") { yield end("error"); return; }

      if (out.text || out.calls.length) yield* push({ role: "assistant", content: out.text || null, ...(out.calls.length ? { tool_calls: out.calls } : {}) });
      if (out.usage) {
        session.input += out.usage.input;
        session.output += out.usage.output;
        if (out.usage.cached !== undefined) session.cached = (session.cached ?? 0) + out.usage.cached;
        lastInput = out.usage.input;
      }
      yield { type: "usage", step: out.usage ?? { input: 0, output: 0 }, session: { ...session }, contextUsed: lastInput, contextLimit: limit() };

      if (out.finish === "length") {
        // Calls in a reply cut off at the limit are not trusted to be what the model meant; each still gets a result.
        for (const c of out.calls) yield* answer(c, failed("Not run: the reply was cut off at the output limit before it finished."));
        yield { type: "notice", text: "The model stopped at its output limit before finishing. Ask it to continue, or to do less in one reply." };
        { yield end("length"); return; }
      }
      if (out.finish === "content_filter") yield { type: "notice", text: "The provider's content filter stopped the reply." };
      if (out.calls.length === 0) { yield end("stop"); return; }

      for (let i = 0; i < out.calls.length; i++) {
        if (signal.aborted) {
          yield* answerInterrupted(out.calls.slice(i));
          { yield end("interrupted"); return; }
        }
        const r = yield* handleCall(out.calls[i]!, signal, earlierCalls);
        if (r === "interrupted") {
          yield* answerInterrupted(out.calls.slice(i + 1));
          { yield end("interrupted"); return; }
        }
      }
    }
  }

  return {
    sessionId,
    get model() {
      return model;
    },
    setModel(m: string) {
      model = m;
    },
    run,
    compact: (signal: AbortSignal) => compactNow(signal, true),
    messages: () => [...messages],
  };
}
