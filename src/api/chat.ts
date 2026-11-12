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
