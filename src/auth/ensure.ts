import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { ApiClient } from "../api/client.js";
import { bool } from "../args.js";
import { updateProfile, type StoreKind } from "../config.js";
import { refreshContext, type Context } from "../context.js";
import { AuthError, CliError, errorText, KeyRefusedError, notSignedIn, UsageError } from "../errors.js";
import { humanDate, relativeDays } from "../output.js";
import { openStore, preferredKind, type CredentialStore } from "../store/index.js";
import { userAgent } from "../version.js";
import { buildAuthorizeUrl, cleanPastedCode, deviceLabel, MANUAL, wantsManual } from "./authorize.js";
import { openBrowser } from "./browser.js";
import { startLoopback } from "./loopback.js";
import { newPkce } from "./pkce.js";
import { exchangeCode, type TokenResponse } from "./token.js";

/**
 * Signing in, on first use. There is no login command: a command that needs a key and finds none signs in through
 * the browser when a person is there to approve it, and says how to sign in when nobody is.
 *
 * The flow is the contract's authorization-code + PKCE: a listener on 127.0.0.1, the browser sent to
 * `/cli/authorize`, the code it comes back with exchanged at `/api/cli/token`. `--no-browser` (or SSH, or a Linux
 * session with no display) uses `redirect_uri=manual` instead: the page shows the code and the person pastes it.
 * Every line it prints goes to stderr, so a command's stdout (`--json`) stays clean.
 */

export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface SignInDeps {
  openBrowser: (url: string) => Promise<boolean>;
  hostname: () => string;
  platform: NodeJS.Platform;
  timeoutMs: number;
}

const defaultDeps: SignInDeps = { openBrowser, hostname, platform: process.platform, timeoutMs: SIGN_IN_TIMEOUT_MS };

export interface SignInOptions {
  /** A person is at the terminal: stdin and stdout are terminals and CI is not set. */
  interactive: boolean;
  /** `--no-browser`: print the address and read a pasted code. */
  noBrowser: boolean;
}

/** Whether a person can be expected to answer: stdin and stdout are terminals, and this is not CI. */
export function isInteractive(io: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean }; env: NodeJS.ProcessEnv }): boolean {
  return Boolean(io.stdin.isTTY) && Boolean(io.stdout.isTTY) && !io.env.CI;
}

/** The options a command's context implies. */
export function signInOptions(ctx: Context): SignInOptions {
  return { interactive: isInteractive(ctx), noBrowser: bool(ctx.flags["no-browser"]) };
}

/**
 * Returns a usable signed-in context, signing in through the browser first when there is no key and a person is
 * there. A key from MEMTRO_API_KEY or the store is returned as it is: no request is made just to check it.
 */
export async function ensureSignedIn(ctx: Context, opts: SignInOptions, deps: Partial<SignInDeps> = {}): Promise<Context> {
  if (await ctx.credential()) return ctx;
  if (!opts.interactive) throw notSignedIn(ctx.resolved.profile);
  await signIn(ctx, opts, deps);
  return refreshContext(ctx);
}

/**
 * Starts something that needs the key (a session), signing in first if there is none, and once more if Memtro
 * refuses the stored key while a person is there. Never a loop: a refusal straight after a sign-in is an error.
 * A key from MEMTRO_API_KEY is never replaced: its refusal is the error it already is (exit 3).
 */
export async function startSignedIn<T>(ctx: Context, opts: SignInOptions, start: (ctx: Context) => Promise<T>, deps: Partial<SignInDeps> = {}): Promise<{ ctx: Context; value: T }> {
  const hadKey = Boolean(await ctx.credential());
  let current = await ensureSignedIn(ctx, opts, deps);
  try {
    return { ctx: current, value: await start(current) };
  } catch (err) {
    if (!(err instanceof KeyRefusedError) || err.source === "env" || !opts.interactive) throw err;
    if (!hadKey) throw refusedAfterSignIn(current);
    current.stderr.write(`${current.err.yellow(`Memtro refused the stored key for profile "${current.resolved.profile}": it has been revoked or has expired. Signing in again.`)}\n`);
  }
  await signIn(current, opts, deps);
  current = refreshContext(current);
  try {
    return { ctx: current, value: await start(current) };
  } catch (err) {
    if (err instanceof KeyRefusedError && err.source !== "env") throw refusedAfterSignIn(current);
    throw err;
  }
}

function refusedAfterSignIn(ctx: Context): AuthError {
  return new AuthError(
    `Memtro refused the key it has just issued for profile "${ctx.resolved.profile}". Not signing in again: check the organisation's access in the Memtro dashboard, or ask an administrator.`,
  );
}

