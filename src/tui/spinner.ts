import { oneLine } from "./sanitise.js";

/**
 * One line that says what is being waited for, redrawn in place. Terminal only: on a pipe it never draws, so a log
 * file has no frames in it. It draws only while nothing else is writing; every writer stops it first, and the
 * caller starts it again when the session is waiting once more.
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";
  private drawn = false;
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  constructor(
    private readonly out: NodeJS.WritableStream & { isTTY?: boolean; columns?: number },
    private readonly enabled: boolean,
    private readonly dim: (s: string) => string = (s) => s,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(label: string): void {
    if (!this.enabled) return;
    this.label = label;
    if (this.timer) return;
    this.timer = setInterval(() => this.draw(), 80);
    this.timer.unref();
    this.draw();
  }

  setLabel(label: string): void {
    this.label = label;
  }

  /** Clears the line it drew. Safe to call when it is not running. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.drawn) this.out.write("\r\u001b[2K");
    this.drawn = false;
  }

  private draw(): void {
    const width = Math.max(10, (this.out.columns ?? 80) - 4);
    const chars = Array.from(oneLine(this.label));
    const label = chars.length > width ? `${chars.slice(0, width - 1).join("")}…` : chars.join("");
    this.frame = (this.frame + 1) % this.frames.length;
    this.out.write(`\r\u001b[2K${this.dim(`${this.frames[this.frame]} ${label}`)}`);
    this.drawn = true;
  }
}
