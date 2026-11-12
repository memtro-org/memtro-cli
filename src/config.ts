import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, UsageError } from "./errors.js";

/**
 * Non-secret settings, per profile.
 *
 * A profile is one Memtro account on this computer: its host and who it signed in as. Two is the normal case
 * rather than the edge one (pi-memtro found that out first): a consultant with two clients, a sandbox beside
 * production, a self-hosted Memtro beside the hosted one. The key itself is never in this file; it lives in the
 * credential store named here, and this file only says which.
 */

export const DEFAULT_BASE_URL = "https://platform.memtro.com";
export const DEFAULT_PROFILE = "default";

/** Profile names reach the keychain's command stream and a file's JSON keys, so they are kept boring. */
const PROFILE_NAME = /^[a-z0-9_-]{1,32}$/;

export function validProfileName(name: string): boolean {
  return PROFILE_NAME.test(name);
}

export function checkProfileName(name: string): string {
  if (!validProfileName(name)) throw new UsageError(`Profile names are 1-32 characters of a-z, 0-9, - and _; got "${name}".`);
  return name;
}

export type StoreKind = "keychain" | "secret-tool" | "file";

export interface ProfileConfig {
  base_url?: string;
  /** Which credential store holds this profile's key, so reading and deleting go to the same place writing did. */
  store?: StoreKind;
  user?: { id: string; name: string | null; email: string | null };
  organisation?: { id: string; name: string | null };
  key_id?: string;
  /** ISO timestamp, or null for a key that never expires. Display only: Memtro decides whether it still works. */
  expires_at?: string | null;
  signed_in_at?: string;
}

export interface ConfigFile {
  version: 1;
  profiles: Record<string, ProfileConfig>;
}

/** `${XDG_CONFIG_HOME:-~/.config}/memtro`, `%APPDATA%\memtro` on Windows, or MEMTRO_CONFIG_DIR when set. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.MEMTRO_CONFIG_DIR) return env.MEMTRO_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "memtro");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "memtro");
}

export const configPath = (dir: string): string => join(dir, "config.json");

/** Creates the directory owner-only. An existing directory keeps its mode: changing somebody's folder is rude. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readConfig(dir: string): ConfigFile {
  let raw: string;
  try {
    raw = readFileSync(configPath(dir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {} };
    throw new CliError(`Could not read ${configPath(dir)}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConfigFile>;
    const profiles = parsed && typeof parsed.profiles === "object" && parsed.profiles ? parsed.profiles : {};
    return { version: 1, profiles: profiles as Record<string, ProfileConfig> };
  } catch {
    throw new CliError(`${configPath(dir)} is not valid JSON. Fix it or delete it (it holds no keys).`);
  }
}

/** Written whole, to a temporary file renamed into place, so a crash never leaves half a config. */
export function writeConfig(dir: string, config: ConfigFile): void {
  ensureDir(dir);
  const path = configPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows: mode bits are not a thing there.
  }
  renameSync(tmp, path);
}

export function updateProfile(dir: string, profile: string, change: (current: ProfileConfig) => ProfileConfig | null): void {
  const config = readConfig(dir);
  const next = change(config.profiles[profile] ?? {});
  if (next === null) delete config.profiles[profile];
  else config.profiles[profile] = next;
  writeConfig(dir, config);
}

export const trimBase = (url: string): string => url.trim().replace(/\/+$/, "");

/** An http(s) URL with no path beyond `/`, no query, no credentials. Anything else is a typo or a trap. */
export function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(trimBase(raw));
  } catch {
    throw new UsageError(`Not a URL: "${raw}". Give the address Memtro is served at, e.g. https://platform.memtro.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError(`The base URL must be http(s); got "${raw}".`);
  if (url.username || url.password) throw new UsageError("The base URL must not carry a user name or password.");
  if (url.search || url.hash) throw new UsageError("The base URL must not carry a query or fragment.");
  return trimBase(url.toString());
}

export interface Resolved {
  profile: string;
  baseUrl: string;
  /** Where the base URL came from, for `whoami` and error messages. */
  baseUrlFrom: "flag" | "env" | "profile" | "default";
}

/**
 * Which profile and which host, in the order the README promises: flag, environment, the profile's own setting,
 * the default. Pure, so the precedence is tested rather than described.
 */
export function resolveProfile(input: { profileFlag?: string; baseUrlFlag?: string; env: NodeJS.ProcessEnv; config: ConfigFile }): Resolved {
  const profile = checkProfileName(input.profileFlag || input.env.MEMTRO_PROFILE || DEFAULT_PROFILE);
  const stored = input.config.profiles[profile]?.base_url;
  if (input.baseUrlFlag) return { profile, baseUrl: checkBaseUrl(input.baseUrlFlag), baseUrlFrom: "flag" };
  if (input.env.MEMTRO_BASE_URL) return { profile, baseUrl: checkBaseUrl(input.env.MEMTRO_BASE_URL), baseUrlFrom: "env" };
  if (stored) return { profile, baseUrl: checkBaseUrl(stored), baseUrlFrom: "profile" };
  return { profile, baseUrl: DEFAULT_BASE_URL, baseUrlFrom: "default" };
}
