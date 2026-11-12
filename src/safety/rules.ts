/**
 * The always-ask rules: calls that are put to the person whatever the mode (bar `unchecked`), whatever the session
 * rules and whatever the classifier says.
 *
 * These detectors are liberal on purpose. They scan the raw command text in several spellings (as written; without
 * quotes and backslashes; with `~`, `$HOME` and `${HOME}` replaced by the home directory; and with `$`, braces,
 * parentheses and backticks squeezed out) and look for a word anywhere, not for a parsed command. A false positive
 * costs one prompt; a false negative costs a credential. They are not a sandbox: a command can still build a word
 * at run time that no text scan can see (see the README's list of what this does not cover).
 */

import type { CallSummary, Risk } from "../agent/types.js";
import { absoluteSegments, containsRun, isInside, looseSegments, startsWithRun } from "./paths.js";

export interface RuleEnv {
  home: string;
  platform: NodeJS.Platform;
  configDir: string;
  /** The workspace the call was checked in, or null when it is not known (then everything counts as outside). */
  workspaceRoot: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Credential places, as path segments (lower case). Shared by the path rules and the command-text detectors.
// ---------------------------------------------------------------------------------------------------------------

/** A path with any of these as a segment, anywhere, is a credential store. */
export const CREDENTIAL_SEGMENTS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".pgpass",
  ".kube",
  ".docker",
  ".azure",
  ".password-store",
  ".npmrc",
  ".pypirc",
  ".vault-token",
] as const;

/** A path containing any of these runs of segments, anywhere, is a credential store. */
export const CREDENTIAL_RUNS: readonly (readonly string[])[] = [
  [".config", "memtro"],
  [".config", "gh"],
  [".config", "gcloud"],
  [".local", "state", "memtro"],
  ["library", "keychains"],
  [".cargo", "credentials"],
  [".cargo", "credentials.toml"],
  [".gem", "credentials"],
  [".terraform.d", "credentials.tfrc.json"],
];

/** File names that are private keys or keychains wherever they are. */
const CREDENTIAL_BASENAME = /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?|.*\.keychain(-db)?)$/;

/** `.env`, `.envrc`, `.env.local`, `.env-prod`…: secrets by convention. Always-ask only outside the workspace. */
const ENV_BASENAME = /^\.env(rc|[.\-_].*)?$/;

/** Shell start-up files: a write there runs on every new terminal. */
const STARTUP_BASENAMES = new Set([".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin"]);

// ---------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------

/** Why a read or write of this path is always put to the person, or null. */
export function pathAlwaysAsk(path: string, access: "read" | "write", env: RuleEnv): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  const expanded = expandHomePrefix(path, env.home);
  const segments = looseSegments(expanded, env.platform);
  const base = segments[segments.length - 1] ?? "";

  const configDir = absoluteSegments(env.configDir, env.platform);
  const placed = absoluteSegments(expanded, env.platform);
  if (configDir && placed && startsWithRun(lower(placed), lower(configDir))) {
    return "It touches memtro's own configuration and credentials, which is always put to you.";
  }
  if (CREDENTIAL_SEGMENTS.some((s) => segments.includes(s)) || CREDENTIAL_RUNS.some((run) => containsRun(segments, run))) {
    return "It touches a credential store, which is always put to you.";
  }
  if (CREDENTIAL_BASENAME.test(base)) return "It touches a private key or keychain, which is always put to you.";
  if (ENV_BASENAME.test(base) && !(env.workspaceRoot && isInside(expanded, env.workspaceRoot, env.platform))) {
    return "It touches a `.env` file outside the workspace, which is always put to you.";
  }
  if (access === "write") {
    if (segments.includes(".git")) return "It writes inside `.git`, which is always put to you.";
    if (STARTUP_BASENAMES.has(base) || containsRun(segments, [".config", "fish"])) {
      return "It writes a shell start-up file, which is always put to you.";
    }
    if (base === ".gitconfig" || containsRun(segments, [".config", "git"])) {
      return "It writes git's own configuration, which can make git run programs, so it is always put to you.";
    }
  }
  return null;
}

function expandHomePrefix(path: string, home: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return home + path.slice(1);
  return path;
}

const lower = (segments: readonly string[]): string[] => segments.map((s) => s.toLowerCase());

// ---------------------------------------------------------------------------------------------------------------
// Command text
// ---------------------------------------------------------------------------------------------------------------

/** A word in command text: not glued to letters, digits, `_` or `-` on either side. */
const word = (pattern: string): RegExp => new RegExp(`(?:^|[^a-z0-9_-])(?:${pattern})(?![a-z0-9_-])`, "i");
/** A word that may not follow a `.` either, so `install.sh` does not read as `sh`. */
const commandWord = (pattern: string): RegExp => new RegExp(`(?:^|[^a-z0-9_.-])(?:${pattern})(?![a-z0-9_-])`, "i");

