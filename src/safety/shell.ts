/**
 * Two questions about a shell command, answered conservatively. This is deliberately NOT a shell parser.
 *
 * 1. "Is this a single simple command, and what are its words?" (`simpleCommand`), which a `command-prefix`
 *    session rule needs before it may match.
 * 2. "Is every segment on the read-only list?" (`readOnlyCommand`), which lets `auto` run a command without asking
 *    anybody.
 *
 * Quoting is understood just enough to split the words of a simple command: single quotes, double quotes with no
 * `$`, backtick, backslash or `!` inside, and backslash escapes outside quotes. Anything else the shell would expand
 * or reinterpret (variables, `$(`, backticks, `<(`, every redirection, here-docs, `&`, `||`, newlines, braces,
 * subshells, comments, `~`, `!`, environment prefixes) is "unsure", and unsure is never auto-allowed. On Windows the
 * command runs under `cmd.exe`, whose quoting and escapes differ, so every command there is "unsure".
 *
 * The always-ask detectors are elsewhere (`rules.ts`) and work the other way round: liberal scans of the raw text.
 */

import { absoluteSegments, isInside } from "./paths.js";

export type Unsure = { ok: false; reason: string };
export type Words = { ok: true; words: string[] };
export type Segments = { ok: true; segments: string[][]; /** Some word holds an unquoted glob character. */ globs: boolean };

interface Word {
  raw: string;
  value: string;
  /** An unquoted `*`, `?` or `[`: the shell would expand it to names nobody has seen. */
  glob: boolean;
}
type Token = { kind: "word"; word: Word } | { kind: "op"; op: "&&" | ";" | "|" };

const unsure = (reason: string): Unsure => ({ ok: false, reason });

