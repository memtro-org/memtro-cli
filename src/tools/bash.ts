import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Tool, ToolResult } from "../agent/types.js";
import { fail } from "./common.js";
import { kb, MAX_BYTES, MAX_LINES, tail } from "./truncate.js";
import { int, str, validated } from "./validate.js";

export interface BashArgs {
  command: string;
  timeout_ms?: number;
  description?: string;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/** Between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 2_000;
/** After the shell exits, how long a background child may keep the output open before it is stopped. */
const LINGER_MS = 500;

/** A Memtro key anywhere in a value (`Bearer sk-memtro-…`, a URL with it in, a quoted copy). */
const KEY_VALUE = /sk-(memtro|brain)-/i;
const KEY_NAME = /^MEMTRO_.*(KEY|TOKEN|SECRET)/i;

/**
 * The environment a command gets: this process's, without any Memtro credential.
 *
 * By name: `MEMTRO_API_KEY`, `MEMTRO_CREDENTIALS`, any `MEMTRO_…KEY/TOKEN/SECRET`, any `…_MEMTRO_KEY` (what a
 * profile's `keyEnv` tends to be called). By value: anything holding a Memtro key, whatever the variable is
 * called, because a profile can name any variable. The model chose the command; it does not get the key.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (upper === "MEMTRO_API_KEY" || upper === "MEMTRO_CREDENTIALS") continue;
    if (KEY_NAME.test(name) || /MEMTRO.*_KEY$/i.test(name)) continue;
    if (KEY_VALUE.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/** The shell and its arguments, as an array: `/bin/bash -c`, `/bin/sh -c`, or `cmd.exe /d /s /c` on Windows. */
export function shellFor(command: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): { file: string; args: string[] } {
  if (platform === "win32") return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { file: exists("/bin/bash") ? "/bin/bash" : "/bin/sh", args: ["-c", command] };
}

/** Keeps the end of a stream of text in bounded memory, counting what fell off the front. */
export class TailKeeper {
  private chunks: string[] = [];
  private size = 0;
  droppedBytes = 0;
  droppedLines = 0;
  constructor(private readonly keep = MAX_BYTES * 4) {}

  push(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > this.keep && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
      this.droppedBytes += Buffer.byteLength(first, "utf8");
      this.droppedLines += (first.match(/\n/g) ?? []).length;
    }
  }

  /** The kept tail, cut to the model's limit, with the total cut counted. */
  finish(): { text: string; omittedLines: number; omittedBytes: number } {
    const whole = this.chunks.join("");
    const cut = tail(whole.endsWith("\n") ? whole.slice(0, -1) : whole, MAX_LINES, MAX_BYTES);
    return { text: cut.text, omittedLines: cut.omittedLines + this.droppedLines, omittedBytes: cut.omittedBytes + this.droppedBytes };
  }
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // No process groups: taskkill walks the tree. /F has no gentle form, so both signals mean the same.
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } catch {
      // nothing more to do
    }
    return;
  }
  try {
    process.kill(-child.pid, signal); // the whole group: the shell and everything it started
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export function bashTool(): Tool<BashArgs> {
  return {
    spec: {
      name: "bash",
      description:
        "Run one shell command in the working directory (bash -c; cmd.exe on Windows) and return its combined stdout and stderr with the exit code. No stdin: interactive commands fail or hang until the timeout. Default timeout 120000 ms, maximum 600000; the command and everything it started are stopped at the timeout. Only the last 2000 lines / 50 KB of output are returned, with a note saying how much was cut, so pipe noisy commands through `tail`/`grep` or write to a file and `read` it. A non-zero exit is reported, not treated as a failure of the tool. Use `read`, `grep`, `glob` and `list` rather than cat/grep/find here. Memtro credentials are not in the environment.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line, exactly as it should run." },
          timeout_ms: { type: "integer", minimum: 1000, maximum: MAX_TIMEOUT_MS, description: `Milliseconds before the command is stopped. Default ${DEFAULT_TIMEOUT_MS}.` },
          description: { type: "string", description: "A few words saying what the command is for, shown to the person." },
        },
        required: ["command"],
      },
    },
    validate: (raw) =>
      validated(raw, (o) => ({
        command: str(o, "command", { required: true, nonEmpty: true }),
        timeout_ms: int(o, "timeout_ms", { min: 1000, max: MAX_TIMEOUT_MS }),
        description: str(o, "description"),
      })),
    risk: () => "execute",
    summarise(args) {
      const oneLine = args.command.split("\n")[0]!;
      const shown = oneLine.length > 120 || args.command.includes("\n") ? `${oneLine.slice(0, 117)}…` : oneLine;
      return { title: args.description ? `Run \`${shown}\` (${args.description.slice(0, 80)})` : `Run \`${shown}\``, command: args.command };
    },
    run(args, ctx) {
      return runCommand(args.command, { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: args.timeout_ms ?? DEFAULT_TIMEOUT_MS, onProgress: ctx.onProgress });
    },
  };
}

