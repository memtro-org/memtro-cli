import { bool } from "../args.js";
import type { Context } from "../context.js";
import { notSignedIn, UsageError } from "../errors.js";

/**
 * `memtro token`: the key, for another program (`curl -H "Authorization: Bearer $(memtro token)"`).
 *
 * Printed only into a pipe or a file unless --show says otherwise, so typing it at a prompt does not leave the
 * key in a terminal's scrollback, a screen share or a recording.
 */
export async function token(ctx: Context): Promise<number> {
  if (ctx.stdout.isTTY && !bool(ctx.flags.show)) {
    throw new UsageError("Not printing the key to a terminal. Pipe it into the program that needs it, or pass --show.");
  }
  const cred = await ctx.credential();
  if (!cred) throw notSignedIn(ctx.resolved.profile);
  ctx.stdout.write(`${cred.key}\n`);
  return 0;
}
