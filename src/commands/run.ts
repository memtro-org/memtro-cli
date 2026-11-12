import type { Agent, AgentEvent } from "../agent/types.js";
import { signInOptions, startSignedIn, type SignInDeps } from "../auth/ensure.js";
import type { Context } from "../context.js";
import { EXIT, UsageError } from "../errors.js";
import { colourAllowed } from "../output.js";
import { startSession, type Session, type StartDeps } from "../session/start.js";
import { headlessApprover } from "../tui/approval.js";
import { TurnRenderer } from "../tui/render.js";
import { oneLine } from "../tui/sanitise.js";
import { statusLine } from "../tui/status.js";
import { style } from "../tui/style.js";
import { readStdin, stdinWasRedirected } from "./ask.js";

export const EXIT_INTERRUPTED = 130;

/**
 * `memtro run "<task>"`: one turn with nobody to ask, then exit.
 *
 * Human mode: the answer on stdout, tool lines and notices on stderr. `--json`: every event as one JSON line on
 * stdout and nothing else there. The exit code is the turn's end: 0 when the model finished, 1 when it failed or
 * stopped at a limit (4 when the failure was Memtro being unreachable or busy, worth retrying), 130 when
 * interrupted. A refused tool call is not a failure by itself: the model is told and carries on.
 */

/** The task: the arguments, `-p`, stdin, or the arguments with stdin attached beneath them. */
export async function taskFrom(ctx: Context, given: string | undefined): Promise<string> {
  const arg = (given ?? ctx.positionals.join(" ")).trim();
  const piped = !arg || stdinWasRedirected(ctx.stdin) ? await readStdin(ctx.stdin) : null;
  const p = piped?.trim() ?? "";
  const task = arg && p ? `${arg}\n\n${p}` : arg || p;
  if (!task) throw new UsageError('No task. Usage: memtro run "<task>" (or pipe the task in, or run `memtro` in a terminal for a session).');
  return task;
}

export function exitCodeFor(reason: string | null, lastError: { retryable: boolean } | null): number {
  switch (reason) {
    case "stop":
      return EXIT.ok;
    case "interrupted":
      return EXIT_INTERRUPTED;
    case "error":
      return lastError?.retryable ? EXIT.unavailable : EXIT.failure;
    default:
      return EXIT.failure;
  }
}

/** Runs one turn and reports it. Separate from the setup so it is tested against a scripted agent. */
export async function driveHeadless(agent: Agent, task: string, io: { ctx: Context; json: boolean; notices: string[]; mode: Session["gate"]["mode"]; signal: AbortSignal }): Promise<number> {
  const { ctx } = io;
  if (io.json) {
    const line = (e: AgentEvent) => ctx.stdout.write(`${JSON.stringify(e)}\n`);
    for (const n of io.notices) line({ type: "notice", text: n });
    let reason: string | null = null;
    let lastError: { retryable: boolean } | null = null;
    for await (const e of agent.run(task, io.signal)) {
      line(e);
      if (e.type === "error") lastError = e;
      if (e.type === "turn-end") reason = e.reason;
    }
    return exitCodeFor(reason ?? (io.signal.aborted ? "interrupted" : null), lastError);
  }
  const outStyle = style(colourAllowed(ctx.stdout, ctx.env, Boolean(ctx.flags["no-color"])));
  const errStyle = style(colourAllowed(ctx.stderr, ctx.env, Boolean(ctx.flags["no-color"])));
  for (const n of io.notices) ctx.stderr.write(`${errStyle.yellow(`· ${oneLine(n)}`)}\n`);
  // Markdown styling follows stdout (where the answer goes); the info lines carry stderr's own colour.
  const r = new TurnRenderer(
    (channel, text) => (channel === "text" ? ctx.stdout : ctx.stderr).write(text),
    { style: { ...errStyle, on: outStyle.on }, thinking: ctx.verbose && ctx.stderr.isTTY ? "full" : "hidden", shared: false, mode: io.mode },
    agent.model,
  );
  for await (const e of agent.run(task, io.signal)) r.event(e);
  r.finish();
  if (ctx.stderr.isTTY) ctx.stderr.write(`${statusLine({ ...r.stats, mode: io.mode }, errStyle)}\n`);
  return exitCodeFor(r.reason ?? (io.signal.aborted ? "interrupted" : null), r.lastError);
}

/**
 * Signs in first when there is no key and a person is at the terminal (stdin and stdout terminals, not CI); piped
 * or in CI that is exit 3 with how to sign in. Nothing about updates is ever printed here.
 */
export async function run(ctx: Context, deps: Partial<StartDeps> = {}, given?: string, signIn: Partial<SignInDeps> = {}): Promise<number> {
  const task = await taskFrom(ctx, given);
  const controller = new AbortController();
  let first = 0;
  // First Ctrl-C stops the turn cleanly (every call gets its result, the session is saved); a second leaves now.
  const onInt = () => {
    if (controller.signal.aborted && Date.now() - first < 10_000) process.exit(EXIT_INTERRUPTED);
    first = Date.now();
    if (!ctx.json) ctx.stderr.write("\nStopping… (Ctrl-C again to quit at once)\n");
    controller.abort();
  };
  process.on("SIGINT", onInt);
  try {
    let root = ctx.cwd;
    const started = await startSignedIn(
      ctx,
      signInOptions(ctx),
      (c) =>
        startSession(c, {
          approver: { ask: (call, decision, suggested) => headlessApprover(root).ask(call, decision, suggested) },
          interactive: false,
          deps,
        }),
      signIn,
    );
    const session = started.value;
    root = session.workspaceRoot;
    return await driveHeadless(session.agent, task, { ctx: started.ctx, json: ctx.json, notices: session.notices, mode: session.gate.mode, signal: controller.signal });
  } finally {
    process.off("SIGINT", onInt);
  }
}
