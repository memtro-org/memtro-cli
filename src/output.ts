/**
 * Where output goes and what it looks like.
 *
 * Data on stdout, everything else on stderr, so `memtro search x --json | jq` never has a progress line in it.
 * Colour only on a terminal, never when NO_COLOR is set (https://no-color.org: any non-empty value), and never
 * for TERM=dumb. There are no spinners at all: a spinner on a pipe is noise in somebody's log file, and on a
 * terminal a line that says what is being waited for does the same job.
 */

export interface Streams {
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
}

export function colourAllowed(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv, forcedOff = false): boolean {
  if (forcedOff) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

export interface Paint {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
}

const wrap = (on: boolean, open: number, close: number) => (s: string) => (on ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export function paint(on: boolean): Paint {
  return {
    bold: wrap(on, 1, 22),
    dim: wrap(on, 2, 22),
    red: wrap(on, 31, 39),
    green: wrap(on, 32, 39),
    yellow: wrap(on, 33, 39),
  };
}

/** One JSON document, newline-terminated. Every `--json` answer goes through here. */
export function writeJson(out: NodeJS.WritableStream, value: unknown): void {
  out.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** A date for a person: `10 Feb 2027`. Null in, a dash out — never a guess. */
export function humanDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "in 90 days", "today", "3 days ago". */
export function relativeDays(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  return `${-days} day${days === -1 ? "" : "s"} ago`;
}

/** The key's expiry as one phrase: "never expires", "expires 10 Feb 2027 (in 90 days)", "expired 1 Jan 2026". */
export function expiryPhrase(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never expires";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `expires ${iso}`;
  const rel = relativeDays(iso, now);
  return d.getTime() <= now.getTime() ? `expired ${humanDate(iso)}` : `expires ${humanDate(iso)}${rel ? ` (${rel})` : ""}`;
}

/** First line of a description, cut to a width, for one-line listings. */
export function firstLine(text: string | undefined, width = 100): string {
  const line = (text ?? "").split("\n")[0]!.trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}
