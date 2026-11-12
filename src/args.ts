import { parseArgs, type ParseArgsConfig } from "node:util";
import { UsageError } from "./errors.js";

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
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const satisfies Options;

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
    name: "login",
    summary: "Sign in through the browser and store a key for this profile",
    usage: "memtro login [--no-browser] [--profile <name>] [--base-url <url>]",
    details:
      "Opens Memtro in your browser to approve this computer, then stores a key in the system keychain: it\n" +
      "belongs to the organisation you pick, acts as you there, and expires after 90 days.\n" +
      "--no-browser prints the address and asks you to paste the code shown after approving; it is chosen automatically over SSH and on Linux without a display.",
    options: { "no-browser": { type: "boolean" } },
    positionals: "none",
  },
  {
    name: "logout",
    summary: "Revoke this profile's key and remove it from this computer",
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
  let first;
  try {
    first = parseArgs({ args: [...argv], options: GLOBAL_OPTIONS, strict: false, allowPositionals: true, tokens: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const commandToken = first.tokens.find((t) => t.kind === "positional");
  if (!commandToken || commandToken.kind !== "positional") {
    // No command: only global flags (`memtro --version`, `memtro --help`, `memtro`).
    const only = strictParse(argv, GLOBAL_OPTIONS);
    if (only.positionals.length) throw new UsageError(`Unexpected argument "${only.positionals[0]}".`);
    return { command: null, flags: only.values, positionals: [] };
  }
  const name = commandToken.value;
  const spec = findCommand(name);
  if (!spec) throw new UsageError(`Unknown command "${name}". Run \`memtro --help\` for the list.`);

  const rest = [...argv.slice(0, commandToken.index), ...argv.slice(commandToken.index + 1)];
  const parsed = strictParse(rest, { ...GLOBAL_OPTIONS, ...spec.options });
  if (parsed.values.help) return { command: name, flags: parsed.values, positionals: parsed.positionals };

  const n = parsed.positionals.length;
  if (spec.positionals === "none" && n > 0) throw new UsageError(`\`memtro ${name}\` takes no arguments; got "${parsed.positionals[0]}".\nUsage: ${spec.usage}`);
  if (spec.positionals === "one" && n !== 1) throw new UsageError(`\`memtro ${name}\` takes exactly one argument.\nUsage: ${spec.usage}`);
  if (spec.positionals === "optional" && n > 1) throw new UsageError(`\`memtro ${name}\` takes at most one argument.\nUsage: ${spec.usage}`);
  return { command: name, flags: parsed.values, positionals: parsed.positionals };
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
