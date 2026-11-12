#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bool, parseCommandLine } from "./args.js";
import { ask } from "./commands/ask.js";
import { commandHelp, mainHelp } from "./commands/help.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { remember } from "./commands/remember.js";
import { search } from "./commands/search.js";
import { call, tools } from "./commands/tools.js";
import { token } from "./commands/token.js";
import { whoami } from "./commands/whoami.js";
import { why } from "./commands/why.js";
import { buildContext, type Context } from "./context.js";
import { CliError, EXIT } from "./errors.js";
import { colourAllowed, paint, type Streams } from "./output.js";
import { VERSION } from "./version.js";

const HANDLERS: Record<string, (ctx: Context) => Promise<number>> = {
  login: (ctx) => login(ctx),
  logout,
  whoami,
  ask,
  search,
  remember,
  why,
  tools,
  call,
  token,
};

export interface RunInput extends Streams {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * The whole program, as a function of its arguments, environment and streams, returning the exit code. `main`
 * below is the only part that touches `process`; tests call this.
 */
export async function run(input: RunInput): Promise<number> {
  const errPaint = paint(colourAllowed(input.stderr, input.env));
  try {
    const parsed = parseCommandLine(input.argv);
    if (parsed.command === null) {
      if (bool(parsed.flags.version)) {
        input.stdout.write(`${VERSION}\n`);
        return EXIT.ok;
      }
      input.stdout.write(mainHelp());
      // Bare `memtro` is a request for help that was not phrased as one: show it, and say it was not a command.
      return bool(parsed.flags.help) ? EXIT.ok : EXIT.usage;
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
    const ctx = buildContext({ stdout: input.stdout, stderr: input.stderr, stdin: input.stdin, env: input.env, flags: parsed.flags, positionals: parsed.positionals, cwd: input.cwd });
    return await HANDLERS[parsed.command]!(ctx);
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

async function main(): Promise<void> {
  // A closed pipe (`memtro search x | head -1`) is the reader's choice, not an error worth a stack trace.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });
  const code = await run({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
  // exitCode rather than exit(): exit() can cut off output still queued for a pipe on macOS.
  process.exitCode = code;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) void main();
