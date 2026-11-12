import { statSync } from "node:fs";
import type { Tool } from "../agent/types.js";
import { errnoText, fail, plural, resolveIn } from "./common.js";
import { listFiles } from "./files.js";
import { summaryPaths } from "./paths.js";
import { int, str, validated } from "./validate.js";

export interface ListArgs {
  path?: string;
  depth?: number;
}

export const MAX_ENTRIES = 500;

/**
 * The entries to show for `files` (relative, `/`-separated) down to `depth` levels. A directory at the last level
 * shown says how many files are below it. Pure.
 */
export function treeEntries(files: string[], depth: number): string[] {
  const dirs = new Map<string, number>(); // directory at the boundary → files below it
  const entries = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length && i <= depth; i++) entries.add(`${parts.slice(0, i).join("/")}/`);
    if (parts.length <= depth) entries.add(f);
    else {
      const boundary = `${parts.slice(0, depth).join("/")}/`;
      dirs.set(boundary, (dirs.get(boundary) ?? 0) + 1);
    }
  }
  return [...entries].sort().map((e) => (dirs.has(e) ? `${e} (${plural(dirs.get(e)!, "file")})` : e));
}

export function listTool(): Tool<ListArgs> {
  return {
    spec: {
      name: "list",
      description:
        "List the files under a directory as paths relative to it, directories ending in `/`, down to `depth` levels (default 2, maximum 6); a directory at the last level shown says how many files it holds. Honours .gitignore and never shows .git or node_modules, so empty and ignored directories do not appear. At most 500 entries; the last line says how many more there were. Use `glob` to find files by name and `grep` to find them by content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The directory. Default: the working directory." },
          depth: { type: "integer", minimum: 1, maximum: 6, description: "How many levels to show. Default 2." },
        },
      },
    },
    validate: (raw) => validated(raw, (o) => ({ path: str(o, "path"), depth: int(o, "depth", { min: 1, max: 6 }) })),
    risk: () => "read",
    summarise(args, ctx) {
      const r = resolveIn(args.path || ".", ctx);
      return { title: `List ${r.display}`, paths: summaryPaths(r) };
    },
    async run(args, ctx) {
      const r = resolveIn(args.path || ".", ctx);
      try {
        if (!statSync(r.real).isDirectory()) return fail(`${r.display} is a file, not a directory. Use \`read\` to see it.`);
      } catch (err) {
        return fail(`Cannot list ${r.display}: ${errnoText(err)}.`);
      }
      let found;
      try {
        found = await listFiles(r.real, { signal: ctx.signal });
      } catch (err) {
        if (ctx.signal.aborted) return fail("Interrupted.");
        return fail(`Cannot list ${r.display}: ${errnoText(err)}.`);
      }
      if (ctx.signal.aborted) return fail("Interrupted.");
      const entries = treeEntries(found.files, args.depth ?? 2);
      if (entries.length === 0) return { content: `${r.display} has no files (after .gitignore, .git and node_modules are left out).` };
      const shown = entries.slice(0, MAX_ENTRIES);
      const notes: string[] = [];
      if (entries.length > MAX_ENTRIES) notes.push(`[${entries.length - MAX_ENTRIES} more entries not shown. List a subdirectory, or lower depth.]`);
      if (found.truncated) notes.push(`[The directory holds more than ${found.files.length} files; only those were counted.]`);
      return { content: [`${r.display}/`, ...shown, ...notes].join("\n") };
    },
  };
}
