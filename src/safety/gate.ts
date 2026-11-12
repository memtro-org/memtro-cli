/**
 * May this call run? The seven steps of the spec, in order, each settled by a named pure helper. The first step
 * that decides, decides; a later step can never loosen an earlier one.
 *
 *   1. Mode `unchecked`                         → allow (mode)
 *   2. An always-ask rule covers it             → ask (rule); nothing below can change that
 *   3. `read` inside the workspace, `remote-read` → allow (rule)
 *   4. A session rule matches                   → allow (session)
 *   5. Mode `ask` (or `auto` with no classifier) → ask (mode)
 *   6. Mode `auto`: a write inside the workspace, or a command on the read-only list → allow (rule);
 *      anything else → the classifier
 *   7. The classifier unavailable, slow, failed or unreadable → ask (fallback)
 */

import { realpathSync } from "node:fs";
import type { Decision, GateContext, Mode, PendingCall, SessionRule } from "../agent/types.js";
import { classify, fallback, type ClassifierOptions } from "./classifier.js";
import { allInside, isInside } from "./paths.js";
import { alwaysAskReason, pathAlwaysAsk, type RuleEnv } from "./rules.js";
import { ruleMatches } from "./session-rules.js";
import { commandSegments, pathCandidates, readOnlyCommand } from "./shell.js";

export interface GateState {
  mode: Mode;
  classifier: ClassifierOptions | null;
  rules: readonly SessionRule[];
  home: string;
  platform: NodeJS.Platform;
  configDir: string;
  /** Where an existing path really is, for the symlink test on a read-only command's arguments. Null: not asked. */
  realpath?: ((path: string) => string | null) | null;
}

/** The disk's answer, for the gate in production. */
export function diskRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * A workspace that is the home directory, or above it, is not a project: "inside the workspace" would then cover
 * `~/.zshrc`, `~/Library/LaunchAgents` and every recursive search through `~/.ssh`. Nothing is free there.
 */
export function broadWorkspace(workspaceRoot: string, home: string, platform: NodeJS.Platform, realpath?: ((path: string) => string | null) | null): boolean {
  if (!home) return false;
  if (isInside(home, workspaceRoot, platform)) return true;
  const real = realpath?.(home);
  return Boolean(real && isInside(real, workspaceRoot, platform));
}

const RISKS = new Set(["read", "write", "execute", "remote-read", "remote-act"]);

export async function decide(call: PendingCall, ctx: GateContext, state: GateState): Promise<Decision> {
  assertWellFormed(call, ctx);
  const env: RuleEnv = { home: state.home, platform: state.platform, configDir: state.configDir, workspaceRoot: ctx.workspaceRoot };

  // 1. Unchecked: nothing is judged.
  if (state.mode === "unchecked") return { verdict: "allow", reason: "Unchecked mode: nothing is judged or asked.", source: "mode" };

  // 2. Always-ask rules.
  const always = alwaysAskReason(call, env) ?? linkedCredentialReason(call, ctx, env, state.realpath ?? null);
  if (always) return { verdict: "ask", reason: always, source: "rule" };

  const broad = broadWorkspace(ctx.workspaceRoot, state.home, state.platform, state.realpath);

  // 3. Reads that need nobody.
  const freeRead = freeReadReason(call, ctx, state.platform, broad);
  if (freeRead) return { verdict: "allow", reason: freeRead, source: "rule" };

  // 4. Session rules.
  const rule = state.rules.find((r) => ruleMatches(r, call, state.platform, { cwd: ctx.cwd, workspaceRoot: ctx.workspaceRoot }));
  if (rule) return { verdict: "allow", reason: sessionReason(rule), source: "session" };

  // 5. Ask mode, and auto with no classifier, which behaves exactly as ask.
  if (state.mode === "ask" || !state.classifier) return { verdict: "ask", reason: askModeReason(state.mode), source: "mode" };

  // 6. Auto: what needs no model call, then the classifier.
  const autoAllow = broad ? null : autoAllowReason(call, ctx, state.platform, state.realpath ?? undefined);
  if (autoAllow) return { verdict: "allow", reason: autoAllow, source: "rule" };

  // 7. The classifier, which answers `fallback` ask whenever it cannot give a readable answer in time.
  return classify(call, ctx, state.classifier);
}

