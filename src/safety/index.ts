/**
 * The gate: whether a tool call may run. See `gate.ts` for the order and `rules.ts` for what is always asked.
 *
 * This package depends on `src/agent/types.ts` and Node only. It logs nothing, prints nothing, writes nothing,
 * reads no file's contents (it resolves symbolic links in a read-only command's arguments, through `realpath`)
 * and reaches the network only through the injected `ForcedCall`.
 */

import type { Decision, ForcedCall, Gate, GateContext, Mode, PendingCall, SessionRule } from "../agent/types.js";
import { decide, diskRealpath, fallback } from "./gate.js";
import { alwaysAskReason, type RuleEnv } from "./rules.js";
import { acceptRule, sameRule, suggestFor } from "./session-rules.js";

export interface GateOptions {
  mode: Mode;
  /** Null when there is no classifier (turned off, or no transport): `auto` then behaves exactly as `ask`. */
  classifier: { call: ForcedCall; model: string; timeoutMs?: number } | null;
  /** Home directory and platform, injected so the credential-path rules are testable. */
  home: string;
  platform: NodeJS.Platform;
  /** The harness's own config directory, which is always-ask for reads and writes. */
  configDir: string;
  /** Headless allowances: `--allow-edits` and `--allow <prefix>` become session rules at start. */
  initialRules?: SessionRule[];
  /** Symlink resolution for read-only command arguments. Default: the disk; null turns the test off (pure tests). */
  realpath?: ((path: string) => string | null) | null;
}

const MODES: readonly Mode[] = ["ask", "auto", "unchecked"];
/** How many checked calls are remembered for `suggestRule`, which is not given the workspace. */
const REMEMBERED_CALLS = 256;

export function createGate(options: GateOptions): Gate {
  let mode: Mode = MODES.includes(options.mode) ? options.mode : "ask";
  const classifier = options.classifier ?? null;
  const rules: SessionRule[] = [];
  // `suggestRule(call)` has no context, so the workspace each call was checked in is kept by call id.
  const workspaces = new Map<string, string>();

  const envFor = (workspaceRoot: string | null): RuleEnv => ({
    home: options.home,
    platform: options.platform,
    configDir: options.configDir,
    workspaceRoot,
  });

  const gate: Gate = {
    get mode() {
      return mode;
    },
    setMode(next: Mode) {
      if (MODES.includes(next)) mode = next;
    },
    async check(call: PendingCall, ctx: GateContext): Promise<Decision> {
      try {
        if (call && typeof call.id === "string" && ctx && typeof ctx.workspaceRoot === "string") {
          workspaces.delete(call.id);
          workspaces.set(call.id, ctx.workspaceRoot);
          if (workspaces.size > REMEMBERED_CALLS) workspaces.delete(workspaces.keys().next().value as string);
        }
        return await decide(call, ctx, {
          mode,
          classifier,
          rules: [...rules],
          home: options.home,
          platform: options.platform,
          configDir: options.configDir,
          realpath: options.realpath === undefined ? diskRealpath : options.realpath,
        });
      } catch {
        return fallback("The gate could not judge this call, so it is put to you.");
      }
    },
    remember(rule: SessionRule) {
      try {
        const accepted = acceptRule(rule, envFor(null));
        if (accepted && !rules.some((r) => sameRule(r, accepted))) rules.push(accepted);
      } catch {
        // Refused silently, as the contract says.
      }
    },
    suggestRule(call: PendingCall): SessionRule | null {
      try {
        // Only for a call this gate has judged: the rule is offered for what the person is being shown.
        if (!call || typeof call.id !== "string" || !workspaces.has(call.id)) return null;
        const env = envFor(workspaces.get(call.id) ?? null);
        if (alwaysAskReason(call, env)) return null;
        return suggestFor(call, env);
      } catch {
        return null;
      }
    },
  };

  for (const rule of options.initialRules ?? []) gate.remember(rule);
  return gate;
}

export type { RuleEnv };