interface Saved {
  tokens: TokenResponse;
  store: CredentialStore;
  replaced: "revoked" | "not-revoked" | null;
  notes: string[];
}

/**
 * The sign-in itself, whether or not a key is held (`/login` signs in again, perhaps as somebody else).
 *
 * Nothing is stored until the exchange has succeeded. Where it signs in to and the address are printed before
 * the browser is asked to open, every time: an `open` that "succeeded" into a browser on another desktop is not
 * something this process can see, and nobody should be sent to a sign-in page without being told whose.
 */
export async function signIn(ctx: Context, opts: SignInOptions, deps: Partial<SignInDeps> = {}): Promise<TokenResponse> {
  const d = { ...defaultDeps, ...deps };
  const base = ctx.resolved.baseUrl;
  const profile = ctx.resolved.profile;
  const say = (line = "") => ctx.stderr.write(`${line}\n`);
  if (!opts.interactive) throw notSignedIn(profile);

  if (ctx.env.MEMTRO_API_KEY) {
    say(ctx.err.yellow("Note: MEMTRO_API_KEY is set, and it takes precedence over the key stored by this sign-in until you unset it."));
  }

  const pkce = newPkce();
  const device = deviceLabel(d.hostname()) || undefined;
  const manual = wantsManual({ noBrowser: opts.noBrowser, env: ctx.env, platform: d.platform, stdinIsTTY: Boolean(ctx.stdin.isTTY) });
  const minutes = Math.round(d.timeoutMs / 60_000);
  const where = `${base}${profile === "default" ? "" : ` (profile ${profile})`}`;

  let saved: Saved;
  if (manual) {
    const url = buildAuthorizeUrl(base, { challenge: pkce.challenge, redirectUri: MANUAL, state: pkce.state, device });
    say(`Signing in to ${where}. Open this address in a browser, on this computer or any other, and approve the sign-in:\n\n  ${url}\n`);
    const pasted = await readLine(ctx, "Then paste the code it shows here: ", d.timeoutMs);
    const code = cleanPastedCode(pasted);
    if (!code) throw new UsageError("That does not look like a sign-in code. Try again, and paste the code exactly as shown.");
    saved = await save(ctx, await exchangeCode(base, { code, codeVerifier: pkce.verifier, redirectUri: MANUAL }, { userAgent: userAgent() }));
  } else {
    let redirectUri = "";
    const loop = await startLoopback<Saved>({
      state: pkce.state,
      timeoutMs: d.timeoutMs,
      onCode: async (code) => save(ctx, await exchangeCode(base, { code, codeVerifier: pkce.verifier, redirectUri }, { userAgent: userAgent() })),
    });
    redirectUri = loop.redirectUri;
    const onSigint = () => loop.close();
    process.once("SIGINT", onSigint);
    // Everything after the listener starts is inside the try, so nothing can leave it listening.
    try {
      const url = buildAuthorizeUrl(base, { challenge: pkce.challenge, redirectUri, state: pkce.state, device });
      say(`Signing in to ${where}: opening your browser to approve it. If it does not open, visit:`);
      say(`\n  ${url}\n`);
      const opened = await d.openBrowser(url);
      if (!opened) say("Could not open a browser: visit the address above to approve the sign-in.");
      say(ctx.err.dim(`Waiting for the browser (up to ${minutes} minutes; Ctrl-C to cancel)…`));
      const result = await loop.result;
      switch (result.kind) {
        case "done":
          saved = result.value;
          break;
        case "denied":
          throw new CliError("Sign-in was cancelled in the browser. Nothing was stored.");
        case "timeout":
          throw new CliError(`Nobody approved the sign-in within ${minutes} minutes. Nothing was stored; run the command again to retry (add --no-browser to paste a code instead).`);
        case "aborted":
          throw new CliError("Sign-in cancelled. Nothing was stored.");
        case "error":
          throw result.error instanceof CliError ? result.error : new CliError(result.error.message);
      }
    } finally {
      process.off("SIGINT", onSigint);
      loop.close();
    }
  }

  const { tokens } = saved;
  for (const note of saved.notes) say(ctx.err.yellow(note));
  const who = tokens.user.name && tokens.user.email ? `${tokens.user.name} <${tokens.user.email}>` : tokens.user.email ?? tokens.user.name ?? tokens.user.id;
  // The key is the organisation's, held by this person: it reads and writes that organisation's memory as them.
  say(`${ctx.err.green("Signed in")} as ${ctx.err.bold(who)} in ${ctx.err.bold(tokens.organisation.name ?? tokens.organisation.id)}${profile === "default" ? "" : ` (profile ${profile})`}; ${keyExpiry(tokens.expires_at)}.`);
  say(`It acts as you in that organisation, and is stored in ${saved.store.where}.`);
  if (saved.replaced === "revoked") say("The key this profile held before has been revoked.");
  return tokens;
}

