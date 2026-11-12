import { ApiClient } from "./api/client.js";
import { bool, str, type Flags } from "./args.js";
import { configDir, readConfig, resolveProfile, type ConfigFile, type ProfileConfig, type Resolved, type StoreKind } from "./config.js";
import { notSignedIn, UsageError } from "./errors.js";
import { colourAllowed, paint, type Paint, type Streams } from "./output.js";
import { openStore, preferredKind, type CredentialStore } from "./store/index.js";
import { userAgent } from "./version.js";

/**
 * Everything a command needs, resolved once: streams, which profile and host, where its key lives, and how to
 * talk to Memtro. Built from the parsed flags and the environment, so a test can hand in its own of both.
 */
export interface Context extends Streams {
  env: NodeJS.ProcessEnv;
  flags: Flags;
  positionals: string[];
  json: boolean;
  verbose: boolean;
  dir: string;
  config: ConfigFile;
  profileConfig: ProfileConfig;
  resolved: Resolved;
  /** Colour for stdout and stderr respectively. */
  out: Paint;
  err: Paint;
  cwd: string;
  log(line: string): void;
  /** The store this profile's key is in (or would be written to). */
  store(): CredentialStore;
  storeKind(): StoreKind;
  /** The key to use and where it came from: MEMTRO_API_KEY first, never stored; then the profile's. */
  credential(): Promise<{ key: string; source: "env" | StoreKind } | null>;
  /** A client with the key; throws "not signed in" (exit 3) when there is none. */
  client(): Promise<ApiClient>;
  anonymousClient(): ApiClient;
}

export function buildContext(input: Streams & { env: NodeJS.ProcessEnv; flags: Flags; positionals: string[]; cwd?: string }): Context {
  const { env, flags } = input;
  const dir = configDir(env);
  const config = readConfig(dir);
  const resolved = resolveProfile({ profileFlag: str(flags.profile), baseUrlFlag: str(flags["base-url"]), env, config });
  const profileConfig = config.profiles[resolved.profile] ?? {};
  const noColour = bool(flags["no-color"]);
  const verbose = bool(flags.verbose);
  const ua = userAgent();

  let storeCache: CredentialStore | null = null;
  const storeKind = (): StoreKind => profileConfig.store ?? preferredKind(env);

  const ctx: Context = {
    stdout: input.stdout,
    stderr: input.stderr,
    stdin: input.stdin,
    env,
    flags,
    positionals: input.positionals,
    json: bool(flags.json),
    verbose,
    dir,
    config,
    profileConfig,
    resolved,
    out: paint(colourAllowed(input.stdout, env, noColour)),
    err: paint(colourAllowed(input.stderr, env, noColour)),
    cwd: input.cwd ?? process.cwd(),
    log(line) {
      if (verbose) input.stderr.write(`${ctx.err.dim(`[memtro] ${line}`)}\n`);
    },
    storeKind,
    store() {
      storeCache ??= openStore(storeKind(), dir, env);
      return storeCache;
    },
    async credential() {
      const fromEnv = env.MEMTRO_API_KEY?.trim();
      if (fromEnv) return { key: fromEnv, source: "env" };
      const key = await ctx.store().get(resolved.profile);
      return key ? { key, source: storeKind() } : null;
    },
    async client() {
      const cred = await ctx.credential();
      if (!cred) throw notSignedIn(resolved.profile);
      /**
       * A stored key goes back to the host that issued it and nowhere else. `--base-url` or MEMTRO_BASE_URL
       * pointing somewhere new with a stored key would otherwise hand that key to whatever answers there.
       */
      if (cred.source !== "env" && profileConfig.base_url !== resolved.baseUrl) {
        // No recorded issuer (config.json deleted or edited while the keychain kept the key) is not a licence to
        // send the key wherever --base-url points: where it came from is unknown, so it goes nowhere.
        throw new UsageError(
          profileConfig.base_url
            ? `The key for profile "${resolved.profile}" was issued by ${profileConfig.base_url}; not sending it to ${resolved.baseUrl}. ` +
                `Use another profile for that host: \`memtro --profile <name> --base-url ${resolved.baseUrl}\` signs it in.`
            : `This computer holds a key for profile "${resolved.profile}" but no record of which Memtro issued it, so it is not being sent anywhere. Run \`memtro logout\`, then \`memtro\` to sign in again.`,
        );
      }
      ctx.log(`profile ${resolved.profile}, ${resolved.baseUrl} (from ${resolved.baseUrlFrom}), key from ${cred.source === "env" ? "MEMTRO_API_KEY" : cred.source}`);
      return new ApiClient({ baseUrl: resolved.baseUrl, key: cred.key, profile: resolved.profile, keySource: cred.source === "env" ? "env" : "stored", userAgent: ua, log: (l) => ctx.log(l) });
    },
    anonymousClient() {
      return new ApiClient({ baseUrl: resolved.baseUrl, key: null, profile: resolved.profile, userAgent: ua, log: (l) => ctx.log(l) });
    },
  };
  return ctx;
}

/** The same command's context, read again from disk: after a sign-in has written the profile and stored a key. */
export function refreshContext(ctx: Context, flags: Flags = ctx.flags): Context {
  return buildContext({ stdout: ctx.stdout, stderr: ctx.stderr, stdin: ctx.stdin, env: ctx.env, flags, positionals: ctx.positionals, cwd: ctx.cwd });
}
