import { createReadStream, openSync, readSync, closeSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Tool } from "../agent/types.js";
import { errnoText, fail, looksBinary, resolveIn } from "./common.js";
import { summaryPaths } from "./paths.js";
import type { ReadLedger } from "./read-ledger.js";
import { cutLine, kb, MAX_BYTES, MAX_LINE_CHARS, MAX_LINES } from "./truncate.js";
import { int, str, validated } from "./validate.js";

export interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

/** Past this, the file is not read to the end just to count its lines. */
const COUNT_ALL_LINES_UP_TO = 20 * 1024 * 1024;

export function readTool(ledger: ReadLedger): Tool<ReadArgs> {
  return {
    spec: {
      name: "read",
      description:
        "Read a text file. Returns its lines numbered from 1 (`number<TAB>text`), at most 2000 lines or 50 KB per call; when there is more, the last line says which lines were shown and the offset to read on from. Long lines are cut with a marker. Refuses directories (use `list`) and binary files. Read a file before editing or overwriting it: `edit` and `write` refuse a file that was not read this session or has changed since. Prefer one larger read over many small ones.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "The file, absolute or relative to the working directory. `~` is the home directory." },
          offset: { type: "integer", minimum: 1, description: "The first line to show, counting from 1. Default 1." },
          limit: { type: "integer", minimum: 1, maximum: MAX_LINES, description: `How many lines to show. Default and maximum ${MAX_LINES}.` },
        },
        required: ["path"],
      },
    },
    validate: (raw) =>
      validated(raw, (o) => ({
        path: str(o, "path", { required: true, nonEmpty: true }),
        offset: int(o, "offset", { min: 1, max: Number.MAX_SAFE_INTEGER }),
        limit: int(o, "limit", { min: 1, max: MAX_LINES }),
      })),
    risk: () => "read",
    summarise(args, ctx) {
      const r = resolveIn(args.path, ctx);
      const range = args.offset || args.limit ? ` (lines ${args.offset ?? 1}${args.limit ? `–${(args.offset ?? 1) + args.limit - 1}` : "+"})` : "";
      return { title: `Read ${r.display}${range}`, paths: summaryPaths(r) };
    },
    async run(args, ctx) {
      const r = resolveIn(args.path, ctx);
      let stat;
      try {
        stat = statSync(r.real);
      } catch (err) {
        return fail(`Cannot read ${r.display}: ${errnoText(err)}.`);
      }
      if (stat.isDirectory()) return fail(`${r.display} is a directory. Use \`list\` to see what is in it.`);
      if (!stat.isFile()) return fail(`${r.display} is not a regular file (a device, socket or pipe), so it is not read.`);

      try {
        const fd = openSync(r.real, "r");
        try {
          const sample = Buffer.alloc(Math.min(8192, stat.size));
          readSync(fd, sample, 0, sample.length, 0);
          if (looksBinary(sample)) return fail(`${r.display} is a binary file (${kb(stat.size)}), so it is not shown. Use \`bash\` with a tool that understands the format if you need to inspect it.`);
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        return fail(`Cannot read ${r.display}: ${errnoText(err)}.`);
      }

      const offset = args.offset ?? 1;
      const limit = args.limit ?? MAX_LINES;
      const shown: { n: number; text: string }[] = [];
      let bytes = 0;
      let lineNo = 0;
      let lastShown = offset - 1;
      let stoppedForBytes = false;
      let total: number | null = null;
      const width = String(offset + limit - 1).length;

      const stream = createReadStream(r.real, { encoding: "utf8" });
      const onAbort = () => stream.destroy();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        let done = false;
        for await (const line of lines) {
          lineNo++;
          if (done) {
            if (stat.size > COUNT_ALL_LINES_UP_TO) break;
            continue;
          }
          if (lineNo < offset) continue;
          const text = cutLine(line, MAX_LINE_CHARS);
          // Counted at the widest the number can be, so the total stays under the limit once formatted.
          const add = width + 1 + Buffer.byteLength(text, "utf8") + 1;
          if (bytes + add > MAX_BYTES) {
            stoppedForBytes = true;
            done = true;
            continue;
          }
          shown.push({ n: lineNo, text });
          bytes += add;
          lastShown = lineNo;
          if (shown.length >= limit) done = true;
        }
        if (!done || stat.size <= COUNT_ALL_LINES_UP_TO) total = lineNo;
      } catch (err) {
        if (ctx.signal.aborted) return fail("Interrupted before the file was read.");
        return fail(`Cannot read ${r.display}: ${errnoText(err)}.`);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }
      if (ctx.signal.aborted) return fail("Interrupted before the file was read.");
      // Seen as it was read; the stat before the read is the conservative stamp (a change during the read shows as a change).
      ledger.record(r.real, { mtimeMs: stat.mtimeMs, size: stat.size });

      if (stat.size === 0) return { content: `${r.display} is empty (0 lines).` };
      if (shown.length === 0) return { content: `${r.display} has ${lineNo} line${lineNo === 1 ? "" : "s"}; there is nothing at line ${offset}.` };

      const more = total === null ? true : lastShown < total;
      let footer = "";
      if (more) {
        const of = total === null ? "" : ` of ${total}`;
        const why = stoppedForBytes ? ` (the ${kb(MAX_BYTES)} limit)` : "";
        footer = `\n[Showed lines ${offset}–${lastShown}${of}${why}. Read on with offset=${lastShown + 1}.]`;
      } else if (offset > 1) {
        footer = `\n[Showed lines ${offset}–${lastShown} of ${total}; that is the end of the file.]`;
      }
      const pad = String(lastShown).length;
      return { content: shown.map((l) => `${String(l.n).padStart(pad)}\t${l.text}`).join("\n") + footer };
    },
  };
}