/** A call the gate cannot read is not judged at all: the caller turns the throw into the fallback ask. */
function assertWellFormed(call: PendingCall, ctx: GateContext): void {
  if (!call || typeof call !== "object" || typeof call.tool !== "string" || !RISKS.has(call.risk)) throw new Error("malformed call");
  if (!call.summary || typeof call.summary !== "object") throw new Error("malformed summary");
  if (call.risk === "execute" && typeof call.summary.command !== "string") throw new Error("a command call names no command");
  if (!ctx || typeof ctx.workspaceRoot !== "string" || typeof ctx.cwd !== "string") throw new Error("malformed context");
}

/**
 * Step 2, for a command: an argument that leads through a symbolic link into a credential store, `.git` or a
 * start-up file. The text scan sees `cat notes.txt`; the disk knows `notes.txt` is `~/.ssh/id_rsa`. Judged as a
 * write, since a command may do either with what it names.
 */
export function linkedCredentialReason(call: PendingCall, ctx: GateContext, env: RuleEnv, realpath: ((path: string) => string | null) | null): string | null {
  if (!realpath || call.risk !== "execute" || typeof call.summary.command !== "string") return null;
  const split = commandSegments(call.summary.command, env.platform);
  if (!split.ok) return null;
  const cwd = ctx.cwd.replace(/\/+$/, "");
  for (const words of split.segments) {
    for (const arg of words.slice(1)) {
      for (const candidate of pathCandidates(arg)) {
        const absolute = candidate.startsWith("/") ? candidate : `${cwd}/${candidate}`;
        const real = realpath(absolute);
        if (real === null || real === absolute) continue;
        const reason = pathAlwaysAsk(real, "write", env);
        if (reason) return `\`${arg}\` leads through a symbolic link to ${real}; ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
      }
    }
  }
  return null;
}

/** Step 3. */
export function freeReadReason(call: PendingCall, ctx: GateContext, platform: NodeJS.Platform, broad = false): string | null {
  if (call.risk === "remote-read") return "It only reads from Memtro, which applies its own permissions.";
  if (call.risk === "read" && !broad && allInside(call.summary.paths, ctx.workspaceRoot, platform)) return "It only reads inside the workspace.";
  return null;
}

/** Step 6, before the classifier. */
export function autoAllowReason(call: PendingCall, ctx: GateContext, platform: NodeJS.Platform, realpath?: (path: string) => string | null): string | null {
  if (call.risk === "write" && allInside(call.summary.paths, ctx.workspaceRoot, platform)) return "Auto mode: it writes only inside the workspace.";
  if (call.risk === "execute" && typeof call.summary.command === "string") {
    const ro = readOnlyCommand(call.summary.command, { platform, cwd: ctx.cwd, workspaceRoot: ctx.workspaceRoot, ...(realpath ? { realpath } : {}) });
    if (ro.ok) return "Auto mode: every command in it is on the read-only list.";
  }
  return null;
}

function sessionReason(rule: SessionRule): string {
  switch (rule.kind) {
    case "command":
      return "You allowed this exact command for the session.";
    case "command-prefix":
      return `You allowed \`${rule.words.join(" ")}\` commands for the session.`;
    case "write-under":
      return `You allowed writes under ${rule.dir} for the session.`;
    case "tool":
      return `You allowed ${rule.tool} for the session.`;
  }
}

function askModeReason(mode: Mode): string {
  return mode === "ask"
    ? "Ask mode: this is put to you."
    : "Auto mode has no classifier available, so it behaves as ask mode: this is put to you.";
}

export { fallback };
