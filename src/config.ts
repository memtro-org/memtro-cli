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

/**
 * The coding session's settings, written by hand: `mode` ("ask" | "auto"), `classifier.model` (a model id),
 * `classifier.enabled` (false turns the safety check's model off, so everything it would judge is asked),
 * `classifier.timeoutMs` (how long the safety check may take before the call is put to you; default 8000, capped
 * at 60000 by the classifier),
 * `actions` (true lets Memtro's tools change connected systems). Top level of the file, beside `profiles`: a
 * profile's entry is rewritten whole by every sign-in, so settings kept there would be lost.
 */
export interface HarnessConfig {
  mode?: "ask" | "auto";
  classifier: { model?: string; enabled?: boolean; timeoutMs?: number };
  actions?: boolean;
}

export interface ConfigFile {
  version: 1;
  profiles: Record<string, ProfileConfig>;
  mode?: unknown;
  classifier?: unknown;
  actions?: unknown;
  /** false turns off the "a newer memtro is available" line at the start of a session. */
  updateCheck?: unknown;
  /** The interactive session's interface: "full" (the default in a big enough terminal) or "inline". */
  ui?: unknown;
  /** The full-screen interface's colours: "auto" (follow the terminal's background), "dark" or "light". */
  theme?: unknown;
  /** false: the full-screen interface leaves the mouse to the terminal (no wheel scrolling, plain selection). */
  mouse?: unknown;
  /** Asking for attention when an approval waits or a long turn ends: "auto" (default), "bell" or "off". */
  notify?: unknown;
  /** Anything else in the file is kept as it was when the file is rewritten. */
  [other: string]: unknown;
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
    // Keys this version does not use are kept, so rewriting the file (a sign-in) never drops a setting.
    const rest = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    return { ...rest, version: 1, profiles: profiles as Record<string, ProfileConfig> };
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

/**
 * Plain http is allowed only to this computer: these three host names exactly, as the URL parser normalises them
 * (it lowercases, and turns 127.1 or [0:0::1] into the forms below). `localhost.` with its trailing dot is a DNS name
 * like any other and is not on the list.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * An http(s) URL with no path beyond `/`, no query, no credentials, and plain http only to a loopback address.
 * Anything else is a typo or a trap. Every base URL goes through this: `--base-url`, `MEMTRO_BASE_URL`, and a
 * profile's stored `base_url` at the moment it is used (a stored one is refused, never rewritten).
 */
export function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(trimBase(raw));
  } catch {
    // JSON quoting: a value from the environment or a flag reaches the terminal with its control characters escaped.
    throw new UsageError(`Not a URL: ${JSON.stringify(raw)}. Give the address Memtro is served at, e.g. https://platform.memtro.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError(`The base URL must be http(s); got ${JSON.stringify(raw)}.`);
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new UsageError(
      `The base URL ${JSON.stringify(raw)} is plain http to another computer: a sign-in code and key would travel unencrypted. Use https:// (plain http is allowed only for localhost, 127.0.0.1 and [::1]).`,
    );
  }
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

/**
 * The harness settings. A value of the wrong kind is a usage error naming the key, not a silent default: somebody
 * who wrote `"mode": "auto "` meant something.
 */
export function harnessSettings(config: ConfigFile, where = "config.json"): HarnessConfig {
  const scopes: { label: string; v: { mode?: unknown; classifier?: unknown; actions?: unknown } }[] = [{ label: "", v: config }];
  const out: HarnessConfig = { classifier: {} };
  const bad = (key: string, want: string, got: unknown) => new UsageError(`${where}: ${key} must be ${want}; got ${JSON.stringify(got)}.`);
  for (const { label, v } of scopes) {
    if (v.mode !== undefined) {
      if (v.mode !== "ask" && v.mode !== "auto") throw bad(`${label}mode`, '"ask" or "auto"', v.mode);
      out.mode = v.mode;
    }
    if (v.actions !== undefined) {
      if (typeof v.actions !== "boolean") throw bad(`${label}actions`, "true or false", v.actions);
      out.actions = v.actions;
    }
    if (v.classifier !== undefined) {
      const c = v.classifier as { model?: unknown; enabled?: unknown; timeoutMs?: unknown } | null;
      if (!c || typeof c !== "object" || Array.isArray(c)) throw bad(`${label}classifier`, "an object", v.classifier);
      if (c.model !== undefined) {
        if (typeof c.model !== "string" || !c.model.trim()) throw bad(`${label}classifier.model`, "a model id", c.model);
        out.classifier.model = c.model.trim();
      }
      if (c.enabled !== undefined) {
        if (typeof c.enabled !== "boolean") throw bad(`${label}classifier.enabled`, "true or false", c.enabled);
        out.classifier.enabled = c.enabled;
      }
      if (c.timeoutMs !== undefined) {
        if (typeof c.timeoutMs !== "number" || !Number.isInteger(c.timeoutMs) || c.timeoutMs <= 0) throw bad(`${label}classifier.timeoutMs`, "a whole number of milliseconds", c.timeoutMs);
        out.classifier.timeoutMs = c.timeoutMs;
      }
    }
  }
  return out;
}

/**
 * `updateCheck` (top level, beside `mode`): false turns off the session's "a newer memtro is available" line.
 * `/update` and `memtro update` work either way. A value of the wrong kind is a usage error, like the others.
 */
export function updateCheckSetting(config: ConfigFile, where = "config.json"): boolean | undefined {
  const v = config.updateCheck;
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new UsageError(`${where}: updateCheck must be true or false; got ${JSON.stringify(v)}.`);
  return v;
}

export interface InterfaceSettings {
  ui?: "full" | "inline";
  theme?: "auto" | "dark" | "light";
  mouse?: boolean;
  notify?: "auto" | "bell" | "off";
}

/**
 * `ui`, `theme`, `mouse` and `notify` (top level, beside `mode`): how the interactive session looks. A value of the wrong kind
 * is a usage error naming the key, like the harness settings.
 */
export function interfaceSettings(config: ConfigFile, where = "config.json"): InterfaceSettings {
  const out: InterfaceSettings = {};
  const bad = (key: string, want: string, got: unknown) => new UsageError(`${where}: ${key} must be ${want}; got ${JSON.stringify(got)}.`);
  if (config.ui !== undefined) {
    if (config.ui !== "full" && config.ui !== "inline") throw bad("ui", '"full" or "inline"', config.ui);
    out.ui = config.ui;
  }
  if (config.theme !== undefined) {
    if (config.theme !== "auto" && config.theme !== "dark" && config.theme !== "light") throw bad("theme", '"auto", "dark" or "light"', config.theme);
    out.theme = config.theme;
  }
  if (config.mouse !== undefined) {
    if (typeof config.mouse !== "boolean") throw bad("mouse", "true or false", config.mouse);
    out.mouse = config.mouse;
  }
  if (config.notify !== undefined) {
    if (config.notify !== "auto" && config.notify !== "bell" && config.notify !== "off") throw bad("notify", '"auto", "bell" or "off"', config.notify);
    out.notify = config.notify;
  }
  return out;
}
