import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { PASTE_END, PASTE_START, type TtyIn } from "./keys.js";

/**
 * The prompt the person types at, on `node:readline`.
 *
 * Enter sends. A line ending in `\` carries on onto the next line, and pasted text (bracketed paste) keeps its
 * newlines rather than sending each line. Ctrl-D on an empty line, or Ctrl-C twice within two seconds, leaves;
 * Ctrl-C once clears what was typed. History is kept per directory beside the sessions, owner-only, because what
 * people type at a coding agent includes things they would not post.
 */

export const HISTORY_KEEP = 500;
export const DOUBLE_PRESS_MS = 2000;

/** `<state>/memtro/history/<hash of cwd>.jsonl`, beside `<state>/memtro/sessions`. */
export function historyFile(sessionsDir: string, cwd: string): string {
  const id = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(dirname(sessionsDir), "history", `${id}.jsonl`);
}

/** Entries oldest first. A torn or foreign line is skipped, never fatal. */
export function parseHistory(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (typeof v === "string" && v.trim()) out.push(v);
    } catch {
      // skipped
    }
  }
  return out;
}

export function loadHistory(file: string): string[] {
  try {
    return parseHistory(readFileSync(file, "utf8")).slice(-HISTORY_KEEP);
  } catch {
    return [];
  }
}

/** Appends one entry; rewrites the file when it has grown to twice what is kept. Failures are silent: history is a convenience. */
export function saveHistoryEntry(file: string, entry: string, all: string[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dirname(file), 0o700);
    if (all.length >= HISTORY_KEEP * 2) {
      writeFileSync(file, all.slice(-HISTORY_KEEP).map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
    } else {
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } catch {
    // A read-only home directory is not a reason to stop the session.
  }
}

/**
 * Whether a submitted text belongs in history: single lines only, not one starting with a space (the shell's
 * rule), and never one holding a Memtro key somebody pasted.
 */
export function keepInHistory(text: string): boolean {
  return Boolean(text.trim()) && !text.includes("\n") && !text.startsWith(" ") && !/sk-(memtro|brain)-/i.test(text);
}

export interface ComposerOptions {
  input: TtyIn;
  output: NodeJS.WritableStream;
  /** null: no history file (tests, or a state directory that cannot be found). */
  historyPath: string | null;
  prompt: string;
  continuation: string;
  /** Printed after a first Ctrl-C on an empty prompt. */
  hint: (text: string) => string;
  now?: () => number;
}

export class Composer {
  /** Newest first, as readline keeps it. */
  private history: string[];
  private oldestFirst: string[];
  private lastInterrupt = 0;

  constructor(private readonly o: ComposerOptions) {
    this.oldestFirst = o.historyPath ? loadHistory(o.historyPath) : [];
    this.history = [...this.oldestFirst].reverse();
  }

  /** The next thing the person sends, or null when they leave. */
  read(): Promise<string | null> {
    const o = this.o;
    const now = o.now ?? Date.now;
    return new Promise((resolve) => {
      const rl = createInterface({
        input: o.input,
        output: o.output,
        terminal: true,
        history: [...this.history],
        historySize: HISTORY_KEEP,
        removeHistoryDuplicates: true,
        prompt: o.prompt,
      });
      const parts: string[] = [];
      let pasting = false;
      let done = false;

      const onKey = (_s: string | undefined, key: { name?: string; sequence?: string } | undefined) => {
        if (key?.name === "paste-start" || key?.sequence === PASTE_START) pasting = true;
        else if (key?.name === "paste-end" || key?.sequence === PASTE_END) pasting = false;
      };
      o.input.on("keypress", onKey);

      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        o.input.off("keypress", onKey);
        rl.close();
        if (value !== null && keepInHistory(value)) this.remember(value);
        resolve(value);
      };

      rl.on("line", (line) => {
        if (pasting) {
          parts.push(line);
          return;
        }
        if (line.endsWith("\\")) {
          parts.push(line.slice(0, -1));
          rl.setPrompt(o.continuation);
          rl.prompt();
          return;
        }
        parts.push(line);
        finish(parts.join("\n"));
      });
      rl.on("SIGINT", () => {
        const t = now();
        if (t - this.lastInterrupt < DOUBLE_PRESS_MS) {
          o.output.write("\n");
          finish(null);
          return;
        }
        this.lastInterrupt = t;
        const hadText = parts.length > 0 || rl.line.length > 0;
        parts.length = 0;
        // Clear what was typed: to the end of the line, then everything before the cursor.
        rl.write(null, { ctrl: true, name: "e" });
        rl.write(null, { ctrl: true, name: "u" });
        o.output.write(`\n${o.hint(hadText ? "Cleared. Ctrl-C again to quit." : "Ctrl-C again (or Ctrl-D) to quit.")}\n`);
        rl.setPrompt(o.prompt);
        rl.prompt();
      });
      rl.on("close", () => finish(null));
      rl.prompt();
    });
  }

  private remember(entry: string): void {
    this.history = [entry, ...this.history.filter((h) => h !== entry)].slice(0, HISTORY_KEEP);
    this.oldestFirst.push(entry);
    if (this.o.historyPath) saveHistoryEntry(this.o.historyPath, entry, this.oldestFirst);
    if (this.oldestFirst.length >= HISTORY_KEEP * 2) this.oldestFirst = this.oldestFirst.slice(-HISTORY_KEEP);
  }
}

/** One line of text in cooked mode (the approval prompt's note, a number from a list). Empty on Ctrl-C or Ctrl-D. */
export function readOneLine(input: TtyIn, output: NodeJS.WritableStream, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: Boolean(input.isTTY), historySize: 0 });
    let settled = false;
    const done = (v: string) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(v);
    };
    rl.on("SIGINT", () => {
      output.write("\n");
      done("");
    });
    rl.on("close", () => done(""));
    rl.question(prompt, (answer) => done(answer));
  });
}
