import { readFileSync, statSync } from "node:fs";
import type { Tool } from "../agent/types.js";
import { detectEol, fromLf, toLf, writeAtomic } from "./atomic.js";
import { errnoText, fail, looksBinary, movedSinceJudged, noteJudged, plural, resolveIn } from "./common.js";
import { diffStat, unifiedDiff } from "./diff.js";
import { summaryPaths, type ResolvedPath } from "./paths.js";
import type { ReadLedger } from "./read-ledger.js";
import { bool, str, validated } from "./validate.js";

export interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export type EditPlan = { ok: true; after: string; count: number } | { ok: false; error: string };

/**
 * The edit, worked out on a string. Pure, so `summarise` can show the diff without writing and the refusals are
 * tested without a disk.
 *
 * Line endings: an exact match is used as it stands; in a CRLF file a match written with bare LFs (which is how
 * models write) is tried with CRLFs as well, and the replacement is given the file's line ending. The file's
 * final newline is kept even when `old_string` ran through it.
 */
export function planEdit(content: string, oldString: string, newString: string, replaceAll: boolean, name: string): EditPlan {
  if (oldString === newString) return { ok: false, error: "old_string and new_string are identical, so there is nothing to change." };
  const eol = detectEol(content);
  let find = oldString;
  let replace = eol === "\r\n" ? fromLf(toLf(newString), eol) : newString;
  let count = occurrences(content, find);
  if (count === 0 && eol === "\r\n") {
    find = fromLf(toLf(oldString), eol);
    if (find !== oldString) count = occurrences(content, find);
  }
  if (count === 0) {
    const trimmed = oldString.trim();
    const hint = trimmed && trimmed !== oldString && content.includes(trimmed) ? " It does appear with different leading or trailing whitespace; copy it exactly from `read` output (without the line-number prefix)." : " Read the file again and copy the text exactly, including indentation, without the line-number prefix.";
    return { ok: false, error: `old_string was not found in ${name}.${hint}` };
  }
  if (count > 1 && !replaceAll) return { ok: false, error: `old_string was found ${count} times in ${name}. Add surrounding lines to make it unique, or set replace_all to change all ${count}.` };
  let after: string;
  if (replaceAll) after = content.split(find).join(replace);
  else {
    const at = content.indexOf(find);
    after = content.slice(0, at) + replace + content.slice(at + find.length);
  }
  if (content.endsWith("\n") && after.length > 0 && !after.endsWith("\n")) after += eol;
  if (after === content) return { ok: false, error: "The edit would leave the file exactly as it is." };
  return { ok: true, after, count: replaceAll ? count : 1 };
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** Why the read-first rule refuses, in words the model can act on. */
export function readFirstRefusal(reason: "not-read" | "changed" | "missing", r: ResolvedPath, verb: string): string {
  if (reason === "not-read") return `${r.display} has not been read in this session. Read it with \`read\` first, then ${verb} it.`;
  if (reason === "changed") return `${r.display} has changed on disk since it was read (its modification time or size differs). Read it again, then ${verb} it.`;
  return `${r.display} no longer exists; it was removed after it was read.`;
}

export function editTool(ledger: ReadLedger): Tool<EditArgs> {
  const load = (r: ResolvedPath): { ok: true; content: string } | { ok: false; error: string } => {
    try {
      const st = statSync(r.real);
      if (st.isDirectory()) return { ok: false, error: `${r.display} is a directory.` };
      const buf = readFileSync(r.real);
      if (looksBinary(buf)) return { ok: false, error: `${r.display} is a binary file; edit only changes text.` };
      return { ok: true, content: buf.toString("utf8") };
    } catch (err) {
      return { ok: false, error: `Cannot edit ${r.display}: ${errnoText(err)}.` };
    }
  };
  return {
    spec: {
      name: "edit",
      description:
        "Replace text in an existing file. `old_string` must match the file exactly (indentation included, without `read`'s line-number prefix) and exactly once, unless `replace_all` is true. The file must have been read with `read` this session and not changed since; read it again if it has. Returns a unified diff of the change. Line endings and the final newline are kept as the file has them. To create a file, use `write`.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file, absolute or relative to the working directory." },
          old_string: { type: "string", description: "The exact text to replace. Include enough surrounding lines to make it unique." },
          new_string: { type: "string", description: "The text to put in its place. Must differ from old_string." },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one. Default false." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    validate: (raw) =>
      validated(raw, (o) => ({
        path: str(o, "path", { required: true, nonEmpty: true }),
        old_string: str(o, "old_string", { required: true, nonEmpty: true }),
        new_string: str(o, "new_string", { required: true }),
        replace_all: bool(o, "replace_all"),
      })),
    risk: () => "write",
    summarise(args, ctx) {
      const r = resolveIn(args.path, ctx);
      noteJudged(args, r);
      const summary = { title: `Edit ${r.display}`, paths: summaryPaths(r) };
      const loaded = load(r);
      if (!loaded.ok) return summary;
      const plan = planEdit(loaded.content, args.old_string, args.new_string, args.replace_all ?? false, r.display);
      return plan.ok ? { ...summary, diff: unifiedDiff(r.display, loaded.content, plan.after) } : summary;
    },
    async run(args, ctx) {
      const r = resolveIn(args.path, ctx);
      const moved = movedSinceJudged(args, r);
      if (moved) return fail(moved);
      const check = ledger.check(r.real);
      if (!check.ok) {
        // Distinguish "does not exist" from "not read": the model may be trying to create a file.
        try {
          statSync(r.real);
        } catch (err) {
          return fail(`Cannot edit ${r.display}: ${errnoText(err)}.${(err as NodeJS.ErrnoException).code === "ENOENT" ? " Use `write` to create a file." : ""}`);
        }
        return fail(readFirstRefusal(check.reason, r, "edit"));
      }
      const loaded = load(r);
      if (!loaded.ok) return fail(loaded.error);
      const plan = planEdit(loaded.content, args.old_string, args.new_string, args.replace_all ?? false, r.display);
      if (!plan.ok) return fail(plan.error);
      if (ctx.signal.aborted) return fail("Interrupted; the file was not changed.");
      try {
        writeAtomic(r.real, plan.after);
        ledger.recordNow(r.real);
      } catch (err) {
        return fail(`Could not write ${r.display}: ${errnoText(err)}. The file was not changed.`);
      }
      const diff = unifiedDiff(r.display, loaded.content, plan.after);
      const { added, removed } = diffStat(diff);
      return {
        content: `Edited ${r.display}: ${plural(plan.count, "replacement")}, +${added} −${removed} lines.\n${diff}`,
        display: { kind: "diff", path: r.display, diff },
      };
    },
  };
}
