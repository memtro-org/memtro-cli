import { str } from "../args.js";
import { updateCheckSetting } from "../config.js";
import type { Context } from "../context.js";
import { errorText, EXIT, UsageError } from "../errors.js";
import { writeJson } from "../output.js";
import { oneLine, sanitise } from "../tui/sanitise.js";
import type * as UpdateModule from "../update/index.js";
import type { UpdateInfo, UpdateOutcome } from "../update/index.js";

/**
 * `memtro update` and `/update`, and the one line a session starts with when a newer release is known.
 *
 * The update machinery itself is `src/update/`; this is how its answers are put to a person. Everything it hands
 * back that came from the network (a version, a reason) is cleaned before it reaches a terminal.
 */

export type UpdateApi = Pick<typeof UpdateModule, "cachedUpdate" | "refreshUpdateCache" | "updateCheckDisabled" | "performUpdate" | "defaultUpdateDeps">;

/** Loaded when first needed, so starting a command never waits on it and a test hands in its own. */
export const loadUpdateApi = (): Promise<UpdateApi> => import("../update/index.js");

/** A version string fit to print: x.y.z with an optional pre-release, or null. It may have come from the network. */
export function cleanVersion(v: unknown): string | null {
  return typeof v === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v) ? v : null;
}

/** The session's first-lines notice, or null when there is nothing newer (or the cache holds something odd). */
export function updateNotice(info: UpdateInfo | null): string | null {
  if (!info?.newer) return null;
  const latest = cleanVersion(info.latest);
  const current = cleanVersion(info.current);
  if (!latest || !current) return null;
  return `memtro ${latest} is available (you have ${current}). Type /update.`;
}

/**
 * At the start of an interactive session: the cached answer of the last check, shown when it is newer, and a fresh
 * check started in the background for next time. Nothing waits for that check and nothing it does is printed;
 * the returned function stops it when the session ends. Never with --json or when stdout is not a terminal (the
 * session's caller only runs in a terminal; this says so again rather than trust it).
 */
export async function startUpdateCheck(ctx: Context, show: (line: string) => void, api?: UpdateApi): Promise<() => void> {
  const none = () => {};
  if (ctx.json || !ctx.stdout.isTTY) return none;
  let configured: boolean | undefined;
  try {
    configured = updateCheckSetting(ctx.config);
  } catch (err) {
    show(errorText(err));
    return none;
  }
  try {
    const a = api ?? (await loadUpdateApi());
    if (a.updateCheckDisabled(ctx.env, configured)) return none;
    const deps = a.defaultUpdateDeps(ctx.env);
    const notice = updateNotice(a.cachedUpdate(deps));
    if (notice) show(notice);
    const controller = new AbortController();
    // Not awaited: start-up and exit never wait on the network. Its failure is nobody's business.
    void Promise.resolve()
      .then(() => a.refreshUpdateCache(deps, controller.signal))
      .catch(() => {});
    return () => controller.abort();
  } catch {
    return none;
  }
}

/** The outcome in words, and the exit code `memtro update` returns for it. */
export function describeOutcome(o: UpdateOutcome): { text: string; code: number; ok: boolean } {
  switch (o.kind) {
    case "updated": {
      const to = cleanVersion(o.to) ?? "the new version";
      const next = "It starts the next time you run memtro.";
      if (o.attestation === "verified") return { text: `Updated to ${to} (build attestation verified). ${next}`, code: EXIT.ok, ok: true };
      const why = oneLine(o.detail ?? "no reason was given").replace(/\.$/, "");
      return {
        text: `Updated to ${to}. The build attestation could not be checked: ${why}. The download matched its published checksum. ${next}`,
        code: EXIT.ok,
        ok: true,
      };
    }
    case "current": {
      const v = cleanVersion(o.version);
      return { text: v ? `memtro ${v} is the latest release; nothing to do.` : "This is the latest release; nothing to do.", code: EXIT.ok, ok: true };
    }
    case "unmanaged":
      return { text: `This memtro cannot update itself: ${oneLine(o.reason)}\n${sanitise(o.howTo)}`, code: EXIT.usage, ok: false };
    case "failed":
      return { text: `The update failed: ${oneLine(o.reason)}\nNothing was replaced; this memtro still works as it did.`, code: EXIT.failure, ok: false };
  }
}

/** `--version 0.3.0` or `v0.3.0`, as the bare version; a usage error for anything else. */
export function requestedVersion(flag: unknown): string | undefined {
  const raw = str(flag);
  if (raw === undefined) return undefined;
  const v = cleanVersion(raw.replace(/^v/, ""));
  if (!v) throw new UsageError(`--version must be a release number like 0.3.0; got "${oneLine(raw)}".`);
  return v;
}

/** One update, its progress shown through `progress`. Never rejects for a failed update: that is an outcome. */
export async function runUpdate(api: UpdateApi, env: NodeJS.ProcessEnv, opts: { version?: string; signal: AbortSignal; progress: (line: string) => void }): Promise<UpdateOutcome> {
  return api.performUpdate(api.defaultUpdateDeps(env), {
    ...(opts.version ? { version: opts.version } : {}),
    signal: opts.signal,
    onProgress: (text) => opts.progress(oneLine(text)),
  });
}

/** `memtro update [--version x.y.z]`: exit 0 updated or current, 1 failed, 2 this install cannot update itself. */
export async function update(ctx: Context, api?: UpdateApi): Promise<number> {
  const version = requestedVersion(ctx.flags.version);
  const a = api ?? (await loadUpdateApi());
  const controller = new AbortController();
  const onInt = () => controller.abort();
  process.once("SIGINT", onInt);
  let outcome: UpdateOutcome;
  try {
    outcome = await runUpdate(a, ctx.env, { ...(version ? { version } : {}), signal: controller.signal, progress: (line) => ctx.stderr.write(`${ctx.err.dim(line)}\n`) });
  } finally {
    process.off("SIGINT", onInt);
  }
  const d = describeOutcome(outcome);
  if (ctx.json) writeJson(ctx.stdout, outcome);
  else (d.code === EXIT.failure ? ctx.stderr : ctx.stdout).write(`${d.text}\n`);
  return d.code;
}
