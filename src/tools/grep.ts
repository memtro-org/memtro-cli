import { lstatSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Tool, ToolResult } from "../agent/types.js";
import { errnoText, fail, looksBinary, resolveIn } from "./common.js";
import { globMatcher, listFiles } from "./files.js";
import { shownPath } from "./glob.js";
import { summaryPaths, type ResolvedPath } from "./paths.js";
import { findExecutable, runProgram } from "./process.js";
import { head, kb, MAX_BYTES, MAX_LINES } from "./truncate.js";
import { bool, int, str, validated } from "./validate.js";

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  context?: number;
}

const MATCH_LINE_CHARS = 500;
/** The Node fallback skips files bigger than this. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function grepTool(): Tool<GrepArgs> {
  return {
    spec: {
      name: "grep",
      description:
        "Search file contents with a regular expression (ripgrep when installed, otherwise an equivalent search in JavaScript; keep to syntax both understand: no look-around or back-references). Returns `path:line:text` for each matching line, and `path-line-text` for context lines, with `--` between groups; paths relative to the working directory. Lines are cut at 500 characters. At most 2000 lines / 50 KB; the last line says how much more there was. Honours .gitignore and skips binary files, .git and node_modules. Use `glob` to narrow by file name.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The regular expression. Escape literal `.`, `(`, `[` and the like." },
          path: { type: "string", description: "A directory or file to search. Default: the working directory." },
          glob: { type: "string", description: "Only files whose name (or, with `/`, path) matches this glob, e.g. `*.ts`." },
          ignore_case: { type: "boolean", description: "Match without regard to case. Default false." },
          context: { type: "integer", minimum: 0, maximum: 10, description: "Lines of context before and after each match. Default 0." },
        },
        required: ["pattern"],
      },
    },
    validate: (raw) =>
      validated(raw, (o) => ({
        pattern: str(o, "pattern", { required: true, nonEmpty: true }),
        path: str(o, "path"),
        glob: str(o, "glob"),
        ignore_case: bool(o, "ignore_case"),
        context: int(o, "context", { min: 0, max: 10 }),
      })),
    risk: () => "read",
    summarise(args, ctx) {
      const r = resolveIn(args.path || ".", ctx);
      const where = args.path ? ` in ${r.display}` : "";
      const which = args.glob ? ` (${args.glob})` : "";
      return { title: `Search for /${args.pattern.length > 80 ? `${args.pattern.slice(0, 79)}…` : args.pattern}/${where}${which}`, paths: summaryPaths(r) };
    },
    async run(args, ctx) {
      const r = resolveIn(args.path || ".", ctx);
      let isDir: boolean;
      try {
        isDir = statSync(r.real).isDirectory();
      } catch (err) {
        return fail(`Cannot search ${r.display}: ${errnoText(err)}.`);
      }
      const rg = findExecutable("rg");
      const result = rg ? await withRipgrep(rg, args, r, ctx) : await withNode(args, r, isDir, ctx);
      if (ctx.signal.aborted) return fail("Interrupted.");
      return result;
    },
  };
}

function finish(lines: string[], extra: string[] = []): ToolResult {
  if (lines.length === 0) return { content: ["No matches.", ...extra].join("\n") };
  const cut = head(lines.join("\n"), MAX_LINES, MAX_BYTES);
  const notes = [...extra];
  if (cut.omittedLines > 0) notes.unshift(`[${cut.omittedLines} more line${cut.omittedLines === 1 ? "" : "s"} (${kb(cut.omittedBytes)}) not shown. Narrow the pattern, path or glob.]`);
  return { content: [cut.text, ...notes].join("\n") };
}

async function withRipgrep(rg: string, args: GrepArgs, r: ResolvedPath, ctx: { cwd: string; signal: AbortSignal }): Promise<ToolResult> {
  const argv = ["--line-number", "--no-heading", "--with-filename", "--color", "never", "--hidden", "--no-messages", "--glob", "!.git", "--glob", "!node_modules", "--max-columns", String(MATCH_LINE_CHARS), "--max-columns-preview"];
  if (args.ignore_case) argv.push("--ignore-case");
  if (args.context) argv.push("--context", String(args.context));
  if (args.glob) argv.push("--glob", args.glob);
  argv.push("--regexp", args.pattern);
  const rel = path.relative(ctx.cwd, r.absolute);
  const target = rel === "" ? null : rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? r.absolute : rel;
  if (target) argv.push("--", target);
  const out = await runProgram(rg, argv, { cwd: ctx.cwd, signal: ctx.signal, maxBytes: 8 * 1024 * 1024 });
  if (out.error) return fail(`ripgrep could not be started: ${out.error.message}.`);
  if (out.timedOut) return fail("The search took longer than 60 seconds and was stopped. Narrow the path or glob.");
  // 0 found, 1 nothing found, 2 an error (a bad pattern says so on stderr).
  if (out.code === 2 && !out.stdout) return fail(`The search failed: ${out.stderr.trim() || "ripgrep exited with an error"}.`);
  const lines = out.stdout.split("\n").filter((l) => l !== "");
  if (out.capped) lines.pop();
  return finish(lines, out.capped ? ["[The search produced more than 8 MB and was stopped there.]"] : []);
}

async function withNode(args: GrepArgs, r: ResolvedPath, isDir: boolean, ctx: { cwd: string; signal: AbortSignal }): Promise<ToolResult> {
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, args.ignore_case ? "i" : "");
  } catch (err) {
    return fail(`The pattern is not a valid regular expression: ${(err as Error).message}.`);
  }
  let files: { abs: string; shown: string }[];
  let truncatedList = false;
  if (!isDir) files = [{ abs: r.real, shown: shownPath(r.absolute, path.basename(r.absolute), r.absolute, r.absolute, ctx.cwd) }];
  else {
    const found = await listFiles(r.real, { signal: ctx.signal });
    truncatedList = found.truncated;
    const keep = args.glob ? globMatcher(args.glob) : () => true;
    files = found.files.filter(keep).map((rel) => ({ abs: path.join(r.real, rel), shown: shownPath(path.join(r.real, rel), rel, r.absolute, r.real, ctx.cwd) }));
  }
  const context = args.context ?? 0;
  const out: string[] = [];
  let bytes = 0;
  let stoppedEarly = false;
  for (const f of files) {
    if (ctx.signal.aborted) break;
    let buf: Buffer;
    try {
      // A link met while searching a directory is not followed, as ripgrep does not: it may lead out of the
      // workspace (`notes -> ~/.ssh/id_rsa`). A file named directly was resolved, and judged, already.
      if (isDir && lstatSync(f.abs).isSymbolicLink()) continue;
      if (statSync(f.abs).size > MAX_FILE_BYTES) continue;
      buf = readFileSync(f.abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    const hits: number[] = [];
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push(i);
    });
    if (hits.length === 0) continue;
    let lastPrinted = -2;
    const hitSet = new Set(hits);
    for (const h of hits) {
      const from = Math.max(0, h - context, lastPrinted + 1);
      const to = Math.min(lines.length - 1, h + context);
      if (context > 0 && out.length > 0 && from > lastPrinted + 1) out.push("--");
      for (let i = from; i <= to; i++) {
        const text = lines[i]!.length > MATCH_LINE_CHARS ? `${lines[i]!.slice(0, MATCH_LINE_CHARS)} [... ${lines[i]!.length - MATCH_LINE_CHARS} more characters]` : lines[i]!;
        const line = `${f.shown}${hitSet.has(i) ? ":" : "-"}${i + 1}${hitSet.has(i) ? ":" : "-"}${text}`;
        out.push(line);
        bytes += line.length + 1;
      }
      lastPrinted = Math.max(lastPrinted, to);
    }
    // Enough to fill the limit twice over: stop reading files, and say so.
    if (out.length > MAX_LINES * 2 || bytes > MAX_BYTES * 2) {
      stoppedEarly = true;
      break;
    }
  }
  const notes: string[] = [];
  if (stoppedEarly) notes.push("[The search stopped early; there are more matches in files not searched. Narrow the pattern, path or glob.]");
  if (truncatedList) notes.push("[Only the first 100000 files were searched.]");
  return finish(out, notes);
}