const PRIVILEGE = [word("sudo|doas|pkexec|run0"), /(?:^|[^a-z0-9_.-])su(?:[\s;&|)]|$)/i];
const DOWNLOADER = word("curl|wget|(?<!git\\s{1,20})fetch|aria2c|iwr|irm|invoke-webrequest|invoke-restmethod");
const INTERPRETER = commandWord(
  "sh|bash|zsh|dash|ksh|fish|csh|tcsh|python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|pwsh|powershell|iex|invoke-expression|source|eval|osascript",
);
const GIT = word("git");
const PUSH = word("push");
const FORCE_PUSH = [
  /(?:^|\s)--(?:force|force-with-lease|force-if-includes|mirror|delete|prune)(?![a-z0-9_-])/i,
  /(?:^|\s)-[a-z]*[fd][a-z]*(?=\s|$)/i,
  /(?:^|\s)\+\S/,
  /(?:^|\s):\S/,
];
/** Text piped into a shell, whatever produced it (`echo … | base64 -d | sh`). */
const PIPE_TO_SHELL = /\|\s*(?:\S*\/)?(?:sudo\s+|env\s+|command\s+|exec\s+)*(?:ba|z|da|k|c|tc|fi)?sh(?![a-z0-9_.-])/i;
const HISTORY_REWRITE = word("filter-branch|filter-repo|bfg");
const MEMTRO = word("memtro");
const TOKEN = word("token");
const CREDENTIAL_PRINT = [
  /auth\s+token/i,
  word("print-access-token|print-identity-token|get-login-password|get-session-token"),
  /configure\s+(?:get|export-credentials)/i,
];
const ENVIRONMENT_DUMP = [
  word("printenv"),
  /(?:^|[\s;&|(`])env\s*(?:$|[;&|)>`])/i,
  /\/proc\/[^\s/]+\/environ/i,
  /(?:^|[\s;&|(`])(?:set|export|declare\s+-p|export\s+-p|typeset|compgen\s+-v)\s*(?:$|[;&|)>`])/i,
  /\$\{?[a-z0-9_]*(?:key|token|secret|passw|credential|auth)[a-z0-9_]*/i,
];
const KEYCHAIN = [
  word("find-generic-password|find-internet-password|dump-keychain|unlock-keychain|export-keychain|secret-tool|cmdkey|vaultcmd"),
  /library\/keychains/i,
  /\.keychain(?:-db)?(?![a-z0-9_-])/i,
];
const KEY_FILE = [/(?:^|[^a-z0-9_-])id_(?:rsa|dsa|ecdsa|ed25519)(?![a-z0-9-])/i, /(?:^|[^a-z0-9_-])id_[a-z0-9]*[*?[]/i];
/**
 * A wildcard over hidden names (`~/.ss?/id_rsa`, `.*`, `.a[w]s`). The shell only matches a leading dot written
 * literally, and the credential stores are almost all hidden, so this covers the globs the literal scan misses.
 */
const HIDDEN_GLOB = /(?:^|[\s/=:'"])\.[^\s/]*[*?[]/;
const ENV_FILE = /(?:^|[^a-z0-9_$])\.env(?:rc|[.\-_][a-z0-9_.-]*)?(?![a-z0-9_])/i;
const GIT_INTERNALS = [/\.git\/(?:hooks|config)(?![a-z0-9_-])/i, word("hookspath|fsmonitor|sshcommand")];
/**
 * `git config` that sets something. `diff.external`, `core.pager`, a `textconv` or `filter` driver, an alias
 * starting `!`: each makes a later `git diff` or `git log` (on the read-only list) run a program. Reading
 * (`--get…`, `--list`, `-l`, `get`, `list`) is not covered.
 */
const GIT_CONFIG = /(?:^|[\s;&|(`])git(?:\s+-{1,2}[^\s]+(?:\s+[^-\s][^\s]*)?)*\s+config(?![a-z0-9_-])(?!\s+(?:--get[a-z-]*|--list|-l|get|list|--show-origin\s+--(?:get[a-z-]*|list)))/i;

function segmentPattern(segments: readonly string[]): RegExp {
  const body = segments.map(escapeRegExp).join("/");
  return new RegExp(`(?:^|[^a-z0-9_-])${body}(?![a-z0-9_-])`, "i");
}
const CREDENTIAL_TEXT = [...CREDENTIAL_SEGMENTS.map((s) => segmentPattern([s])), ...CREDENTIAL_RUNS.map(segmentPattern)];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The spellings of a command the detectors look at, all lower case. */
export function commandSpellings(command: string, home: string): string[] {
  const unquoted = command.replace(/['"\\]/g, "");
  const slashed = command.replace(/['"]/g, "").replace(/\\/g, "/");
  const out = new Set<string>();
  for (const base of [command, unquoted, slashed]) {
    const expanded = expandHome(base, home);
    out.add(base);
    out.add(expanded);
    out.add(expanded.replace(/[$(){}`]/g, ""));
  }
  return [...out].map((s) => s.toLowerCase());
}

function expandHome(text: string, home: string): string {
  if (!home) return text;
  return text
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home)
    .replace(/(^|[\s=:(|;&'"`])~(?=$|[\s/\\'"`;|&)])/g, (_m, before: string) => `${before}${home}`);
}

/** Every always-ask rule for command text, in the order they are reported. */
export function commandAlwaysAsk(command: string, env: RuleEnv): string | null {
  if (typeof command !== "string" || command.length === 0) return null;
  const spellings = commandSpellings(command, env.home);
  const any = (re: RegExp | readonly RegExp[]): boolean => spellings.some((s) => (Array.isArray(re) ? re : [re as RegExp]).some((r) => r.test(s)));

  if (any(PRIVILEGE)) return "It runs something as another user (sudo, doas, su), which is always put to you.";
  if (any(DOWNLOADER) && any(INTERPRETER)) return "It downloads something and runs a shell or interpreter, which is always put to you.";
  if (any(PIPE_TO_SHELL)) return "It pipes text into a shell, which is always put to you.";
  if (any(GIT) && any(PUSH) && any(FORCE_PUSH)) return "It may force-push or delete published history, which is always put to you.";
  if (any(HISTORY_REWRITE)) return "It rewrites git history, which is always put to you.";
  if (any(MEMTRO) && any(TOKEN)) return "It runs `memtro token`, which prints your Memtro key, so it is always put to you.";
  if (any(CREDENTIAL_PRINT)) return "It prints a stored credential, which is always put to you.";
  if (any(ENVIRONMENT_DUMP)) return "It may print secrets from the environment, which is always put to you.";
  if (mentionsConfigDir(spellings, env)) return "It touches memtro's own configuration and credentials, which is always put to you.";
  if (any(CREDENTIAL_TEXT)) return "It touches a credential store, which is always put to you.";
  if (any(KEYCHAIN)) return "It touches a keychain or secret store, which is always put to you.";
  if (any(KEY_FILE)) return "It touches a private key, which is always put to you.";
  if (any(HIDDEN_GLOB)) return "It uses a wildcard over hidden files, which could reach a credential store, so it is always put to you.";
  if (any(ENV_FILE)) return "It touches a `.env` file, which is always put to you when run as a command.";
  if (any(GIT_INTERNALS)) return "It touches git hooks or configuration that can run commands, which is always put to you.";
  if (any(GIT_CONFIG)) return "It changes git's configuration, which can make later git commands run programs, so it is always put to you.";
  return null;
}

/** The harness's config directory, absolute or relative to home, in any of the spellings. */
function mentionsConfigDir(spellings: readonly string[], env: RuleEnv): boolean {
  if (typeof env.configDir !== "string" || env.configDir.length === 0) return false;
  const slashed = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const config = slashed(env.configDir);
  const forms = new Set<string>([config, env.configDir.replace(/[\\/]+$/, "").replace(/\\/g, "").toLowerCase()]);
  const home = slashed(env.home ?? "");
  // Relative to home too (`cd ~ && cat .config/memtro/credentials.json`), when that is still distinctive.
  if (home && config.startsWith(`${home}/`)) {
    const tail = config.slice(home.length + 1);
    if (tail.includes("/")) forms.add(tail);
  }
  return [...forms].filter((f) => f.length > 1).some((f) => spellings.some((s) => containsBounded(s, f)));
}

/** `needle` in `text` with no letter, digit, `_`, `-` (or `.` before) glued to either end. */
function containsBounded(text: string, needle: string): boolean {
  let at = text.indexOf(needle);
  while (at >= 0) {
    const before = at === 0 ? undefined : text[at - 1];
    const after = text[at + needle.length];
    const cleanBefore = before === undefined || !/[a-z0-9_.-]/.test(before) || needle.startsWith("/");
    const cleanAfter = after === undefined || !/[a-z0-9_-]/.test(after);
    if (cleanBefore && cleanAfter) return true;
    at = text.indexOf(needle, at + 1);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// A whole call
// ---------------------------------------------------------------------------------------------------------------

/** Why this call is always put to the person, or null when no always-ask rule covers it. */
export function alwaysAskReason(call: { risk: Risk; summary: CallSummary }, env: RuleEnv): string | null {
  const summary = call.summary ?? { title: "" };
  if (call.risk === "execute" && typeof summary.command === "string") {
    const reason = commandAlwaysAsk(summary.command, env);
    if (reason) return reason;
  }
  // Paths from any tool are checked; an `execute` naming paths is judged as if it wrote them.
  const access = call.risk === "read" || call.risk === "remote-read" ? "read" : "write";
  for (const path of Array.isArray(summary.paths) ? summary.paths : []) {
    const reason = pathAlwaysAsk(path, access, env);
    if (reason) return reason;
  }
  return null;
}