/**
 * Store the new key, record the profile, and retire the key it replaces.
 *
 * Runs inside the browser's wait, so the page the browser is shown reflects whether this worked. A key minted
 * but not stored is revoked again rather than left live with nobody holding it.
 */
async function save(ctx: Context, tokens: TokenResponse): Promise<Saved> {
  const profile = ctx.resolved.profile;
  const base = ctx.resolved.baseUrl;
  const notes: string[] = [];

  const previousKind = ctx.profileConfig.store;
  const previousBase = ctx.profileConfig.base_url ?? base;
  const previous = previousKind ? await openStore(previousKind, ctx.dir, ctx.env).get(profile).catch(() => null) : null;

  let kind: StoreKind = preferredKind(ctx.env);
  let store = openStore(kind, ctx.dir, ctx.env);
  try {
    await store.set(profile, tokens.api_key);
  } catch (err) {
    if (kind === "secret-tool" && !ctx.env.MEMTRO_CREDENTIALS) {
      // secret-tool installed but no keyring running (SSH, containers): the file is the honest fallback.
      notes.push(`The Secret Service keyring is not available (${errorText(err)}); the key is in a 0600 file instead.`);
      kind = "file";
      store = openStore(kind, ctx.dir, ctx.env);
      await store.set(profile, tokens.api_key).catch(async (e: unknown) => {
        await revoke(base, tokens.api_key, profile);
        throw new CliError(`Could not store the key (${errorText(e)}). It has been revoked again; nothing is left behind.`);
      });
    } else {
      await revoke(base, tokens.api_key, profile);
      throw new CliError(`Could not store the key in ${store.where} (${errorText(err)}). It has been revoked again. Set MEMTRO_CREDENTIALS=file to use a file instead.`);
    }
  }

  updateProfile(ctx.dir, profile, () => ({
    base_url: base,
    store: kind,
    user: tokens.user,
    organisation: tokens.organisation,
    key_id: tokens.key_id,
    expires_at: tokens.expires_at,
    signed_in_at: new Date().toISOString(),
  }));

  let replaced: Saved["replaced"] = null;
  if (previous && previous !== tokens.api_key) {
    if (previousKind && previousKind !== kind) await openStore(previousKind, ctx.dir, ctx.env).delete(profile).catch(() => false);
    replaced = (await revoke(previousBase, previous, profile)) ? "revoked" : "not-revoked";
    if (replaced === "not-revoked") notes.push(`The key this profile held before could not be revoked; it stays valid until it expires. Revoke it at ${previousBase}/dashboard/profile/keys.`);
  }
  return { tokens, store, replaced, notes };
}

/** `POST /api/cli/logout` with the key itself. True when Memtro revoked it or it was already gone. */
export async function revoke(base: string, key: string, profile: string): Promise<boolean> {
  const client = new ApiClient({ baseUrl: base, key, profile, userAgent: userAgent() });
  try {
    await client.fetch("/api/cli/logout", { method: "POST", timeoutMs: 15_000 });
    return true;
  } catch (err) {
    return err instanceof CliError && err.exitCode === 3;
  }
}

/** One line from stdin, with a deadline. Ctrl-C cancels. */
function readLine(ctx: Context, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: ctx.stdin, output: ctx.stderr, terminal: Boolean(ctx.stdin.isTTY) });
    const timer = setTimeout(() => {
      rl.close();
      reject(new CliError(`No code was pasted within ${Math.round(timeoutMs / 60_000)} minutes. Nothing was stored; run the command again to retry.`));
    }, timeoutMs);
    let answered = false;
    rl.on("SIGINT", () => {
      clearTimeout(timer);
      rl.close();
      reject(new CliError("Sign-in cancelled. Nothing was stored."));
    });
    rl.question(prompt, (answer) => {
      answered = true;
      clearTimeout(timer);
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      clearTimeout(timer);
      if (!answered) reject(new CliError("stdin closed before a code was pasted."));
    });
  });
}

/** "this key expires on 10 Feb 2027 (in 90 days)", or "this key does not expire". */
export function keyExpiry(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "this key does not expire";
  const rel = relativeDays(iso, now);
  return `this key expires on ${humanDate(iso)}${rel ? ` (${rel})` : ""}`;
}
