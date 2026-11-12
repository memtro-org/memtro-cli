import { intFlag } from "../args.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { humanDate, writeJson } from "../output.js";

/** One memory as `GET /v1/memory` returns it (brain src/lib/api/memory-json.ts), the fields shown here. */
export interface MemoryRow {
  id: string;
  content: string;
  kind: string | null;
  scope: "shared" | "team" | "personal";
  source: string | null;
  system: string | null;
  url: string | null;
  trust: string | null;
  created_at: string;
  superseded_by: string | null;
  score?: number | null;
}

interface SearchReply {
  object: "list";
  data: MemoryRow[];
  search?: { query: string; matched_on: "meaning" | "words"; as_of: string | null };
}

/** Lines for a person. Pure. */
export function formatMemories(rows: MemoryRow[]): string {
  return rows
    .map((m) => {
      const meta = [m.kind, m.scope, m.system ?? m.source, humanDate(m.created_at), m.trust && m.trust !== "trusted" ? m.trust : null, m.superseded_by ? "superseded" : null, m.id]
        .filter(Boolean)
        .join(" · ");
      return `• ${m.content}\n  ${meta}${m.url ? `\n  ${m.url}` : ""}`;
    })
    .join("\n\n");
}

/** `GET /v1/memory?q=…`: search, meaning first where the organisation has an embedding model, words otherwise. */
export async function search(ctx: Context): Promise<number> {
  const query = ctx.positionals.join(" ").trim();
  if (query.length < 2) throw new UsageError('Search for at least two characters. Usage: memtro search "<query>" [--limit n]');
  const limit = intFlag(ctx.flags.limit, "limit", 1, 100);
  const client = await ctx.client();
  const reply = await client.json<SearchReply>("/v1/memory", { query: { q: query, limit } });

  if (ctx.json) {
    writeJson(ctx.stdout, reply);
    return 0;
  }
  if (!reply.data?.length) {
    // Said, not left blank: "nothing matched" and "the call failed" must never look alike.
    ctx.stderr.write(`Nothing in memory matches "${query}".${reply.search?.matched_on === "words" ? " (Matched on words only: this organisation has no embedding model configured.)" : ""}\n`);
    return 0;
  }
  ctx.stdout.write(`${formatMemories(reply.data)}\n`);
  if (reply.search?.matched_on === "words") ctx.stderr.write(`${ctx.err.dim("Matched on words only: this organisation has no embedding model configured.")}\n`);
  return 0;
}
