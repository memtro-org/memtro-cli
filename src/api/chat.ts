import { randomBytes } from "node:crypto";
import type { ForcedCall, Message, ToolCallRequest, ToolSpec, Usage } from "../agent/types.js";
import { CliError, UnavailableError } from "../errors.js";
import type { ApiClient } from "./client.js";
import { readSse } from "./sse.js";

/**
 * `POST /v1/chat/completions`, streamed.
 *
 * The stream is OpenAI's chunk shape (brain src/lib/openai/compat.ts `openAIStreamResponse`): `delta.content` is
 * the answer; `delta.reasoning_content` is the model's thinking and, in agent mode, a text copy of the tool log;
 * chunks with `choices: []` carry Memtro's extension (`memtro`) or the usage; `data: [DONE]` ends a stream that
 * finished. A failure part-way through is sent as `data: {"error": {...}}` with no [DONE] after it, so a stream
 * that simply stops without either was cut off, and is reported that way rather than as an answer.
 */

/** An agent run may take thirty minutes; silence for three means the connection is gone. */
export const STREAM_TOTAL_MS = 31 * 60_000;
export const STREAM_IDLE_MS = 3 * 60_000;

export interface ChatBody {
  model: string;
  messages: { role: "user" | "system" | "assistant"; content: string }[];
  memtro?: Record<string, unknown>;
}

export interface ChatOutcome {
  id: string | null;
  model: string | null;
  content: string;
  finish_reason: string | null;
  usage: Record<string, unknown> | null;
  /** Memtro's closing extension chunk, as sent. */
  memtro: unknown;
}

interface Chunk {
  id?: string;
  model?: string;
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
  usage?: Record<string, unknown> | null;
  memtro?: unknown;
  error?: { message?: string };
}