export function runCommand(
  command: string,
  opts: { cwd: string; signal: AbortSignal; timeoutMs: number; onProgress?: (text: string) => void; env?: NodeJS.ProcessEnv; graceMs?: number },
): Promise<ToolResult> {
  if (opts.signal.aborted) return Promise.resolve(fail("Interrupted before the command started; it did not run."));
  const { file, args } = shellFor(command);
  const grace = opts.graceMs ?? KILL_GRACE_MS;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: childEnv(opts.env ?? process.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      resolve(fail(`The command could not be started: ${err instanceof Error ? err.message : String(err)}.`));
      return;
    }
    const keeper = new TailKeeper();
    let stopping: "timeout" | "interrupt" | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    let lingerTimer: NodeJS.Timeout | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let lingered = false;
    let settled = false;

    const stop = (why: "timeout" | "interrupt") => {
      if (stopping || exit) return;
      stopping = why;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), grace);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    const onAbort = () => stop("interrupt");
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    const take = (text: string) => {
      if (!text) return;
      keeper.push(text);
      try {
        opts.onProgress?.(text);
      } catch {
        // display only
      }
    };
    child.stdout!.on("data", (b: Buffer) => take(decoders.out.write(b)));
    child.stderr!.on("data", (b: Buffer) => take(decoders.err.write(b)));

    const finish = (startError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(lingerTimer);
      opts.signal.removeEventListener("abort", onAbort);
      // The group is stopped, finally; SIGKILL after SIGTERM is left to run out its grace.
      if (!stopping) clearTimeout(killTimer);
      if (startError) {
        resolve(fail(`The command could not be started: ${startError.message}.`));
        return;
      }
      take(decoders.out.end());
      take(decoders.err.end());
      const out = keeper.finish();
      const code = exit?.code ?? null;
      const sig = exit?.signal ?? null;
      const lines: string[] = [];
      if (out.omittedLines > 0 || out.omittedBytes > 0) lines.push(`[Output cut: the first ${out.omittedLines} line${out.omittedLines === 1 ? "" : "s"} (${kb(out.omittedBytes)}) are not shown; this is the end of the output.]`);
      lines.push(out.text === "" ? "(no output)" : out.text);
      let status: string;
      if (stopping === "timeout") status = `[Timed out after ${opts.timeoutMs} ms; the command and its children were stopped.]`;
      else if (stopping === "interrupt") status = "[Interrupted by the person; the command and its children were stopped.]";
      else if (sig) status = `[Killed by ${sig}.]`;
      else status = `[Exit code ${code}.]`;
      if (lingered) status += " [Background processes still holding the output after the shell exited were stopped.]";
      lines.push(status);
      resolve({
        content: lines.join("\n"),
        isError: stopping === "interrupt" ? true : undefined,
        display: { kind: "command", command, exitCode: code, output: out.text },
      });
    };

    child.on("error", (err) => finish(err));
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // A background child can hold the pipes open after the shell has gone; give it a moment, then stop it.
      lingerTimer = setTimeout(() => {
        lingered = true;
        killTree(child, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, LINGER_MS);
    });
    child.on("close", () => finish());
  });
}
