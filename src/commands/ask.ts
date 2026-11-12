import { randomBytes } from "node:crypto";
import { fstatSync } from "node:fs";
import { streamChat, type ChatBody } from "../api/chat.js";
import { bool, str } from "../args.js";
import type { Context } from "../context.js";
import { UsageError } from "../errors.js";
import { gitProject } from "../git.js";
import { writeJson } from "../output.js";

/** Piped input beyond this is refused rather than sent: a prompt this size is a mistake, not a question. */
export const MAX_STDIN_BYTES = 2 * 1024 * 1024;

/**
 * One id per invocation, as pi-memtro has one per process. `memtro ask` is one turn, so nothing joins two runs
 * together; the id still groups the request's own usage and is what Memtro's logs can be searched by.
 */
export const sessionId = (): string => `cli-${randomBytes(6).toString("hex")}`;

/** The question: the argument, stdin, or the argument with stdin attached beneath it. Pure. */
export function composeQuestion(arg: string, piped: string | null): string {
  const a = arg.trim();
  const p = piped?.trim() ?? "";
  if (a && p) return `${a}\n\n${p}`;
  return a || p;
}

/** The request body, exactly as sent. Pure, so what reaches Memtro is tested rather than described. */
export function chatBody(question: string, opts: { model?: string; agent: boolean; project: string | null; session: string }): ChatBody {
  const model = opts.model ?? (opts.agent ? "auto:agent" : "auto:chat");
  return {
    model,
    messages: [{ role: "user", content: question }],
    memtro: { session: opts.session, ...(opts.project ? { project: opts.project } : {}) },
  };
}

/**
 * Whether stdin is a shell pipe (`git diff | memtro ask …`) or a file (`memtro ask … < notes.md`). A socket — what
 * Node's `spawn` and most process managers hand a child — and a terminal are not.
 */
export function stdinWasRedirected(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): boolean {
  if (stdin.isTTY) return false;
  if (stdin !== process.stdin) return true; // a test's stream
  try {
    const st = fstatSync(0);
    return st.isFIFO() || st.isFile();
  } catch {
    return false;
  }
}

export async function readStdin(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string | null> {
  if (stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += b.length;
    if (size > MAX_STDIN_BYTES) throw new UsageError(`stdin is over ${MAX_STDIN_BYTES / 1024 / 1024} MB; send less.`);
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function ask(ctx: Context): Promise<number> {
  const model = str(ctx.flags.model);
  const agent = bool(ctx.flags.agent);
  if (model && agent) throw new UsageError("Give --model or --agent, not both (use --model <id>:agent for a specific model in agent mode).");
  const arg = ctx.positionals.join(" ");
  // With a question on the command line, stdin is read only when something was actually piped or redirected
  // into it. A program that spawns `memtro ask "…"` usually leaves stdin as an open pipe it never closes, and
  // waiting for that to end would hang the agent that called us.
  const piped = !arg || stdinWasRedirected(ctx.stdin) ? await readStdin(ctx.stdin) : null;
  const question = composeQuestion(arg, piped);
  if (!question) throw new UsageError('Nothing to ask. Usage: memtro ask "<question>" (or pipe the question in).');

  const client = await ctx.client();
  const body = chatBody(question, { model, agent, project: gitProject(ctx.cwd), session: sessionId() });
  ctx.log(`model ${body.model}${(body.memtro as { project?: string }).project ? `, project ${(body.memtro as { project?: string }).project}` : ""}`);

  // The answer to stdout as it arrives; progress and thinking to stderr, and only where somebody is watching.
  const showReasoning = !ctx.json && Boolean(ctx.stderr.isTTY);
  let wrote = false;
  let endsWithNewline = true;
  try {
    const outcome = await streamChat(client, body, {
      content: ctx.json
        ? undefined
        : (text) => {
            ctx.stdout.write(text);
            wrote = true;
            endsWithNewline = text.endsWith("\n");
          },
      reasoning: showReasoning ? (text) => ctx.stderr.write(ctx.err.dim(text)) : undefined,
    });
    if (ctx.json) {
      writeJson(ctx.stdout, { id: outcome.id, model: outcome.model, content: outcome.content, finish_reason: outcome.finish_reason, usage: outcome.usage, memtro: outcome.memtro });
    } else {
      if (!wrote) ctx.stderr.write(`${ctx.err.yellow("Memtro returned an empty answer.")}\n`);
      else if (!endsWithNewline) ctx.stdout.write("\n");
      if (outcome.finish_reason === "length") ctx.stderr.write(`${ctx.err.yellow("The answer hit its length limit and is incomplete.")}\n`);
    }
    return 0;
  } catch (err) {
    if (wrote && !endsWithNewline) ctx.stdout.write("\n");
    throw err;
  }
}
