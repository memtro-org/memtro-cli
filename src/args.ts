import { parseArgs, type ParseArgsConfig } from "node:util";
import { NO_LOGIN_COMMAND, UsageError } from "./errors.js";

/**
 * The command line, parsed with `node:util`'s `parseArgs` in two passes: the first (global options only, not
 * strict) finds which command was named, wherever the global options sit around it; the second is strict over
 * the global options and that command's own, so a misspelt flag is a usage error (exit 2) rather than silently
 * ignored.
 */

type Options = NonNullable<ParseArgsConfig["options"]>;

export const GLOBAL_OPTIONS = {
  profile: { type: "string" },
  "base-url": { type: "string" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  "no-color": { type: "boolean" },
  /** Signing in, when a command needs it: print the address and paste the code rather than open a browser. */
  "no-browser": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const satisfies Options;

/**
 * The coding session's options, taken by `memtro` with no command (interactive, or headless with `-p`) and by
 * `memtro run`. They are known to the first pass too, so `memtro --model x` is not read as a command named "x".
 */
export const HARNESS_OPTIONS = {
  model: { type: "string" },
  mode: { type: "string" },
  continue: { type: "boolean" },
  resume: { type: "string" },
  actions: { type: "boolean" },
  "no-classifier": { type: "boolean" },
  "allow-edits": { type: "boolean" },
  allow: { type: "string", multiple: true },
  unchecked: { type: "boolean" },
} as const satisfies Options;

/** Only without a command: `memtro -p "<task>"` is `memtro run "<task>"`. */
export const BARE_OPTIONS = { ...HARNESS_OPTIONS, prompt: { type: "string", short: "p" } } as const satisfies Options;

export const HARNESS_DETAILS =
  "Options for a session (memtro, memtro -p, memtro run):\n" +
  "  --model <id>        Which model (default auto; /model lists them)\n" +
  "  --mode ask|auto     ask: every edit, command and remote action is put to you. auto (default): a safety check\n" +
  "                      judges them and only its doubts are put to you\n" +
  "  --continue          Carry on this directory's most recent session\n" +
  "  --resume [<id>]     Carry on a session (without an id: pick from a list)\n" +
  "  --actions           Let Memtro's tools change connected systems (each such call is checked)\n" +
  "  --no-classifier     No safety-check model: everything it would judge is asked instead\n" +
  "  --allow-edits       Allow edits to files in this repository without asking\n" +
  "  --allow <prefix>    Allow a single command starting with these words without asking (repeatable):\n" +
  "                      --allow \"npm test\". Never covers chained commands or the always-asked list\n" +
  "  --unchecked         Run every tool call without checking or asking anything. Commands run with your\n" +
  "                      account's permissions and nothing stands between the model and your files\n" +
  "  --json              (run) One JSON event per line on stdout";

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  /** Extra lines of help after the usage line. */
  details?: string;
  options: Options;
  positionals: "none" | "optional" | "some" | "one";
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "run",
    summary: "Give the coding agent one task and exit when it is done (nobody is asked anything)",
    usage: 'memtro run "<task>" [session options] [--json]',
    details:
      "The task can also come on stdin (memtro run < task.md, or memtro -p \"<task>\"). The agent works in this\n" +
      "directory with the same tools as an interactive session; a call that would need your approval is refused\n" +
      "and the model is told which flag would have allowed it. The answer goes to stdout, tool lines to stderr;\n" +
      "--json prints every event as one JSON line on stdout instead. Exit 0 when the agent finished, 1 when it\n" +
      "failed or stopped at a limit, 3 when not signed in or the key was refused, 4 when Memtro could not be\n" +
      "reached, 130 when interrupted.\n\n" +
      HARNESS_DETAILS,
    options: HARNESS_OPTIONS,
    positionals: "some",
  },
  {
    name: "logout",
    summary: "Revoke this profile's key and remove it from this computer (the next command signs in again)",
    usage: "memtro logout [--profile <name>]",
    options: {},
    positionals: "none",
  },
  {
    name: "whoami",
    summary: "Show who the key belongs to, its organisation and when it expires",
    usage: "memtro whoami [--json]",
    options: {},
    positionals: "none",
  },
  {
    name: "ask",
    summary: "Ask Memtro a question; the answer streams to stdout",
    usage: 'memtro ask "<question>" [--agent] [--model <id>] [--json]',
    details:
      "The question can also come on stdin; with both, the argument is the question and stdin is attached\n" +
      "below it (git diff | memtro ask \"review this\"). Default model auto:chat, one reply; --agent runs the\n" +
      "multi-step investigation across your connected systems (auto:agent). The repository of the current\n" +
      "directory, if any, is sent so memory about it is preferred.",
    options: { agent: { type: "boolean" }, model: { type: "string" } },
    positionals: "some",
  },
  {
    name: "search",
    summary: "Search memory",
    usage: 'memtro search "<query>" [--limit <n>] [--json]',
    options: { limit: { type: "string" } },
    positionals: "some",
  },
  {
    name: "remember",
    summary: "Save a statement to memory",
    usage: 'memtro remember "<statement>" [--personal] [--json]',
    details: "Shared with your organisation by default; --personal keeps it to you. Write it self-contained, with names and dates.",
    options: { personal: { type: "boolean" } },
    positionals: "some",
  },
  {
    name: "why",
    summary: "Why a piece of code is the way it is: the PRs, tickets and conversations behind it",
    usage: "memtro why <path> [--repo <owner/name>] [--limit <n>] [--json]",
    details: "A path inside the current checkout is sent as the repository spells it. --repo alone asks about a whole repository.",
    options: { repo: { type: "string" }, limit: { type: "string" } },
    positionals: "optional",
  },
  {
    name: "tools",
    summary: "List the tools your key can use (Memtro's own and your connected systems')",
    usage: "memtro tools [--json]",
    options: {},
    positionals: "none",
  },
  {
    name: "call",
    summary: "Call one tool",
    usage: "memtro call <tool> [--arg key=value … | --arg key:=<json> … | --input '<json>'] [--json]",
    details: "key=value sends a string; key:=json sends a number, boolean, array or object (--arg limit:=5).",
    options: { arg: { type: "string", multiple: true }, input: { type: "string" } },
    positionals: "one",
  },
  {
    name: "token",
    summary: "Print the stored key, for piping into another tool",
    usage: "memtro token [--show]",
    details: "Refuses to print to a terminal unless --show is given, so the key does not land in scrollback by accident.",
    options: { show: { type: "boolean" } },
    positionals: "none",
  },
  {
    name: "update",
    summary: "Update memtro to the latest release",
    usage: "memtro update [--version <x.y.z>]",
    details:
      "Downloads the release for this computer from GitHub, checks its SHA-256 against the release's checksums,\n" +
      "proves it starts, and puts it in place of this one; it runs from the next time you start memtro.\n" +
      "--version installs that release instead of the latest. Only the standalone memtro can update itself, and only in a directory\n" +
      "you can write to and other users cannot; any other install is told how to update. Exit 0 when updated or already current,\n" +
      "1 when the update failed (nothing was replaced), 2 when this install cannot update itself.",
    options: { version: { type: "string" } },
    positionals: "none",
  },
  {
    name: "help",
    summary: "Show help for a command",
    usage: "memtro help [<command>]",
    options: {},
    positionals: "optional",
  },
];

