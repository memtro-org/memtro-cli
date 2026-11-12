import { statSync } from "node:fs";
import path from "node:path";
import type { Tool } from "../agent/types.js";
import { errnoText, fail, resolveIn } from "./common.js";
import { globMatcher, listFiles } from "./files.js";
import { summaryPaths } from "./paths.js";
import { str, validated } from "./validate.js";

export interface GlobArgs {
  pattern: string;
  path?: string;
}

export const MAX_GLOB_RESULTS = 200;
/** Matches beyond this are counted but not stat'ed for their age. */
const MAX_STAT = 5000;

export function globTool(): Tool<GlobArgs> {
  return {
    spec: {
      name: "glob",
      description:
        "Find files by name pattern. `*` and `?` match within a name, `**` across directories, `{a,b}` either, `[abc]` one of. A pattern without `/` matches the file name anywhere (`*.test.ts`); with `/` it matches the path from the search directory (`src/**/*.ts`). Returns paths relative to the working directory, most recently modified first, at most 200; the last line says how many more matched. Honours .gitignore; never looks in .git or node_modules.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The glob, e.g. `**/*.ts` or `package.json`." },
          path: { type: "string", description: "The directory to search. Default: the working directory." },
        },
        required: ["pattern"],
      },
    },
    validate: (raw) => validated(raw, (o) => ({ pattern: str(o, "pattern", { required: true, nonEmpty: true }), path: str(o, "path") })),
    risk: () => "read",
    summarise(args, ctx) {
      const r = resolveIn(args.path || ".", ctx);
      return { title: `Find files matching ${args.pattern}${args.path ? ` in ${r.display}` : ""}`, paths: summaryPaths(r) };
    },
    async run(args, ctx) {
      const r = resolveIn(args.path || ".", ctx);
      try {
        if (!statSync(r.real).isDirectory()) return fail(`${r.display} is not a directory.`);
      } catch (err) {
        return fail(`Cannot search ${r.display}: ${errnoText(err)}.`);
      }
      let found;
      try {
        found = await listFiles(r.real, { signal: ctx.signal });
      } catch (err) {
        if (ctx.signal.aborted) return fail("Interrupted.");
        return fail(`Cannot search ${r.display}: ${errnoText(err)}.`);
      }
      if (ctx.signal.aborted) return fail("Interrupted.");
      const matches = globMatcher(args.pattern);
      const hits = found.files.filter(matches);
      if (hits.length === 0) return { content: `No files under ${r.display} match ${args.pattern}.${found.truncated ? ` (Only the first ${found.files.length} files were looked at.)` : ""}` };
      const dated = hits.slice(0, MAX_STAT).map((rel) => {
        const abs = path.join(r.real, rel);
        let mtime = 0;
        try {
          mtime = statSync(abs).mtimeMs;
        } catch {
          // vanished; sorts last
        }
        return { shown: shownPath(abs, rel, r.absolute, r.real, ctx.cwd), mtime };
      });
      dated.sort((a, b) => b.mtime - a.mtime || (a.shown < b.shown ? -1 : 1));
      const lines = dated.slice(0, MAX_GLOB_RESULTS).map((d) => d.shown);
      if (hits.length > MAX_GLOB_RESULTS) lines.push(`[${hits.length - MAX_GLOB_RESULTS} more files matched and are not shown. Narrow the pattern or the path.]`);
      if (found.truncated) lines.push(`[Only the first ${found.files.length} files under ${r.display} were looked at.]`);
      return { content: lines.join("\n") };
    },
  };
}

/** A hit, relative to the working directory when it is below it, absolute otherwise. */
export function shownPath(abs: string, rel: string, typedRoot: string, realRoot: string, cwd: string): string {
  // Spell it from the directory as the model named it, so a symlinked checkout keeps the names the model knows.
  const named = typedRoot === realRoot ? abs : path.join(typedRoot, rel);
  const fromCwd = path.relative(cwd, named);
  const below = fromCwd !== "" && fromCwd !== ".." && !fromCwd.startsWith(`..${path.sep}`) && !path.isAbsolute(fromCwd);
  return below ? fromCwd.split(path.sep).join("/") : named;
}
