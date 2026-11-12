import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findExecutable, runProgram } from "./process.js";

/**
 * Which files are under a directory, the way a person working in it would count them: `.gitignore` honoured,
 * `.git` and `node_modules` never descended. Asked of `rg --files` when it is on PATH, then `git ls-files` (in a
 * repository), then a walk in Node with a simple `.gitignore` reading. The same glob matcher is applied whatever
 * answered, so `glob` and `grep` mean the same thing on every machine.
 *
 * Paths come back relative to the directory asked about, with `/` separators.
 */

export const MAX_FILES = 100_000;
const ALWAYS_SKIPPED = new Set([".git", "node_modules"]);

export interface FileList {
  files: string[];
  /** More than MAX_FILES were found; the list stops there. */
  truncated: boolean;
  source: "rg" | "git" | "walk";
}

const skippedPath = (rel: string) => rel.split("/").some((seg) => ALWAYS_SKIPPED.has(seg));

export async function listFiles(root: string, opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<FileList> {
  const env = opts.env ?? process.env;
  const rg = findExecutable("rg", env);
  if (rg) {
    const r = await runProgram(rg, ["--files", "--hidden", "--no-messages", "--glob", "!.git", "--glob", "!node_modules"], { cwd: root, signal: opts.signal, maxBytes: 32 * 1024 * 1024 });
    // rg exits 1 when it found no files, which is an answer.
    if (!r.error && (r.code === 0 || r.code === 1 || r.capped)) return fromLines(r.stdout, "\n", r.capped, "rg");
  }
  const git = findExecutable("git", env);
  if (git) {
    const r = await runProgram(git, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, signal: opts.signal, maxBytes: 32 * 1024 * 1024 });
    if (!r.error && (r.code === 0 || r.capped)) {
      const list = fromLines(r.stdout, "\0", r.capped, "git");
      // `--cached` still names a tracked file deleted from the working tree.
      list.files = list.files.filter((f) => exists(path.join(root, f)));
      return list;
    }
  }
  opts.signal?.throwIfAborted();
  return walk(root);
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function fromLines(text: string, sep: string, capped: boolean, source: FileList["source"]): FileList {
  const parts = text.split(sep).filter(Boolean);
  if (capped) parts.pop(); // the last may be cut mid-name
  const files = parts.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")).filter((f) => !skippedPath(f));
  const truncated = capped || files.length > MAX_FILES;
  return { files: files.slice(0, MAX_FILES), truncated, source };
}

/** The Node fallback: breadth first, symlinked directories not followed (they can loop), `.gitignore` read per directory. */
export function walk(root: string): FileList {
  const files: string[] = [];
  const queue: { dir: string; rel: string; ignores: IgnoreRule[] }[] = [{ dir: root, rel: "", ignores: [] }];
  while (queue.length) {
    const { dir, rel, ignores: inherited } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let ignores = inherited;
    try {
      ignores = [...inherited, ...parseGitignore(readFileSync(path.join(dir, ".gitignore"), "utf8"), rel)];
    } catch {
      // no .gitignore here
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (ALWAYS_SKIPPED.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (ignored(ignores, childRel, isDir)) continue;
      if (isDir) queue.push({ dir: path.join(dir, e.name), rel: childRel, ignores });
      else {
        files.push(childRel);
        if (files.length >= MAX_FILES) return { files, truncated: true, source: "walk" };
      }
    }
  }
  return { files, truncated: false, source: "walk" };
}

// ---------------------------------------------------------------------------------------------------------------
// Globs and .gitignore
// ---------------------------------------------------------------------------------------------------------------

/**
 * A glob as a regular expression over `/`-separated paths: `*` and `?` within one name, `**` across names,
 * `[abc]` / `[!abc]`, `{a,b}`. Everything else literal.
 */
export function globToRegExp(glob: string, opts: { ignoreCase?: boolean } = {}): RegExp {
  let re = "";
  let inBraces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        const atStart = i === 0 || glob[i - 1] === "/";
        if (atStart && slashAfter) {
          re += "(?:[^/]*/)*"; // `**/`: any number of directories, including none
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) re += "\\[";
      else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else if (c === "{") {
      inBraces++;
      re += "(?:";
    } else if (c === "}" && inBraces > 0) {
      inBraces--;
      re += ")";
    } else if (c === "," && inBraces > 0) re += "|";
    else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  while (inBraces-- > 0) re += ")";
  return new RegExp(`^${re}$`, opts.ignoreCase ? "i" : "");
}

/**
 * A matcher for a glob the model gave. With no `/` it matches the file's name anywhere (`*.ts`), as rg and
 * .gitignore do; with one it matches the path from the search directory (`src/**\/*.ts`).
 */
export function globMatcher(glob: string): (rel: string) => boolean {
  const cleaned = glob.replace(/^\.\//, "");
  const re = globToRegExp(cleaned.replace(/^\//, ""));
  if (!cleaned.includes("/")) return (rel) => re.test(rel.slice(rel.lastIndexOf("/") + 1));
  return (rel) => re.test(rel);
}

export interface IgnoreRule {
  /** The directory of the .gitignore, relative to the walk's root ("" for the root). */
  base: string;
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** Matched against the whole path from `base` rather than the name alone. */
  anchored: boolean;
}

/** The lines of a .gitignore as rules. Comments, blanks, `!`, a trailing `/`, a leading or inner `/`. */
export function parseGitignore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    if (line.startsWith("\\")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    if (!line) continue;
    rules.push({ base, re: globToRegExp(line), negate, dirOnly, anchored });
  }
  return rules;
}

/** Last matching rule wins, as git has it. */
export function ignored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let result = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.base && !rel.startsWith(`${r.base}/`)) continue;
    const local = r.base ? rel.slice(r.base.length + 1) : rel;
    const subject = r.anchored ? local : local.slice(local.lastIndexOf("/") + 1);
    if (r.re.test(subject)) result = !r.negate;
  }
  return result;
}
