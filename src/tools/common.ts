import type { ToolContext, ToolResult } from "../agent/types.js";
import { resolvePath, type ResolvedPath } from "./paths.js";

export type Where = Pick<ToolContext, "cwd" | "workspaceRoot">;

export const resolveIn = (input: string, ctx: Where): ResolvedPath => resolvePath(input, { cwd: ctx.cwd, workspaceRoot: ctx.workspaceRoot });

export const fail = (content: string): ToolResult => ({ content, isError: true });

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** A file is treated as binary when its first 8 KB hold a NUL byte, as git and grep decide it. */
export function looksBinary(sample: Buffer): boolean {
  return sample.subarray(0, 8192).includes(0);
}

export function errnoText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "it does not exist";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "EISDIR") return "it is a directory";
  if (code === "ENOTDIR") return "a part of the path is not a directory";
  return err instanceof Error ? err.message : String(err);
}

/**
 * Where a write's path resolved when it was summarised, which is what the gate judged and the person saw. A link
 * swapped in between (by a background process, say) must not move the write somewhere nobody approved, so `run`
 * refuses when the path now resolves elsewhere. Keyed by the arguments object, which the loop passes to both.
 */
const judged = new WeakMap<object, string>();

export function noteJudged(args: object, r: ResolvedPath): void {
  judged.set(args, r.real);
}

export function movedSinceJudged(args: object, r: ResolvedPath): string | null {
  const was = judged.get(args);
  if (was === undefined || was === r.real) return null;
  return `${r.display} now leads to ${r.real}, not ${was} as it did when this call was checked. Nothing was changed; make the call again.`;
}
