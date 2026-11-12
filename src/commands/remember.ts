import { callTool, resultJson, resultText } from "../api/mcp.js";
import { bool } from "../args.js";
import type { Context } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { writeJson } from "../output.js";

/**
 * `memtro remember`: saves the statement as written, through Memtro's own `memtro_remember` tool over MCP.
 *
 * Not `POST /v1/memory`, deliberately. That endpoint ingests a conversation — the last turn must be the
 * assistant's — and runs the extractor over it, so a statement sent there comes back as whatever the extractor
 * made of it, or as nothing if it judged the exchange unmemorable, and costs a model call either way. Saving a
 * fact somebody typed is exactly what `memtro_remember` is for: the text is stored verbatim, with the trust the
 * platform gives a person stating something, and the reply carries the new memory's id.
 */
export async function remember(ctx: Context): Promise<number> {
  const content = ctx.positionals.join(" ").trim();
  if (!content) throw new UsageError('Nothing to remember. Usage: memtro remember "<statement>"');
  const client = await ctx.client();
  const args: Record<string, unknown> = { content, ...(bool(ctx.flags.personal) ? { scope: "personal" } : {}) };
  const result = await callTool(client, "memtro_remember", args, "memory");
  const data = resultJson(result) as { saved?: boolean; memory_id?: string; scope?: string; error?: string } | null;

  if (result.isError || data?.error || !data?.saved) {
    throw new CliError(`Memtro did not save it: ${data?.error ?? (resultText(result) || "no reason given")}`);
  }
  if (ctx.json) {
    writeJson(ctx.stdout, data);
    return 0;
  }
  ctx.stdout.write(`Saved${data.scope ? ` (${data.scope})` : ""}. ${ctx.out.dim(data.memory_id ?? "")}\n`);
  return 0;
}
