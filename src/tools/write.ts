import { readFileSync, statSync } from "node:fs";
import type { Tool } from "../agent/types.js";
import { detectEol, fromLf, toLf, writeAtomic } from "./atomic.js";
import { errnoText, fail, looksBinary, movedSinceJudged, noteJudged, resolveIn } from "./common.js";
import { diffStat, unifiedDiff } from "./diff.js";
import { readFirstRefusal } from "./edit.js";
import { summaryPaths, type ResolvedPath } from "./paths.js";
import type { ReadLedger } from "./read-ledger.js";
import { str, validated } from "./validate.js";

export interface WriteArgs {
  path: string;
  content: string;
}

type Existing = { kind: "none" } | { kind: "file"; text: string | null } | { kind: "error"; error: string };

function existing(r: ResolvedPath): Existing {
  let st;
  try {
    st = statSync(r.real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "error", error: `Cannot write ${r.display}: ${errnoText(err)}.` };
  }
  if (st.isDirectory()) return { kind: "error", error: `${r.display} is a directory.` };
  if (!st.isFile()) return { kind: "error", error: `${r.display} is not a regular file.` };
  try {
    const buf = readFileSync(r.real);
    return { kind: "file", text: looksBinary(buf) ? null : buf.toString("utf8") };
  } catch (err) {
    return { kind: "error", error: `Cannot write ${r.display}: ${errnoText(err)}.` };
  }
}

/** Replacing a file keeps its line endings and its final newline (or lack of one), whatever the model wrote. */
export function shapeLike(before: string | null, content: string): string {
  if (before === null || before === "") return content;
  const eol = detectEol(before);
  let out = fromLf(toLf(content), eol);
  if (before.endsWith("\n") && out.length > 0 && !out.endsWith("\n")) out += eol;
  return out;
}

export function writeTool(ledger: ReadLedger): Tool<WriteArgs> {
  return {
    spec: {
      name: "write",
      description:
        "Create a file, or replace a whole file, with `content`. Parent directories are created. Replacing an existing file needs it to have been read with `read` this session and not changed since. Returns a unified diff. Prefer `edit` for changing part of a file: it is smaller and safer.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file, absolute or relative to the working directory." },
          content: { type: "string", description: "The complete new contents of the file." },
        },
        required: ["path", "content"],
      },
    },
    validate: (raw) =>
      validated(raw, (o) => ({
        path: str(o, "path", { required: true, nonEmpty: true }),
        content: str(o, "content", { required: true }),
      })),
    risk: () => "write",
    summarise(args, ctx) {
      const r = resolveIn(args.path, ctx);
      noteJudged(args, r);
      const found = existing(r);
      const title = `${found.kind === "none" ? "Create" : "Write"} ${r.display}`;
      if (found.kind === "error" || (found.kind === "file" && found.text === null)) return { title, paths: summaryPaths(r) };
      const before = found.kind === "file" ? found.text : null;
      return { title, paths: summaryPaths(r), diff: unifiedDiff(r.display, before, shapeLike(before, args.content)) };
    },
    async run(args, ctx) {
      const r = resolveIn(args.path, ctx);
      const moved = movedSinceJudged(args, r);
      if (moved) return fail(moved);
      const found = existing(r);
      if (found.kind === "error") return fail(found.error);
      if (found.kind === "file") {
        const check = ledger.check(r.real);
        if (!check.ok) return fail(readFirstRefusal(check.reason, r, "overwrite"));
      }
      const before = found.kind === "file" ? found.text : null;
      const after = shapeLike(before, args.content);
      if (ctx.signal.aborted) return fail("Interrupted; nothing was written.");
      try {
        writeAtomic(r.real, after);
        ledger.recordNow(r.real);
      } catch (err) {
        return fail(`Could not write ${r.display}: ${errnoText(err)}. Nothing was changed.`);
      }
      const diff = unifiedDiff(r.display, before, after);
      const { added, removed } = diffStat(diff);
      const lines = after === "" ? 0 : toLf(after).replace(/\n$/, "").split("\n").length;
      const what = found.kind === "none" ? `Created ${r.display} (${lines} line${lines === 1 ? "" : "s"}).` : before === null ? `Replaced binary file ${r.display} with ${lines} lines of text.` : `Wrote ${r.display}: +${added} −${removed} lines.`;
      return { content: diff ? `${what}\n${diff}` : `${what} The content was already identical.`, display: { kind: "diff", path: r.display, diff } };
    },
  };
}
