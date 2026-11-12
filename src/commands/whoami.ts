import type { Context } from "../context.js";
import { expiryPhrase, humanDate, writeJson } from "../output.js";

interface WhoAmI {
  user: { id: string; name: string | null; email: string | null };
  organisation: { id: string; name: string | null } | null;
  key: { id: string; name: string; prefix: string; expires_at: string | null; created_at: string };
}

/** `GET /api/cli/whoami`: asks Memtro rather than trusting what login wrote down, so a revoked key says so. */
export async function whoami(ctx: Context): Promise<number> {
  const client = await ctx.client();
  const cred = await ctx.credential();
  const me = await client.json<WhoAmI>("/api/cli/whoami");
  const source = cred?.source === "env" ? "MEMTRO_API_KEY" : ctx.store().where;

  if (ctx.json) {
    writeJson(ctx.stdout, { profile: ctx.resolved.profile, base_url: ctx.resolved.baseUrl, key_source: cred?.source ?? null, ...me });
    return 0;
  }
  const o = ctx.out;
  const who = me.user.name && me.user.email ? `${me.user.name} <${me.user.email}>` : me.user.email ?? me.user.name ?? me.user.id;
  const lines = [
    `${o.bold(who)}`,
    `Organisation  ${me.organisation?.name ?? me.organisation?.id ?? "—"}`,
    `Key           ${me.key.name} (${me.key.prefix}…), ${expiryPhrase(me.key.expires_at)}, created ${humanDate(me.key.created_at)}`,
    `Profile       ${ctx.resolved.profile} → ${ctx.resolved.baseUrl}`,
    `Key from      ${source}`,
  ];
  ctx.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
