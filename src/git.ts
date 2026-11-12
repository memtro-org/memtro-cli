import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The repository the command was run in, as `owner/name`, read from `.git/config` (pi-memtro's rule, kept the
 * same so Memtro sees the same project name from either client). Read from the file rather than by running git:
 * three lines of ini are not worth a subprocess on every `memtro ask`.
 */

/** The directory holding `.git` at or above `from`, or null. */
export function gitRoot(from: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

export function gitProject(from: string): string | null {
  const root = gitRoot(from);
  if (!root) return null;
  try {
    // A worktree or submodule has `.git` as a file pointing elsewhere; not worth chasing, as in pi-memtro.
    const config = readFileSync(join(root, ".git", "config"), "utf8");
    const url = /\[remote "origin"\][^[]*?\n\s*url\s*=\s*(\S+)/.exec(config)?.[1];
    return url ? ownerRepo(url) : null;
  } catch {
    return null;
  }
}

/** `owner/name` from any of the spellings a remote comes in. Null for anything that is not one. */
export function ownerRepo(url: string): string | null {
  const cleaned = url.trim().replace(/\.git$/, "");
  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(cleaned);
  const path = scp ? scp[1]! : cleaned.replace(/^[a-z+]+:\/\/[^/]*\//i, "");
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : null;
}

/**
 * A path as the repository spells it. `memtro why total.ts` run from `src/checkout/` means
 * `src/checkout/total.ts`; a path that does not exist here, or is outside the checkout, is passed through as
 * typed (it may be a stack-trace path, which Memtro's tool reads on its own terms).
 */
export function repoPath(input: string, cwd: string): string {
  const root = gitRoot(cwd);
  if (!root) return input;
  const absolute = isAbsolute(input) ? input : resolve(cwd, input);
  if (!existsSync(absolute)) return input;
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return input;
  return rel.split(sep).join("/");
}
