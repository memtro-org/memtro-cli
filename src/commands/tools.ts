import { callTool, listTools, parseArgPairs, parseInputJson, resultJson, resultText } from "../api/mcp.js";
import { str } from "../args.js";
import type { Context } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { firstLine, writeJson } from "../output.js";

/** `memtro tools`: what `tools/list` returns for this key — Memtro's own tools and one per connected system. */
export async function tools(ctx: Context): Promise<number> {
  const client = await ctx.client();
  const list = await listTools(client);
  if (ctx.json) {
    writeJson(ctx.stdout, { tools: list.map((t) => ({ name: t.name, description: t.description ?? null, input_schema: t.inputSchema ?? null })) });
    return 0;
  }
  if (!list.length) {
    ctx.stderr.write("This key has no tools (it may have been issued with a narrowed tool surface).\n");
    return 0;
  }
  const width = Math.min(40, Math.max(...list.map((t) => t.name.length)));
  for (const t of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
    ctx.stdout.write(`${ctx.out.bold(t.name.padEnd(width))}  ${firstLine(t.description, 100)}\n`);
  }
  return 0;
}

/** `memtro call <tool>`: one `tools/call`, the result printed as the tool returned it. */
export async function call(ctx: Context): Promise<number> {
  const name = ctx.positionals[0]!;
  const pairs = (ctx.flags.arg as string[] | undefined) ?? [];
  const input = str(ctx.flags.input);
  if (input && pairs.length) throw new UsageError("Give --input or --arg, not both.");
  const args = input ? parseInputJson(input) : parseArgPairs(pairs);

  const client = await ctx.client();
  const result = await callTool(client, name, args, name.startsWith("memtro_") ? "memory" : "all");
  if (ctx.json) {
    writeJson(ctx.stdout, { tool: name, is_error: result.isError, content: result.content, data: resultJson(result) });
  } else {
    const parsed = resultJson(result);
    const text = parsed !== null ? JSON.stringify(parsed, null, 2) : resultText(result);
    (result.isError ? ctx.stderr : ctx.stdout).write(`${text}\n`);
  }
  if (result.isError) {
    if (!ctx.json) throw new CliError(`${name} returned an error.`);
    return 1;
  }
  return 0;
}