function tokenize(command: string, platform: NodeJS.Platform): { ok: true; tokens: Token[] } | Unsure {
  if (typeof command !== "string") return unsure("there is no command");
  if (platform === "win32") return unsure("commands for cmd.exe are not analysed");
  const tokens: Token[] = [];
  let raw = "";
  let value = "";
  let glob = false;
  let inWord = false;
  const endWord = (): void => {
    if (inWord) tokens.push({ kind: "word", word: { raw, value, glob } });
    raw = "";
    value = "";
    glob = false;
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const code = c.charCodeAt(0);
    if (c === "\n" || c === "\r") return unsure("it spans more than one line");
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (code < 0x20 || code === 0x7f) return unsure("it contains a control character");
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return unsure("a quote is not closed");
      const inner = command.slice(i + 1, close);
      if (/[\n\r]/.test(inner)) return unsure("it spans more than one line");
      raw += command.slice(i, close + 1);
      value += inner;
      inWord = true;
      i = close;
      continue;
    }
    if (c === '"') {
      const close = command.indexOf('"', i + 1);
      if (close < 0) return unsure("a quote is not closed");
      const inner = command.slice(i + 1, close);
      if (/[$`\\!\n\r]/.test(inner)) return unsure("a double-quoted word could expand");
      raw += command.slice(i, close + 1);
      value += inner;
      inWord = true;
      i = close;
      continue;
    }
    if (c === "\\") {
      const next = command[i + 1];
      if (next === undefined) return unsure("it ends in a backslash");
      if (next === "\n" || next === "\r") return unsure("it spans more than one line");
      raw += c + next;
      value += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === "$") return unsure("it uses a variable or substitution");
    if (c === "`") return unsure("it uses command substitution");
    if (c === "<" || c === ">") return unsure("it uses redirection");
    if (c === "(" || c === ")") return unsure("it uses a subshell or process substitution");
    if (c === "{" || c === "}") return unsure("it uses braces");
    if (c === "!") return unsure("it uses `!`");
    if (c === "#" && !inWord) return unsure("it contains a comment");
    if (c === "~" && (!inWord || raw.endsWith("=") || raw.endsWith(":"))) return unsure("it uses `~` expansion");
    if (c === "&") {
      if (command[i + 1] === "&") {
        endWord();
        tokens.push({ kind: "op", op: "&&" });
        i++;
        continue;
      }
      return unsure("it runs something in the background");
    }
    if (c === "|") {
      if (command[i + 1] === "|") return unsure("it uses `||`");
      if (command[i + 1] === "&") return unsure("it pipes standard error");
      endWord();
      tokens.push({ kind: "op", op: "|" });
      continue;
    }
    if (c === ";") {
      endWord();
      tokens.push({ kind: "op", op: ";" });
      continue;
    }
    if (c === "*" || c === "?" || c === "[") glob = true;
    raw += c;
    value += c;
    inWord = true;
  }
  endWord();
  return { ok: true, tokens };
}

function toSegments(tokens: Token[]): Segments | Unsure {
  const segments: string[][] = [];
  let globs = false;
  let current: Word[] = [];
  const close = (): Unsure | null => {
    if (current.length === 0) return unsure("it has an empty command");
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(current[0]!.raw)) return unsure("it sets an environment variable");
    segments.push(current.map((w) => w.value));
    if (current.some((w) => w.glob)) globs = true;
    current = [];
    return null;
  };
  for (const token of tokens) {
    if (token.kind === "word") current.push(token.word);
    else {
      const failed = close();
      if (failed) return failed;
    }
  }
  const failed = close();
  if (failed) return failed;
  return { ok: true, segments, globs };
}

/** The words of a single simple command, or why it is not one. */
export function simpleCommand(command: string, platform: NodeJS.Platform): Words | Unsure {
  const tokenized = tokenize(command, platform);
  if (!tokenized.ok) return tokenized;
  if (tokenized.tokens.some((t) => t.kind === "op")) return unsure("it is more than one command");
  const split = toSegments(tokenized.tokens);
  if (!split.ok) return split;
  return { ok: true, words: split.segments[0]! };
}

/** The commands of a list joined by `&&`, `;` and `|`, or why the splitter is unsure. */
export function commandSegments(command: string, platform: NodeJS.Platform): Segments | Unsure {
  const tokenized = tokenize(command, platform);
  if (!tokenized.ok) return tokenized;
  return toSegments(tokenized.tokens);
}

// ---------------------------------------------------------------------------------------------------------------
// The read-only list
// ---------------------------------------------------------------------------------------------------------------

/** Programs whose every use is a read, apart from the options refused below. */
export const READ_ONLY_PROGRAMS = ["ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "which", "echo", "rg", "grep", "find"] as const;
/** Git subcommands that only read, apart from the options refused below. `branch` and `remote` are narrower still. */
export const READ_ONLY_GIT = ["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"] as const;
/** `<program> --version` (and `go version`). */
export const VERSION_PROGRAMS = ["node", "npm", "pnpm", "python", "python3", "go", "cargo", "git"] as const;

const BRANCH_LISTING_FLAGS = new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--no-color", "--color"]);

export interface ReadOnlyContext {
  platform: NodeJS.Platform;
  cwd: string;
  workspaceRoot: string;
  /**
   * Where an existing path really is (symlinks followed), or null when nothing is there. Given, an argument that
   * names something which resolves outside the workspace is refused: `cat notes.txt` where `notes.txt` is a link
   * to `~/.ssh/id_rsa` reads the key. Left out (pure tests), only the text of the arguments is judged.
   */
  realpath?: (path: string) => string | null;
}

/** Options that make a listed program follow symbolic links it meets while recursing, out of the workspace. */
function followsLinks(program: string, args: readonly string[]): string | null {
  for (const a of args) {
    if (a === "--") break;
    if (program === "grep") {
      // GNU getopt takes any unambiguous prefix of a long option: `--der` is `--dereference-recursive`.
      if (a.startsWith("--der") || (/^-[^-]/.test(a) && /[RS]/.test(a))) return `\`grep ${a}\` follows symbolic links`;
    }
    if (program === "rg" && (a === "--follow" || (/^-[^-]/.test(a) && a.includes("L")))) return `\`rg ${a}\` follows symbolic links`;
    if (program === "find" && (a === "-L" || a === "-H" || a === "-follow")) return `\`find ${a}\` follows symbolic links`;
  }
  return null;
}

/** Why one segment is not on the list, or null when it is. */
export function segmentRefusal(words: readonly string[], ctx: ReadOnlyContext): string | null {
  const [program, ...args] = words;
  if (program === undefined) return "it is empty";
  if (args.length === 1 && args[0] === "--version" && (VERSION_PROGRAMS as readonly string[]).includes(program)) return null;
  if (program === "go" && args.length === 1 && args[0] === "version") return null;

  const outside = outsideWorkspace(args, ctx);
  if (outside) return outside;

  if (program === "git") return gitRefusal(args);
  if (!(READ_ONLY_PROGRAMS as readonly string[]).includes(program)) return `\`${program}\` is not on the read-only list`;
  if (program === "find") {
    const bad = args.find((a) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fls"].some((p) => a.startsWith(p)));
    if (bad) return `\`find ${bad}\` can run or change things`;
  }
  if (program === "rg") {
    const bad = args.find((a) => a.startsWith("--pre") || a.startsWith("--hostname-bin") || a.startsWith("--search-zip") || (/^-[^-]/.test(a) && a.includes("z")));
    if (bad) return `\`rg ${bad}\` runs another program`;
  }
  if (program === "file" && args.some((a) => a === "-C" || a.startsWith("--compile"))) return "`file -C` writes a file";
  return followsLinks(program, args);
}
function gitRefusal(args: readonly string[]): string | null {
  const [sub, ...rest] = args;
  if (sub === undefined) return "`git` with no subcommand is not on the read-only list";
  if (sub.startsWith("-")) return "git options before the subcommand are not on the read-only list";
  if ((READ_ONLY_GIT as readonly string[]).includes(sub)) {
    const bad = rest.find((a) => a.startsWith("--output") || a === "--ext-diff" || a.startsWith("--exec"));
    return bad ? `\`git ${sub} ${bad}\` can write or run things` : null;
  }
  if (sub === "branch") {
    const listing = rest.includes("--list") || rest.includes("-l");
    for (const a of rest) {
      if (a.startsWith("-")) {
        if (!BRANCH_LISTING_FLAGS.has(a)) return `\`git branch ${a}\` can change branches`;
      } else if (!listing) {
        return "`git branch <name>` creates a branch";
      }
    }
    return null;
  }
  if (sub === "remote") {
    if (rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"))) return null;
    return "only `git remote -v` is on the read-only list";
  }
  return `\`git ${sub}\` is not on the read-only list`;
}

/** `..` as a path segment, including one glued to a short option (`-f../x`). */
const PARENT = /(?:^|[\\/=:]|^-[A-Za-z]+)\.\.(?:$|[\\/])/;

/**
 * Refuses an argument that names a place outside the workspace: an absolute path elsewhere, any `..`, and (when
 * the disk can be asked) anything that resolves outside it through a symbolic link.
 */
export function outsideWorkspace(args: readonly string[], ctx: ReadOnlyContext): string | null {
  if (!isInside(ctx.cwd, ctx.workspaceRoot, ctx.platform)) return "the working directory is outside the workspace";
  for (const arg of args) {
    if (PARENT.test(arg)) return "it names a path with `..`";
    for (const candidate of absoluteCandidates(arg)) {
      if (absoluteSegments(candidate, ctx.platform) === null) continue;
      if (!isInside(candidate, ctx.workspaceRoot, ctx.platform)) return "it names a path outside the workspace";
    }
  }
  if (ctx.realpath) {
    const root = ctx.realpath(ctx.workspaceRoot) ?? ctx.workspaceRoot;
    for (const arg of args) {
      for (const candidate of pathCandidates(arg)) {
        const absolute = candidate.startsWith("/") ? candidate : `${ctx.cwd.replace(/\/+$/, "")}/${candidate}`;
        const real = ctx.realpath(absolute);
        if (real !== null && !isInside(real, root, ctx.platform)) return `\`${arg}\` leads outside the workspace through a symbolic link`;
      }
    }
  }
  return null;
}

function absoluteCandidates(arg: string): string[] {
  const out: string[] = [];
  if (arg.startsWith("/")) out.push(arg);
  const eq = arg.indexOf("=");
  if (eq >= 0 && arg[eq + 1] === "/") out.push(arg.slice(eq + 1));
  const attached = /^-[A-Za-z]+(\/.*)$/.exec(arg);
  if (attached) out.push(attached[1]!);
  return out;
}

/** Every reading of an argument as a path: itself, the value after `=`, and what follows a short option's letters. */
export function pathCandidates(arg: string): string[] {
  if (!arg) return [];
  const out = new Set<string>([arg]);
  const eq = arg.indexOf("=");
  if (eq >= 0 && eq + 1 < arg.length) out.add(arg.slice(eq + 1));
  const short = /^-([A-Za-z]+)(.*)$/.exec(arg);
  if (short) {
    const letters = short[1]!;
    for (let i = 1; i <= letters.length; i++) {
      const rest = letters.slice(i) + short[2]!;
      if (rest) out.add(rest);
    }
  }
  return [...out];
}

/** Whether `auto` may run this command without a model call: every segment on the read-only list. */
export function readOnlyCommand(command: string, ctx: ReadOnlyContext): { ok: true } | Unsure {
  const split = commandSegments(command, ctx.platform);
  if (!split.ok) return split;
  if (split.globs) return unsure("it uses an unquoted wildcard, which could name a link out of the workspace");
  for (const segment of split.segments) {
    const refusal = segmentRefusal(segment, ctx);
    if (refusal) return unsure(refusal);
  }
  return { ok: true };
}
