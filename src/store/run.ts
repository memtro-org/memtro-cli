import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with an argument array (never a shell) and hands it `input` on stdin.
 *
 * Secrets travel on stdin because the argument list of a running process is readable by every other user on the
 * machine (`ps -ww`), and the environment of one is readable by the same user and by root. Stdin is a pipe only
 * the two ends can see.
 */
export function runWithInput(command: string, args: readonly string[], input: string, timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} did not finish within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // A child that exits before reading everything raises EPIPE here; its exit code is the answer that matters.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
