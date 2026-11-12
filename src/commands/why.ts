import { callTool, resultJson, resultText } from "../api/mcp.js";
import { intFlag, str } from "../args.js";
import type { Context } from "../context.js";
import { CliError, UsageError } from "../errors.js";
import { repoPath } from "../git.js";
import { writeJson } from "../output.js";

/**
 * `memtro why <path>`: Memtro's `memtro_why` tool, which takes a file path (and optionally `repo` as
 * owner/name) and returns the pull requests, tickets, conversations and incidents behind it.
 *
 * A path that exists in the current checkout is rewritten relative to the repository root, because that is how
 * the repository spells it and `memtro why total.ts` from inside `src/checkout/` means `src/checkout/total.ts`.
 * The repository itself is only sent when asked (--repo): the tool searches every repository for the path, and
 * pinning it to this checkout's remote would miss history recorded under a fork or a renamed repository.
 */
export async function why(ctx: Context): Promise<number> {
  const raw = ctx.positionals[0]?.trim();
  const repo = str(ctx.flags.repo)?.trim();
  if (!raw && !repo) throw new UsageError("Usage: memtro why <path> [--repo owner/name]  (or --repo alone for a whole repository)");
  if (repo && !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new UsageError(`--repo is owner/name; got "${repo}".`);
  const limit = intFlag(ctx.flags.limit, "limit", 1, 30);
  const args: Record<string, unknown> = {
    ...(raw ? { path: repoPath(raw, ctx.cwd) } : {}),
    ...(repo ? { repo } : {}),
    ...(limit ? { limit } : {}),
  };
  ctx.log(`memtro_why ${JSON.stringify(args)}`);

  const client = await ctx.client();
  const result = await callTool(client, "memtro_why", args, "memory");
  const data = resultJson(result);
  const error = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : null;
  if (result.isError || error) throw new CliError(`Memtro could not answer: ${error ?? resultText(result)}`);

  if (ctx.json) {
    writeJson(ctx.stdout, data ?? { text: resultText(result) });
    return 0;
  }
  ctx.stdout.write(`${data ? JSON.stringify(data, null, 2) : resultText(result)}\n`);
  return 0;
}
