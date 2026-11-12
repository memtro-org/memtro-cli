import { readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Project instructions: `AGENTS.md` and `CLAUDE.md` in each directory from the workspace root down to `cwd`,
 * outermost first, so the nearer file is read last and can refine the outer one. Each is capped; a file that
 * cannot be read is skipped (a broken symlink should not stop a session).
 */

export const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Per file. A project's instructions longer than this are a document, not instructions. */
export const CONTEXT_FILE_MAX_BYTES = 32 * 1024;

export interface ContextFile {
  path: string;
  content: string;
  truncated: boolean;
}

/** The directories from `root` down to `cwd`, outermost first; just `cwd` when it is not inside `root`. */
export function dirsFromRoot(root: string, cwd: string): string[] {
  const r = resolve(root);
  const c = resolve(cwd);
  const rel = relative(r, c);
  if (rel.startsWith("..") || resolve(r, rel) !== c) return [c];
  const dirs = [r];
  let at = r;
  for (const part of rel.split(sep).filter(Boolean)) {
    at = join(at, part);
    dirs.push(at);
  }
  return dirs;
}

export function findContextFiles(workspaceRoot: string, cwd: string, maxBytes = CONTEXT_FILE_MAX_BYTES): ContextFile[] {
  const out: ContextFile[] = [];
  for (const dir of dirsFromRoot(workspaceRoot, cwd)) {
    for (const name of CONTEXT_FILE_NAMES) {
      const path = join(dir, name);
      try {
        if (!statSync(path).isFile()) continue;
        const bytes = readFileSync(path);
        const truncated = bytes.length > maxBytes;
        // Cut on a byte budget, then drop a split character at the end rather than send a replacement glyph.
        const content = (truncated ? bytes.subarray(0, maxBytes) : bytes).toString("utf8").replace(/�$/, "");
        if (content.trim()) out.push({ path, content, truncated });
      } catch {
        // Missing or unreadable: nothing to add.
      }
    }
  }
  return out;
}
