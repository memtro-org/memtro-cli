import { COMMANDS, findCommand } from "../args.js";
import { UsageError } from "../errors.js";
import { VERSION } from "../version.js";

const GLOBAL_HELP = `Options for every command:
  --profile <name>   Which account (default "default", or MEMTRO_PROFILE)
  --base-url <url>   Memtro's address (default https://platform.memtro.com, or MEMTRO_BASE_URL)
  --json             One JSON document on stdout instead of text
  --verbose          Say what is being requested, on stderr (never keys)
  --no-color         No colour (NO_COLOR is respected too)
  -h, --help         Help;  -V, --version  The version`;

export function mainHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const list = COMMANDS.filter((c) => c.name !== "help")
    .map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
    .join("\n");
  return `memtro ${VERSION}: your company's memory, its connected systems and its agent, from a terminal.

Usage: memtro <command> [options]

Commands:
${list}

${GLOBAL_HELP}

Environment:
  MEMTRO_API_KEY      Use this key instead of the stored one (never stored; for CI)
  MEMTRO_PROFILE      Profile to use when --profile is not given
  MEMTRO_BASE_URL     Memtro's address when --base-url is not given
  MEMTRO_CREDENTIALS  "file" to keep keys in a 0600 file rather than the system keychain

Exit codes: 0 ok, 1 failed, 2 usage, 3 not signed in or key refused, 4 Memtro unreachable.
Run \`memtro help <command>\` for a command's options.
`;
}

export function commandHelp(name: string): string {
  const spec = findCommand(name);
  if (!spec) throw new UsageError(`Unknown command "${name}". Run \`memtro --help\` for the list.`);
  return `${spec.summary}.

Usage: ${spec.usage}
${spec.details ? `\n${spec.details}\n` : ""}
${GLOBAL_HELP}
`;
}
