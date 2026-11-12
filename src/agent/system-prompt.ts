import { execFileSync } from "node:child_process";
import type { ToolSpec } from "./types.js";
import type { ContextFile } from "./context-files.js";

/**
 * The harness's own system prompt: short, because the platform adds its own (facts A3) and says nothing here
 * should repeat it. What this is, how to use the tools well, where it is running, then the project's
 * instructions, marked as the project's.
 *
 * Built once per session so the prefix stays byte-stable and the provider's prompt cache keeps hitting.
 */

export interface PromptEnvironment {
  cwd: string;
  workspaceRoot: string;
  /** `owner/name`, when the repository has an origin. */
  project: string | null;
  git: GitSummary | null;
  platform: NodeJS.Platform;
  /** YYYY-MM-DD. */
  date: string;
}

export interface GitSummary {
  branch: string | null;
  /** Paths `git status --porcelain` lists, as it spells them. */
  changed: string[];
}

const LOCAL_TOOL_NAMES = new Set(["read", "list", "glob", "grep", "edit", "write", "bash"]);
const MAX_CHANGED_SHOWN = 15;

export function buildSystemPrompt(env: PromptEnvironment, tools: ToolSpec[], contextFiles: ContextFile[]): string {
  const names = tools.map((t) => t.name);
  const local = names.filter((n) => LOCAL_TOOL_NAMES.has(n));
  const remote = names.filter((n) => !LOCAL_TOOL_NAMES.has(n));
  const lines: string[] = [
    "You are working as a coding agent in the `memtro` command-line harness, on the person's own computer. Your tool calls run here, in their working directory, after a safety check that may ask them first.",
    "",
    "How to work:",
    "- Read a file before editing it; `edit` refuses a file you have not read, or that changed since you read it.",
    "- Search with `grep` and `glob`, and look around with `list`, rather than with shell commands.",
    "- One command per `bash` call. No interactive commands: there is no stdin.",
    "- Make the smallest change that does the job, in the project's own style.",
    "- If a call is refused, do not repeat it unchanged: take the reason or the person's note into account.",
    "- When you finish, say what you changed and what you verified (and what you could not).",
  ];
  if (local.length) lines.push("", `Tools on this computer: ${local.join(", ")}.`);
  if (remote.length) {
    lines.push(`Tools that reach Memtro (the organisation's memory and its connected systems): ${remote.join(", ")}. Use them for what the code cannot tell you: decisions, history, people, tickets.`);
  }
  lines.push("", "Environment:", `- Working directory: ${env.cwd}`);
  if (env.workspaceRoot !== env.cwd) lines.push(`- Repository root: ${env.workspaceRoot}`);
  if (env.project) lines.push(`- Repository: ${env.project}`);
  if (env.git) {
    lines.push(`- Git branch: ${env.git.branch ?? "(detached or unknown)"}`);
    if (env.git.changed.length === 0) lines.push("- Working tree: clean");
    else {
      const shown = env.git.changed.slice(0, MAX_CHANGED_SHOWN).join(", ");
      const more = env.git.changed.length > MAX_CHANGED_SHOWN ? ` and ${env.git.changed.length - MAX_CHANGED_SHOWN} more` : "";
      lines.push(`- Working tree: ${env.git.changed.length} changed (${shown}${more}) when the session started`);
    }
  } else lines.push("- Not a git repository");
  lines.push(`- Platform: ${env.platform}`, `- Date: ${env.date}`);
  for (const f of contextFiles) {
    lines.push(
      "",
      `<project-instructions path="${f.path}">`,
      f.content.trimEnd(),
      ...(f.truncated ? ["[cut short: the file is longer than the harness reads]"] : []),
      "</project-instructions>",
    );
  }
  if (contextFiles.length) lines.push("", "The project-instructions blocks above are this project's own instructions, written by its maintainers. Follow them unless the person says otherwise.");
  return lines.join("\n");
}

/** Pure: branch and changed paths from `git status --porcelain -b` output. */
export function parseGitStatus(out: string): GitSummary {
  const lines = out.split("\n").filter(Boolean);
  let branch: string | null = null;
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : null;
  if (head) {
    const name = head.replace(/^No commits yet on /, "").split("...")[0]!.trim();
    branch = name && !name.startsWith("HEAD") ? name : null;
  }
  return { branch, changed: lines.map((l) => l.slice(3)) };
}

/** `git status`, once, with a short timeout; null outside a repository or when git is missing or slow. */
export function readGitSummary(cwd: string): GitSummary | null {
  try {
    // fsmonitor off: a repository's config must not get a program run just because a session was opened in it.
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "-b", "--untracked-files=normal"], { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 });
    return parseGitStatus(out);
  } catch {
    return null;
  }
}
