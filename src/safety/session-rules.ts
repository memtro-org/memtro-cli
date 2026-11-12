/**
 * Session rules: what the person agreed to for the rest of the session, and what "allow for this session" offers.
 *
 * A session rule can only widen what the person already saw and agreed to; it can never reach a call an always-ask
 * rule covers, because the gate checks those first (step 2) and because `acceptRule` refuses a rule whose whole
 * point is one of them. Each kind matches one risk only: a `command`/`command-prefix` rule matches `execute`, a
 * `write-under` rule matches `write`, a `tool` rule matches the remote risks, so a rule for one thing never allows
 * another (a `tool` rule naming `bash` allows no command).
 */

import type { PendingCall, SessionRule } from "../agent/types.js";
import { absoluteSegments, allInside, isInside, parentDir } from "./paths.js";
import { commandAlwaysAsk, pathAlwaysAsk, type RuleEnv } from "./rules.js";
import { outsideWorkspace, simpleCommand } from "./shell.js";

// ---------------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------------

/**
 * An option whose name says it runs a program, loads code or configuration, or writes output somewhere:
 * `--upload-pack=`, `--script-shell=`, `--node-options=`, `-exec=`, `--config`, `--output`, `--template`…
 */
const RUNS_OR_REDIRECTS = /^-{1,2}[a-z0-9-]*(?:exec|pack|shell|pager|editor|program|hook|cmd|command|config|template|node-options|require|loader|import|eval|output|prefix|ssh|proxy|ext-diff|textconv|interpreter|runner|wrapper|plugin)/i;

/**
 * Why the arguments after a prefix rule's words take the command somewhere the person did not agree to, or null.
 * "Allow `npm test` for the session" is agreement to the tests, not to `npm test --script-shell=./x`,
 * `git fetch --upload-pack=…`, `git log --output=/home/me/.zshrc` or `make SHELL=./x`.
 */
export function prefixArgumentsRefusal(extra: readonly string[], platform: NodeJS.Platform, where?: { cwd: string; workspaceRoot: string }): string | null {
  if (extra.length === 0) return null;
  for (const arg of extra) {
    if (RUNS_OR_REDIRECTS.test(arg)) return `\`${arg}\` can make the command run or write something else`;
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(arg)) return `\`${arg}\` sets a variable the command may run`;
  }
  if (!where) {
    return extra.some((a) => a.startsWith("/") || /(?:^|[\\/=:]|^-[A-Za-z]+)\.\.(?:$|[\\/])/.test(a) || a.includes("=/")) ? "it names a path that cannot be placed" : null;
  }
  return outsideWorkspace(extra, { platform, cwd: where.cwd, workspaceRoot: where.workspaceRoot });
}

