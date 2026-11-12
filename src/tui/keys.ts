/**
 * Raw keys while the agent is working.
 *
 * Between prompts the terminal is in raw mode so Esc and Ctrl-C reach the session as bytes rather than as a
 * signal, and whoever is listening (the running turn, or an approval prompt on top of it) gets them. Only the top
 * handler hears a key: the approval prompt's `n` must not also reach the turn.
 */

export type TtyIn = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };

export type KeyHandler = (chunk: string, at: number) => void;

export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

export class KeyRouter {
  private stack: KeyHandler[] = [];
  private attached = false;
  private lastAt: number | null = null;
  private readonly onData = (data: Buffer | string) => {
    const chunk = typeof data === "string" ? data : data.toString("utf8");
    const at = this.now();
    this.stack.at(-1)?.(chunk, at);
    this.lastAt = at;
  };

  constructor(
    private readonly input: TtyIn,
    private readonly now: () => number = Date.now,
  ) {}

  /** When the last chunk of input arrived (whoever heard it), or null if none has: approval timing starts from it. */
  get lastInputAt(): number | null {
    return this.lastAt;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  /** Raw mode on and listening. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.input.setRawMode?.(true);
    this.input.on("data", this.onData);
    this.input.resume();
  }

  /** Back to cooked mode, not listening. Idempotent. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.input.off("data", this.onData);
    this.input.setRawMode?.(false);
    this.input.pause();
  }

  /** Puts a handler on top; the returned function takes it off again. */
  push(handler: KeyHandler): () => void {
    this.stack.push(handler);
    return () => {
      const i = this.stack.lastIndexOf(handler);
      if (i >= 0) this.stack.splice(i, 1);
    };
  }
}

/** What a chunk of raw input means to a running turn: Esc alone, Ctrl-C, or nothing. Pasted text is nothing. */
export function interruptKey(chunk: string): "escape" | "ctrl-c" | null {
  if (chunk.includes(PASTE_START)) return null;
  if (chunk === "\u001b") return "escape";
  if (chunk === "\u0003") return "ctrl-c";
  return null;
}