export const findCommand = (name: string): CommandSpec | undefined => COMMANDS.find((c) => c.name === name);

export type Flags = Record<string, string | boolean | string[] | undefined>;

export interface Parsed {
  command: string | null;
  flags: Flags;
  positionals: string[];
}

export function parseCommandLine(argv: readonly string[]): Parsed {
  argv = resumeWithoutId(argv);
  let first;
  try {
    first = parseArgs({ args: [...argv], options: { ...GLOBAL_OPTIONS, ...BARE_OPTIONS }, strict: false, allowPositionals: true, tokens: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const commandToken = first.tokens.find((t) => t.kind === "positional");
  if (!commandToken || commandToken.kind !== "positional") {
    // No command: global flags and the session's (`memtro --version`, `memtro --model x`, `memtro -p "…"`).
    const only = strictParse(argv, { ...GLOBAL_OPTIONS, ...BARE_OPTIONS });
    if (only.positionals.length) throw new UsageError(`Unexpected argument "${only.positionals[0]}".`);
    return { command: null, flags: only.values, positionals: [] };
  }
  const name = commandToken.value;
  if (name === "login") throw new UsageError(NO_LOGIN_COMMAND);
  const spec = findCommand(name);
  if (!spec) {
    // Never a task by accident: a typo of a command would otherwise be sent to a model that can run commands.
    const words = first.tokens.filter((t) => t.kind === "positional").map((t) => (t as { value: string }).value).join(" ");
    const task = words.length > 60 ? `${words.slice(0, 59)}…` : words;
    throw new UsageError(`Unknown command "${name}". Run \`memtro --help\` for the list.\nTo give the agent a task, run: memtro run "${task.replace(/["\\$`]/g, "\\$&")}"`);
  }

  const rest = [...argv.slice(0, commandToken.index), ...argv.slice(commandToken.index + 1)];
  const parsed = strictParse(rest, { ...GLOBAL_OPTIONS, ...spec.options });
  if (parsed.values.help) return { command: name, flags: parsed.values, positionals: parsed.positionals };

  const n = parsed.positionals.length;
  if (spec.positionals === "none" && n > 0) throw new UsageError(`\`memtro ${name}\` takes no arguments; got "${parsed.positionals[0]}".\nUsage: ${spec.usage}`);
  if (spec.positionals === "one" && n !== 1) throw new UsageError(`\`memtro ${name}\` takes exactly one argument.\nUsage: ${spec.usage}`);
  if (spec.positionals === "optional" && n > 1) throw new UsageError(`\`memtro ${name}\` takes at most one argument.\nUsage: ${spec.usage}`);
  return { command: name, flags: parsed.values, positionals: parsed.positionals };
}

/** `--resume` with no id after it (end of line, or another option next) means "pick one": given as `--resume=`. */
export function resumeWithoutId(argv: readonly string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "--") break;
    if (out[i] === "--resume" && (i + 1 >= out.length || out[i + 1]!.startsWith("-"))) out[i] = "--resume=";
  }
  return out;
}

function strictParse(args: readonly string[], options: Options): { values: Flags; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args: [...args], options, strict: true, allowPositionals: true });
    return { values: values as Flags, positionals };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // parseArgs' own messages are clear ("Unknown option '--lmit'"); its hint about `--` is not useful here.
    throw new UsageError(e.message.replace(/\. To specify a positional argument.*$/s, "."));
  }
}

/** `--limit`: a whole number within bounds, or a usage error. */
export function intFlag(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (typeof value !== "string" || !/^\d+$/.test(value) || n < min || n > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}; got "${String(value)}".`);
  return n;
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const bool = (v: unknown): boolean => v === true;
