import { COMMANDS, findCommand, HARNESS_DETAILS, INTERFACE_DETAILS } from "../args.js";
import { NO_LOGIN_COMMAND, UsageError } from "../errors.js";
import { VERSION } from "../version.js";

const GLOBAL_HELP = `Options for every command:
  --profile <name>   Which account (default "default", or MEMTRO_PROFILE)
  --base-url <url>   Memtro's address (default https://platform.memtro.com, or MEMTRO_BASE_URL)
  --json             One JSON document on stdout instead of text
  --verbose          Say what is being requested, on stderr (never keys)
  --no-color         No colour (NO_COLOR is respected too)
  --no-browser       When signing in, print the address and paste the code instead of opening a browser
                     (chosen by itself over SSH and on Linux without a display)
  -h, --help         Help;  -V, --version  The version`;

export function mainHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const list = COMMANDS.filter((c) => c.name !== "help")
    .map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
    .join("\n");
  return `memtro ${VERSION}: a coding agent in your terminal, with your company's memory and connected systems.

Usage:
  memtro                    Open a session in this directory (in a terminal)
  memtro run "<task>"       Do one task and exit; nobody is asked anything
                            (also memtro -p "<task>", or the task piped in on stdin)
  memtro <command> [options]

The agent reads, edits and runs commands here with your account's permissions; there is no sandbox. In the
default mode a safety check judges edits, commands and remote actions and puts its doubts to you, and some
things are always put to you. The README's "Safety" section says exactly what.

Signing in: there is no login command. The first command that needs a key, run in a terminal, opens your
browser to approve this computer and stores a key (90 days). Piped or in CI it exits 3 instead: set
MEMTRO_API_KEY there. \`memtro logout\` (or /logout) removes the key; /login signs in again.

${HARNESS_DETAILS}

${INTERFACE_DETAILS}

Commands:
${list}

${GLOBAL_HELP}

Environment:
  MEMTRO_API_KEY      Use this key instead of the stored one (never stored; for CI)
  MEMTRO_PROFILE      Profile to use when --profile is not given
  MEMTRO_BASE_URL     Memtro's address when --base-url is not given
  MEMTRO_CREDENTIALS  "file" to keep keys in a 0600 file rather than the system keychain
  MEMTRO_NO_UPDATE_CHECK  Set to 1 to stop the session saying a newer memtro is available (also
                      "updateCheck": false in config.json); /update and memtro update still work

Exit codes: 0 ok, 1 failed, 2 usage, 3 not signed in or key refused, 4 Memtro unreachable, 130 interrupted.
Run \`memtro help <command>\` for a command's options.
`;
}

export function commandHelp(name: string): string {
  if (name === "login") throw new UsageError(NO_LOGIN_COMMAND);
  const spec = findCommand(name);
  if (!spec) throw new UsageError(`Unknown command "${name}". Run \`memtro --help\` for the list.`);
  return `${spec.summary}.

Usage: ${spec.usage}
${spec.details ? `\n${spec.details}\n` : ""}
${GLOBAL_HELP}
`;
}
