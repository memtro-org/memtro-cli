import { bool, parseCommandLine, str } from "./args.js";
import { ensureSignedIn, signInOptions, type SignInDeps } from "./auth/ensure.js";
import { ask, stdinWasRedirected } from "./commands/ask.js";
import { chat } from "./commands/chat.js";
import { commandHelp, mainHelp } from "./commands/help.js";
import { logout } from "./commands/logout.js";
import { remember } from "./commands/remember.js";
import { run as runTask } from "./commands/run.js";
import { search } from "./commands/search.js";
import { call, tools } from "./commands/tools.js";
import { token } from "./commands/token.js";
import { update, type UpdateApi } from "./commands/update.js";
import { whoami } from "./commands/whoami.js";
import { why } from "./commands/why.js";
import { buildContext, type Context } from "./context.js";
import { CliError, EXIT, UsageError } from "./errors.js";
import { colourAllowed, paint, type Streams } from "./output.js";
import { VERSION } from "./version.js";

/** What tests hand in instead of a real browser and a real update. */
export interface RunDeps {
  signIn?: Partial<SignInDeps>;
  update?: UpdateApi;
}

/**
 * Commands that need a key sign in first when there is none and a person is there (`ensureSignedIn`). `token`,
 * `logout` and `update` never do: printing, removing or updating has no business opening a browser. `run` and
 * the interactive session sign in at their own start, where a refused stored key can be replaced once.
 */
const SIGNS_IN = new Set(["whoami", "ask", "search", "remember", "why", "tools", "call"]);

const HANDLERS: Record<string, (ctx: Context, deps: RunDeps) => Promise<number>> = {
  logout,
  whoami,
  ask,
  search,
  remember,
  why,
  tools,
  call,
  token,
  update: (ctx, deps) => update(ctx, deps.update),
  run: (ctx, deps) => runTask(ctx, {}, undefined, deps.signIn),
};

export interface RunInput extends Streams {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  deps?: RunDeps;
}

/**
 * The whole program, as a function of its arguments, environment and streams, returning the exit code. `main`
 * in main.ts is the only part that touches `process`; tests call this.
 */
export async function run(input: RunInput): Promise<number> {
  const errPaint = paint(colourAllowed(input.stderr, input.env));
  const deps = input.deps ?? {};
  try {
    const parsed = parseCommandLine(input.argv);
    if (parsed.command === null) {
      if (bool(parsed.flags.version)) {
        input.stdout.write(`${VERSION}\n`);
        return EXIT.ok;
      }
      if (bool(parsed.flags.help)) {
        input.stdout.write(mainHelp());
        return EXIT.ok;
      }
      const ctx = () => buildContext({ stdout: input.stdout, stderr: input.stderr, stdin: input.stdin, env: input.env, flags: parsed.flags, positionals: [], cwd: input.cwd });
      // `memtro -p "<task>"`: headless, as `memtro run`.
      const prompt = str(parsed.flags.prompt);
      if (prompt !== undefined) return await runTask(ctx(), {}, prompt, deps.signIn);
      // A person at a terminal: the interactive session.
      if (input.stdin.isTTY && input.stdout.isTTY) return await chat(ctx(), deps);
      // A task piped in: headless.
      if (stdinWasRedirected(input.stdin)) return await runTask(ctx(), {}, undefined, deps.signIn);
      // No terminal and no task: there is nothing to do; show what there is.
      input.stderr.write(mainHelp());
      throw new UsageError('No task and no terminal: give one with memtro run "<task>", or pipe it in.');
    }
    if (parsed.command === "help") {
      input.stdout.write(parsed.positionals[0] ? commandHelp(parsed.positionals[0]) : mainHelp());
      return EXIT.ok;
    }
    if (bool(parsed.flags.help)) {
      input.stdout.write(commandHelp(parsed.command));
      return EXIT.ok;
    }
    if (bool(parsed.flags.version)) {
      input.stdout.write(`${VERSION}\n`);
      return EXIT.ok;
    }
    let ctx = buildContext({ stdout: input.stdout, stderr: input.stderr, stdin: input.stdin, env: input.env, flags: parsed.flags, positionals: parsed.positionals, cwd: input.cwd });
    if (SIGNS_IN.has(parsed.command)) ctx = await ensureSignedIn(ctx, signInOptions(ctx), deps.signIn);
    return await HANDLERS[parsed.command]!(ctx, deps);
  } catch (err) {
    if (err instanceof CliError) {
      input.stderr.write(`${errPaint.red("memtro:")} ${err.message}\n`);
      return err.exitCode;
    }
    // Unexpected: say so plainly. The message only — a stack trace is for --verbose debugging of the CLI itself.
    input.stderr.write(`${errPaint.red("memtro: unexpected error:")} ${err instanceof Error ? err.message : String(err)}\n`);
    if (input.env.MEMTRO_DEBUG === "1" && err instanceof Error && err.stack) input.stderr.write(`${err.stack}\n`);
    return EXIT.failure;
  }
}