/** True when this rule allows this call. `where` is where the call was checked; prefix rules need it for paths. */
export function ruleMatches(rule: SessionRule, call: PendingCall, platform: NodeJS.Platform, where?: { cwd: string; workspaceRoot: string }): boolean {
  const summary = call.summary;
  switch (rule.kind) {
    case "command":
      return call.risk === "execute" && typeof summary.command === "string" && summary.command === rule.command;
    case "command-prefix": {
      if (call.risk !== "execute" || typeof summary.command !== "string") return false;
      const simple = simpleCommand(summary.command, platform);
      if (!simple.ok || simple.words.length < rule.words.length) return false;
      if (!rule.words.every((w, i) => simple.words[i] === w)) return false;
      return prefixArgumentsRefusal(simple.words.slice(rule.words.length), platform, where) === null;
    }
    case "write-under":
      return call.risk === "write" && allInside(summary.paths, rule.dir, platform);
    case "tool":
      return (call.risk === "remote-act" || call.risk === "remote-read") && call.tool === rule.tool;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Accepting a rule (remember, and the headless allowances)
// ---------------------------------------------------------------------------------------------------------------

/** A clean copy of the rule when it may be recorded, or null when it must be refused. */
export function acceptRule(rule: unknown, env: RuleEnv): SessionRule | null {
  if (!rule || typeof rule !== "object") return null;
  const r = rule as Record<string, unknown>;
  switch (r.kind) {
    case "command": {
      if (typeof r.command !== "string" || r.command.trim() === "") return null;
      if (commandAlwaysAsk(r.command, env)) return null;
      return { kind: "command", command: r.command };
    }
    case "command-prefix": {
      if (!Array.isArray(r.words) || r.words.length === 0) return null;
      const words = r.words as unknown[];
      if (!words.every((w): w is string => typeof w === "string" && w.length > 0)) return null;
      if (commandAlwaysAsk(words.join(" "), env)) return null;
      return { kind: "command-prefix", words: [...words] };
    }
    case "write-under": {
      if (typeof r.dir !== "string") return null;
      const segments = absoluteSegments(r.dir, env.platform);
      if (!segments) return null;
      const rootLength = env.platform === "win32" ? 1 : 0;
      if (segments.length <= rootLength) return null; // the whole disk
      if (env.home && isInside(env.home, r.dir, env.platform)) return null; // home, or above it
      if (pathAlwaysAsk(r.dir, "write", env)) return null;
      return { kind: "write-under", dir: r.dir };
    }
    case "tool": {
      if (typeof r.tool !== "string" || r.tool.trim() === "") return null;
      return { kind: "tool", tool: r.tool };
    }
    default:
      return null;
  }
}

export function sameRule(a: SessionRule, b: SessionRule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------------------------------------------
// Suggesting a rule
// ---------------------------------------------------------------------------------------------------------------

/**
 * Programs for which "allow for the session" may offer `<program> <subcommand>` rather than the exact command.
 * Everything else, and every interpreter, gets the exact command only.
 */
export const PREFIX_PROGRAMS = ["git", "npm", "pnpm", "yarn", "cargo", "go", "make"] as const;

/** Programs that run arbitrary code from their arguments: never offered as a prefix. Documentation as much as code. */
export const NEVER_PREFIX = [
  "bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "node", "nodejs", "deno", "bun", "python", "python3",
  "python2", "ruby", "perl", "php", "lua", "pwsh", "powershell", "cmd", "npx", "pnpx", "bunx", "uvx", "env", "xargs",
  "eval", "exec", "command", "builtin", "sudo", "doas", "su", "nohup", "time", "timeout", "nice", "watch", "ssh",
  "docker", "kubectl", "osascript", "awk", "sed", "find",
] as const;

/** Subcommands that run arbitrary code, install it, publish, push or change configuration: exact command only. */
const EXACT_ONLY_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ["config", "submodule", "bisect", "rebase", "difftool", "mergetool", "push", "remote", "credential", "daemon", "filter-branch", "filter-repo", "worktree", "hook", "send-email"],
  npm: ["exec", "x", "explore", "install", "i", "add", "update", "upgrade", "up", "link", "publish", "config", "set", "token", "login", "adduser", "init", "create", "dlx"],
  pnpm: ["exec", "dlx", "x", "install", "i", "add", "update", "upgrade", "up", "link", "publish", "config", "set", "login", "create", "env"],
  yarn: ["exec", "dlx", "node", "add", "install", "upgrade", "up", "link", "publish", "config", "set", "npm", "create", "plugin"],
  cargo: ["install", "publish", "login", "owner", "yank", "add", "script"],
  go: ["run", "install", "get", "tool", "env", "generate"],
};

/** Subcommands whose third word names what they run: offered as three words when that word is a plain name. */
const SCRIPT_RUNNERS: Record<string, readonly string[]> = {
  npm: ["run", "run-script"],
  pnpm: ["run"],
  yarn: ["run"],
  cargo: ["run"],
};

const PLAIN_SUBCOMMAND = /^[a-z][a-z0-9-]*$/;
const PLAIN_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/** The words a `command-prefix` rule may cover for this simple command, or null for the exact command only. */
export function prefixFor(words: readonly string[]): string[] | null {
  const [program, sub, third] = words;
  if (program === undefined || sub === undefined) return null;
  if ((NEVER_PREFIX as readonly string[]).includes(program)) return null;
  if (!(PREFIX_PROGRAMS as readonly string[]).includes(program)) return null;
  if (!PLAIN_SUBCOMMAND.test(sub)) return null;
  if ((EXACT_ONLY_SUBCOMMANDS[program] ?? []).includes(sub)) return null;
  if ((SCRIPT_RUNNERS[program] ?? []).includes(sub)) {
    return third !== undefined && PLAIN_SCRIPT.test(third) ? [program, sub, third] : null;
  }
  return [program, sub];
}

/**
 * The rule "allow for this session" would record, never broader than the call, or null when the call may only be
 * allowed once. `workspaceRoot` is where the call was checked; without it no write rule is offered.
 */
export function suggestFor(call: PendingCall, env: RuleEnv): SessionRule | null {
  switch (call.risk) {
    case "execute": {
      const command = call.summary.command;
      if (typeof command !== "string" || command.trim() === "") return null;
      const simple = simpleCommand(command, env.platform);
      const prefix = simple.ok ? prefixFor(simple.words) : null;
      const rule: SessionRule = prefix ? { kind: "command-prefix", words: prefix } : { kind: "command", command };
      return acceptRule(rule, env);
    }
    case "write": {
      const paths = call.summary.paths;
      if (!env.workspaceRoot || !Array.isArray(paths) || paths.length === 0) return null;
      const dirs = new Set(paths.map((p) => parentDir(p, env.platform)));
      if (dirs.size !== 1) return null;
      const [dir] = [...dirs];
      if (!dir || !isInside(dir, env.workspaceRoot, env.platform)) return null;
      if (!allInside(paths, dir, env.platform)) return null;
      return acceptRule({ kind: "write-under", dir }, env);
    }
    case "remote-act":
    case "remote-read":
      return acceptRule({ kind: "tool", tool: call.tool }, env);
    default:
      return null;
  }
}
