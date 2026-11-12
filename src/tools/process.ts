import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { childEnv } from "./bash.js";

/**
 * Running a helper program (`rg`, `git`) for a search tool: always an argument array, never a shell, so nothing
 * the model typed is ever parsed as shell syntax. Output is capped; the program is stopped when the cap is hit,
 * the time runs out or the turn is interrupted.
 */

/** The program's path when it is on PATH, otherwise null. Looked up each time, so a test can change PATH. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export interface ProgramResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** The output cap was reached and the program was stopped there. */
  capped: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the program could not be started at all. */
  error?: Error;
}

export function runProgram(
  file: string,
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv },
): Promise<ProgramResult> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let capped = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env ?? childEnv(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs ?? 60_000);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: Omit<ProgramResult, "stdout" | "stderr" | "capped" | "timedOut" | "aborted">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: err, capped, timedOut, aborted, ...r });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (capped) return;
      if (outBytes + chunk.length > maxBytes) {
        out.push(chunk.subarray(0, maxBytes - outBytes));
        outBytes = maxBytes;
        capped = true;
        stop();
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < 64 * 1024) err += chunk.toString("utf8");
    });
    child.on("error", (e) => finish({ code: null, error: e }));
    child.on("close", (code) => finish({ code }));
  });
}
