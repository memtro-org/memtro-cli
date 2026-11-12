/**
 * Server-sent events, parsed incrementally (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 *
 * Chunks arrive split anywhere — mid-line, mid-UTF-8 sequence, between the `\r` and `\n` of a CRLF — so the
 * parser keeps a buffer and only emits an event at a blank line. Only `data` (joined with newlines when an event
 * has several) and `event` are kept; comments (`:`) and `id`/`retry` are not needed here.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private readonly decoder = new TextDecoder();

  /** Feed bytes or text; returns the events completed by it. */
  push(chunk: Uint8Array | string): SseEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone `\r` at the very end may be the first half of a CRLF still in flight.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event) out.push(event);
    }
    return out;
  }

  /** At end of stream: an event without its terminating blank line is dropped, as the spec says. */
  end(): SseEvent[] {
    this.buffer += this.decoder.decode();
    return [];
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const ev = { event: this.event || "message", data: this.data.join("\n") };
      this.data = [];
      this.event = "";
      return ev;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    return null;
  }
}

/**
 * Reads a response body as SSE, with an idle timeout: if nothing at all arrives for `idleMs`, the stream is
 * abandoned. An overall deadline alone would let a dead connection hang for the whole half hour an agent run is
 * allowed; an idle limit catches it in minutes and still lets a long run that keeps talking finish.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, opts: { idleMs: number; onIdle: () => void }): AsyncGenerator<SseEvent> {
  const parser = new SseParser();
  const reader = body.getReader();
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      opts.onIdle();
      reader.cancel().catch(() => {});
    }, opts.idleMs);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      for (const ev of parser.push(value)) yield ev;
    }
    for (const ev of parser.end()) yield ev;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // Already released by a cancel; nothing left to free.
    }
  }
}