export async function streamChat(
  client: ApiClient,
  body: ChatBody,
  on: { content?: (text: string) => void; reasoning?: (text: string) => void } = {},
  limits: { totalMs?: number; idleMs?: number } = {},
): Promise<ChatOutcome> {
  const controller = new AbortController();
  const total = setTimeout(() => controller.abort(new DOMException("total", "TimeoutError")), limits.totalMs ?? STREAM_TOTAL_MS);
  let idled = false;
  try {
    const res = await client.fetch("/v1/chat/completions", {
      method: "POST",
      body: { ...body, stream: true, stream_options: { include_usage: true } },
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.body) throw new CliError("Memtro answered without a body.");

    const out: ChatOutcome = { id: null, model: null, content: "", finish_reason: null, usage: null, memtro: null };
    let done = false;
    try {
      for await (const ev of readSse(res.body, { idleMs: limits.idleMs ?? STREAM_IDLE_MS, onIdle: () => (idled = true) })) {
        if (ev.data === "[DONE]") {
          done = true;
          break;
        }
        let chunk: Chunk;
        try {
          chunk = JSON.parse(ev.data) as Chunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new CliError(`Memtro stopped part-way through the answer: ${chunk.error.message ?? "unknown error"}`);
        out.id ??= chunk.id ?? null;
        out.model ??= chunk.model ?? null;
        if (chunk.memtro !== undefined && (!chunk.choices || chunk.choices.length === 0)) out.memtro = chunk.memtro;
        if (chunk.usage) out.usage = chunk.usage;
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (delta.content) {
            out.content += delta.content;
            on.content?.(delta.content);
          }
          if (delta.reasoning_content) on.reasoning?.(delta.reasoning_content);
          if (choice.finish_reason) out.finish_reason = choice.finish_reason;
        }
      }
    } catch (err) {
      if (err instanceof CliError) throw err;
      if (controller.signal.aborted) throw new UnavailableError(`Memtro took longer than ${Math.round((limits.totalMs ?? STREAM_TOTAL_MS) / 60_000)} minutes to answer; gave up.`);
      throw new UnavailableError(`The connection to Memtro dropped part-way through the answer (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (idled) throw new UnavailableError(`Memtro went quiet for ${Math.round((limits.idleMs ?? STREAM_IDLE_MS) / 1000)}s part-way through the answer; gave up.`);
    if (!done) throw new UnavailableError("The answer was cut off: the stream ended without finishing.");
    return out;
  } finally {
    clearTimeout(total);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One step of the harness's own loop
// ---------------------------------------------------------------------------------------------------------------

/**
 * A `:chat` request with `memtro.tools: false` is one model step and the platform's clock for it is five minutes
 * (brain agent/limits.ts), so a step that has not finished in six never will. Silence is allowed for as long as
 * `ask` allows it: routing and retrieval send nothing before the first chunk, and there are no keep-alives.
 */
export const TURN_TOTAL_MS = 6 * 60_000;
export const TURN_IDLE_MS = 3 * 60_000;

export interface TurnRequest {
  model: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens?: number;
  memtro: Record<string, unknown>;
  signal: AbortSignal;
}

export type TurnChunk =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool-call"; call: ToolCallRequest }
  | { type: "routing"; model: string | null; detail: unknown }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: string | null; model: string | null };

/**
 * The id as sent: always with `:chat`, so the platform runs exactly one model step and never nests its own agent
 * loop inside ours (pi-memtro ca81000). A `:agent` suffix is replaced, not stacked; an empty id is `memtro`.
 */
export function chatModelId(model: string): string {
  const bare = model.trim().replace(/:(agent|chat)$/, "");
  return `${bare || "memtro"}:chat`;
}

/** Our messages in the wire's spelling: a tool call is `{id, type: "function", function: {name, arguments}}`. */
export function wireMessage(m: Message): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls?.length) {
    return { role: "assistant", content: m.content, tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) };
  }
  if (m.role === "assistant") return { role: "assistant", content: m.content ?? "" };
  return { ...m };
}

export function wireTools(tools: ToolSpec[]): Record<string, unknown>[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

interface TurnWireChunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  memtro?: { routing?: unknown; answered_by?: unknown } & Record<string, unknown>;
  error?: { message?: string };
}

const abortError = (): DOMException => new DOMException("The turn was interrupted.", "AbortError");

/**
 * One streamed step. Yields text and thinking as they arrive; the routing note from the first chunk (and again
 * if a fallback answered); usage when the platform sends it; then, only once `[DONE]` has arrived, every tool
 * call (whole, in the order given) followed by `finish`. A stream that ends any other way throws, so a cut-off
 * answer is never mistaken for a complete one.
 *
 * Throws: `PlatformError`/`UnavailableError`/`AuthError` from the request; `CliError` for an error chunk part-way
 * through (not worth retrying: the platform already tried); `UnavailableError` for a dropped, silent or cut-off
 * stream; an `AbortError` when `request.signal` is aborted.
 */
export async function* streamTurn(client: ApiClient, request: TurnRequest): AsyncGenerator<TurnChunk> {
  if (request.signal.aborted) throw abortError();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("total", "TimeoutError")), TURN_TOTAL_MS);
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  const body: Record<string, unknown> = {
    model: chatModelId(request.model),
    messages: request.messages.map(wireMessage),
    stream: true,
    stream_options: { include_usage: true },
    memtro: request.memtro,
  };
  if (request.tools.length) body.tools = wireTools(request.tools);
  if (request.maxTokens) body.max_completion_tokens = request.maxTokens;

  let idled = false;
  let done = false;
  let firstModel: string | null = null;
  let answeredBy: string | null = null;
  let finish: string | null = null;
  let sawRouting = false;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  try {
    let res: Response;
    try {
      res = await client.fetch("/v1/chat/completions", { method: "POST", body, headers: { Accept: "text/event-stream" }, signal });
    } catch (err) {
      if (request.signal.aborted) throw abortError();
      throw err;
    }
    if (!res.body) throw new CliError("Memtro answered without a body.");
    try {
      for await (const ev of readSse(res.body, { idleMs: TURN_IDLE_MS, onIdle: () => (idled = true) })) {
        if (ev.data === "[DONE]") {
          done = true;
          break;
        }
        let chunk: TurnWireChunk;
        try {
          chunk = JSON.parse(ev.data) as TurnWireChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new CliError(`Memtro stopped part-way through the answer: ${chunk.error.message ?? "unknown error"}`);
        if (firstModel === null && typeof chunk.model === "string") firstModel = chunk.model;
        if (chunk.memtro && typeof chunk.memtro === "object") {
          if (!sawRouting && chunk.memtro.routing !== undefined) {
            sawRouting = true;
            const routed = (chunk.memtro.routing as { model?: unknown } | null)?.model;
            yield { type: "routing", model: firstModel ?? (typeof routed === "string" ? routed : null), detail: chunk.memtro.routing };
          }
          if (typeof chunk.memtro.answered_by === "string" && chunk.memtro.answered_by !== answeredBy) {
            answeredBy = chunk.memtro.answered_by;
            yield { type: "routing", model: answeredBy, detail: chunk.memtro };
          }
        }
        if (chunk.usage) {
          yield {
            type: "usage",
            usage: {
              input: chunk.usage.prompt_tokens ?? 0,
              output: chunk.usage.completion_tokens ?? 0,
              ...(typeof chunk.usage.prompt_tokens_details?.cached_tokens === "number" ? { cached: chunk.usage.prompt_tokens_details.cached_tokens } : {}),
            },
          };
        }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (delta.reasoning_content) yield { type: "thinking", delta: delta.reasoning_content };
          if (delta.content) yield { type: "text", delta: delta.content };
          // Memtro sends each call whole in one chunk (compat.ts openAIStreamResponse); OpenAI's incremental
          // spelling, keyed by index with the arguments in pieces, comes to the same thing here.
          for (const [i, tc] of (delta.tool_calls ?? []).entries()) {
            const index = typeof tc.index === "number" ? tc.index : calls.size + i;
            const acc = calls.get(index) ?? { id: "", name: "", arguments: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            calls.set(index, acc);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (err) {
      if (request.signal.aborted) throw abortError();
      if (err instanceof CliError) throw err;
      if (timeout.signal.aborted) throw new UnavailableError(`Memtro took longer than ${Math.round(TURN_TOTAL_MS / 60_000)} minutes on one step; gave up.`);
      throw new UnavailableError(`The connection to Memtro dropped part-way through the answer (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (request.signal.aborted) throw abortError();
    if (idled) throw new UnavailableError(`Memtro went quiet for ${Math.round(TURN_IDLE_MS / 1000)}s part-way through the answer; gave up.`);
    if (!done) throw new UnavailableError("The answer was cut off: the stream ended without finishing.");
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: "tool-call", call: { id: c.id || `call_${randomBytes(6).toString("hex")}`, name: c.name, arguments: c.arguments } };
    }
    yield { type: "finish", reason: finish, model: answeredBy ?? firstModel };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One forced function call (the classifier's transport)
// ---------------------------------------------------------------------------------------------------------------

interface CompletionBody {
  choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
}

/**
 * A `ForcedCall` over `/v1/chat/completions`, not streamed: temperature 0, the one tool forced by name, and
 * `memtro: { tools: false, retrieve: false, memory: "off" }` so nothing is retrieved into the judgement and
 * nothing from it is learned (facts F2). Resolves to the call's arguments, or null when the reply was anything
 * else (text, another tool, arguments that are not a JSON object). Rejects on a network failure, a timeout or a
 * refusal, which the caller treats as "no answer".
 */
export function forcedCallVia(client: ApiClient): ForcedCall {
  return async (request) => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
    const body = await client.json<CompletionBody>("/v1/chat/completions", {
      method: "POST",
      signal,
      body: {
        model: chatModelId(request.model),
        stream: false,
        temperature: 0,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        tools: wireTools([request.tool]),
        tool_choice: { type: "function", function: { name: request.tool.name } },
        memtro: { tools: false, retrieve: false, memory: "off" },
      },
    });
    return forcedArguments(body, request.tool.name);
  };
}

/** The named call's arguments from a non-streamed completion, or null. Pure. */
export function forcedArguments(body: unknown, name: string): Record<string, unknown> | null {
  const calls = (body as CompletionBody | null)?.choices?.[0]?.message?.tool_calls ?? [];
  const call = calls.find((c) => c.function?.name === name);
  if (!call || typeof call.function?.arguments !== "string") return null;
  try {
    const args = JSON.parse(call.function.arguments) as unknown;
    return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
