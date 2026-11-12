import { ApiClient } from "../api/client.js";
import { updateProfile } from "../config.js";
import type { Context } from "../context.js";
import { CliError, errorText, EXIT } from "../errors.js";
import { writeJson } from "../output.js";
import { userAgent } from "../version.js";

/**
 * `memtro logout`: revoke the key on Memtro, then remove it from this computer whatever Memtro said.
 *
 * The two halves are reported separately because they mean different things. Removed here but not revoked
 * there means the key is still valid wherever else it has been copied, until it expires; that is worth an exit
 * code a script can see (4 when Memtro could not be reached, 1 when it refused), not a cheerful "logged out".
 */
export async function logout(ctx: Context): Promise<number> {
  const profile = ctx.resolved.profile;
  const kind = ctx.profileConfig.store;
  const store = kind ? ctx.store() : null;
  const key = store ? await store.get(profile).catch(() => null) : null;
  const base = ctx.profileConfig.base_url ?? ctx.resolved.baseUrl;

  let revoked: "revoked" | "already-gone" | "failed" | "no-key" = "no-key";
  let problem: CliError | null = null;
  if (key) {
    const client = new ApiClient({ baseUrl: base, key, profile, userAgent: userAgent(), log: (l) => ctx.log(l) });
    try {
      await client.fetch("/api/cli/logout", { method: "POST", timeoutMs: 15_000 });
      revoked = "revoked";
    } catch (err) {
      if (err instanceof CliError && err.exitCode === EXIT.auth) revoked = "already-gone";
      else {
        revoked = "failed";
        problem = err instanceof CliError ? err : new CliError(errorText(err));
      }
    }
  }

  let removed = false;
  if (store) {
    try {
      removed = await store.delete(profile);
    } catch (err) {
      throw new CliError(`Could not remove the key from ${store.where}: ${errorText(err)}`);
    }
  }
  if (ctx.config.profiles[profile]) {
    // Keep the host, so the next sign-in goes back to the same place; drop who it was.
    updateProfile(ctx.dir, profile, (p) => (p.base_url ? { base_url: p.base_url } : null));
  }

  const envNote = ctx.env.MEMTRO_API_KEY ? "MEMTRO_API_KEY is still set in this environment; logout does not touch it." : null;

  if (ctx.json) {
    writeJson(ctx.stdout, { profile, revoked, removed_locally: removed, ...(problem ? { error: problem.message } : {}) });
  } else {
    const lines: string[] = [];
    if (revoked === "no-key" && !removed) lines.push(`Not signed in (profile "${profile}"); nothing to do.`);
    if (revoked === "revoked") lines.push("Revoked the key on Memtro.");
    if (revoked === "already-gone") lines.push("Memtro no longer accepted the key (already revoked or expired).");
    if (removed) lines.push(`Removed it from ${store!.where}.`);
    for (const l of lines) ctx.stdout.write(`${l}\n`);
    if (problem) {
      ctx.stderr.write(
        `${ctx.err.red("Could not revoke the key on Memtro")}: ${problem.message}\nIt was removed from this computer but stays valid until it expires. Revoke it at ${base}/dashboard/profile/keys.\n`,
      );
    }
  }
  if (envNote) ctx.stderr.write(`${ctx.err.yellow(envNote)}\n`);
  return problem ? problem.exitCode : 0;
}
