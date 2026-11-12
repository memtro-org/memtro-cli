import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { sessionsDir } from "../agent/session-store.js";
import { VERSION } from "../version.js";
import { FetchRefused, releaseGet, releaseSource, type ReleaseSource } from "./net.js";
import { compareVersions, normaliseVersion } from "./semver.js";
import { extractSingleFile, TarError } from "./tar.js";

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  tag: string;
}
export interface UpdateDeps {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  now: () => Date;
  fetch: typeof fetch;
  execPath: string;
  platform: NodeJS.Platform;
  arch: string;
  isSea: boolean;
}
export type UpdateOutcome =
  | { kind: "updated"; from: string; to: string; path: string }
  | { kind: "current"; version: string }
  | { kind: "unmanaged"; reason: string; howTo: string }
  | { kind: "failed"; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 3_000;
const METADATA_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const PROOF_TIMEOUT_MS = 20_000;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_SMALL_BYTES = 256 * 1024;
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/memtro-org/memtro-cli/main/install.sh | sh";

interface Cache {
  checked: string;
  latest: string;
  tag: string;
}

const cachePath = (stateDir: string): string => join(stateDir, "update.json");

function readCache(stateDir: string): Cache | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(stateDir), "utf8")) as Partial<Cache>;
    if (typeof raw.checked !== "string" || Number.isNaN(Date.parse(raw.checked))) return null;
    if (typeof raw.latest !== "string" || typeof raw.tag !== "string") return { checked: raw.checked, latest: "", tag: "" };
    return { checked: raw.checked, latest: raw.latest, tag: raw.tag };
  } catch {
    return null;
  }
}

function writeCache(stateDir: string, cache: Cache): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${cachePath(stateDir)}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, cachePath(stateDir));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** A cached or fetched `latest` that is not a valid version, or whose tag disagrees with it, is ignored. */
function info(latestRaw: string, tag: string): UpdateInfo | null {
  const latest = normaliseVersion(latestRaw);
  if (!latest || tag !== `v${latest}`) return null;
  return { current: VERSION, latest, newer: compareVersions(latest, VERSION) > 0, tag };
}

/** What the last check learned, from the cache only. Never touches the network; null when nothing is cached. */
export function cachedUpdate(deps: UpdateDeps): UpdateInfo | null {
  const cache = readCache(deps.stateDir);
  return cache ? info(cache.latest, cache.tag) : null;
}

/** True when checking is off: MEMTRO_NO_UPDATE_CHECK set, CI set, or config says so. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv, configured: boolean | undefined): boolean {
  const on = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return on(env.MEMTRO_NO_UPDATE_CHECK) || on(env.CI) || configured === false;
}

async function readSmall(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_SMALL_BYTES) throw new FetchRefused("the response is too large");
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_SMALL_BYTES) throw new FetchRefused("the response is too large");
  return body.toString("utf8");
}

/** The latest release: `latest.json` from `releases/latest/download/`, else the tag `releases/latest` redirects to. */
async function discoverLatest(fetchImpl: typeof fetch, source: ReleaseSource, signal: AbortSignal): Promise<{ latest: string; tag: string }> {
  let firstProblem = "";
  try {
    const res = await releaseGet(fetchImpl, source, `${source.base}/latest/download/latest.json`, signal);
    if (res.ok) {
      const body = JSON.parse(await readSmall(res)) as { version?: unknown; tag?: unknown };
      const found = typeof body.version === "string" && typeof body.tag === "string" ? info(body.version, body.tag) : null;
      if (found) return { latest: found.latest, tag: found.tag };
      firstProblem = "latest.json does not name a valid version";
    } else {
      await res.body?.cancel().catch(() => undefined);
      firstProblem = `latest.json: HTTP ${res.status}`;
    }
  } catch (err) {
    if (signal.aborted) throw err;
    firstProblem = err instanceof Error ? err.message : String(err);
  }
  const res = await releaseGet(fetchImpl, source, `${source.base}/latest`, signal, false);
  await res.body?.cancel().catch(() => undefined);
  const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  if (location) {
    const target = new URL(location, `${source.base}/latest`);
    const m = /\/releases\/tag\/([^/]+)$/.exec(target.pathname);
    const tag = m ? decodeURIComponent(m[1]!) : "";
    const found = info(tag, tag);
    if (found && source.allowed(target)) return { latest: found.latest, tag: found.tag };
  }
  throw new Error(`could not find the latest release (${firstProblem}; releases/latest: HTTP ${res.status})`);
}

/** Checks the network if the last check is older than 24 hours, updates the cache, resolves either way. Never rejects, never prints. */
export async function refreshUpdateCache(deps: UpdateDeps, signal: AbortSignal): Promise<void> {
  try {
    const cache = readCache(deps.stateDir);
    const now = deps.now();
    if (cache) {
      const age = now.getTime() - Date.parse(cache.checked);
      if (age >= 0 && age < DAY_MS) return;
    }
    if (signal.aborted) return;
    const source = releaseSource(deps.env);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
    try {
      const found = await discoverLatest(deps.fetch, source, bounded);
      writeCache(deps.stateDir, { checked: now.toISOString(), ...found });
    } catch {
      // Cancelled by the caller (the session ended): try again next time. Otherwise remember that we tried, keeping
      // what an earlier check learned, so a machine with no route to GitHub does not try on every start.
      if (signal.aborted) return;
      writeCache(deps.stateDir, { checked: now.toISOString(), latest: cache?.latest ?? "", tag: cache?.tag ?? "" });
    }
  } catch {
    // Never rejects: an unwritable state directory or anything else is not worth disturbing a session for.
  }
}

/** Where an executable must not be replaced from inside: package managers and system prefixes own those. */
function managedLocation(real: string): string | null {
  const parts = real.split(sep);
  if (parts.includes("node_modules")) return "it was installed with npm";
  const prefixes: Array<[string, string]> = [
    ["/opt/homebrew/", "it was installed with Homebrew"],
    ["/usr/local/Cellar/", "it was installed with Homebrew"],
    ["/home/linuxbrew/", "it was installed with Homebrew"],
    ["/nix/store/", "it was installed with Nix"],
    ["/snap/", "it was installed as a snap"],
    ["/usr/", "it is in a system directory"],
    ["/bin/", "it is in a system directory"],
    ["/sbin/", "it is in a system directory"],
    ["/opt/", "it is in a system directory"],
  ];
  for (const [prefix, why] of prefixes) if (real.startsWith(prefix)) return why;
  return null;
}

function tempName(dir: string, suffix: string): string {
  return join(dir, `.memtro-update-${randomBytes(6).toString("hex")}${suffix}`);
}

/** Downloads `res`'s body to `dest` (created exclusively), returning its SHA-256. */
async function download(res: Response, dest: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) throw new FetchRefused("the download is implausibly large");
  if (!res.body) throw new Error("the download had no body");
  const hash = createHash("sha256");
  const handle = await open(dest, "wx", 0o600);
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) throw new FetchRefused("the download is implausibly large");
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  if (declared && total !== declared) throw new Error(`the download stopped early (${total} of ${declared} bytes)`);
  return hash.digest("hex");
}

/** `sha256  name` lines (sha256sum's text and `*` binary forms); the sum for `name`, or null. */
export function checksumFor(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return null;
}

function runVersion(file: string, env: NodeJS.ProcessEnv): Promise<string> {
  // A minimal environment: no Memtro key or profile reaches the new executable while it proves it starts.
  const childEnv: NodeJS.ProcessEnv = { PATH: env.PATH ?? "/usr/bin:/bin", MEMTRO_NO_UPDATE_CHECK: "1" };
  if (env.HOME) childEnv.HOME = env.HOME;
  return new Promise((resolve, reject) => {
    execFile(file, ["--version"], { env: childEnv, timeout: PROOF_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`the new executable did not start: ${err.message.split("\n")[0]}`));
      else resolve(String(stdout).trim());
    });
  });
}

function reasonOf(err: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "the update was cancelled";
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "the release host took too long to answer";
  if (err instanceof TarError || err instanceof FetchRefused) return err.message;
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}

/** Downloads, verifies and swaps in the latest (or the given) version. Never rejects. */
export async function performUpdate(
  deps: UpdateDeps,
  opts: { version?: string; signal: AbortSignal; onProgress?: (text: string) => void },
): Promise<UpdateOutcome> {
  const progress = (text: string): void => {
    try {
      opts.onProgress?.(text);
    } catch {
      // A progress printer that throws is not a reason to leave a half-finished update.
    }
  };
  const reinstall = `Reinstall with: ${INSTALL_COMMAND}`;
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    return { kind: "unmanaged", reason: `there is no standalone memtro for ${deps.platform}`, howTo: "On Windows, use memtro inside WSL." };
  }
  if (deps.arch !== "arm64" && deps.arch !== "x64") {
    return { kind: "unmanaged", reason: `there is no standalone memtro for ${deps.platform}-${deps.arch}`, howTo: "Update with: npm install -g @memtro/cli@latest" };
  }
  if (!deps.isSea) {
    return {
      kind: "unmanaged",
      reason: "it is not the standalone executable (it was installed with npm, or runs from a checkout)",
      howTo: "Update with: npm install -g @memtro/cli@latest (from a checkout: git pull, then npm run build).",
    };
  }
  let target: string;
  try {
    target = realpathSync(deps.execPath);
  } catch (err) {
    return { kind: "failed", reason: `could not find the running executable: ${reasonOf(err, opts.signal)}` };
  }
  const managed = managedLocation(target);
  if (managed) return { kind: "unmanaged", reason: `${target} is not ours to replace: ${managed}`, howTo: "Update it the way it was installed." };
  const dir = dirname(target);
  // Anybody who can write the directory could swap the verified file for another between the proof and the rename.
  try {
    if ((statSync(dir).mode & 0o002) !== 0) {
      return { kind: "unmanaged", reason: `${dir} is writable by every user on this computer, so a verified update could be swapped before it is used`, howTo: reinstall };
    }
  } catch (err) {
    return { kind: "failed", reason: `could not inspect ${dir}: ${reasonOf(err, opts.signal)}` };
  }

  // Probe that the directory takes a new file, the way the swap will need, before asking the network anything.
  const probe = tempName(dir, ".probe");
  try {
    const h = await open(probe, "wx", 0o600);
    await h.close();
    await rm(probe, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return { kind: "unmanaged", reason: `${dir} is not writable by you`, howTo: reinstall };
    }
    return { kind: "failed", reason: `could not write beside ${target}: ${reasonOf(err, opts.signal)}` };
  }

  let source: ReleaseSource;
  try {
    source = releaseSource(deps.env);
  } catch (err) {
    return { kind: "failed", reason: reasonOf(err, opts.signal) };
  }

  let version: string;
  let tag: string;
  if (opts.version !== undefined) {
    const v = normaliseVersion(opts.version);
    if (!v) return { kind: "failed", reason: `${JSON.stringify(opts.version)} is not a version (expected something like 0.3.0)` };
    version = v;
    tag = `v${v}`;
  } else {
    progress("Checking for the latest version…");
    try {
      const found = await discoverLatest(deps.fetch, source, AbortSignal.any([opts.signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]));
      version = found.latest;
      tag = found.tag;
      try {
        writeCache(deps.stateDir, { checked: deps.now().toISOString(), latest: version, tag });
      } catch {
        // The cache is a convenience.
      }
    } catch (err) {
      return { kind: "failed", reason: reasonOf(err, opts.signal) };
    }
    if (compareVersions(version, VERSION) <= 0) return { kind: "current", version: VERSION };
  }
  if (version === VERSION) return { kind: "current", version: VERSION };

  const asset = `memtro-${deps.platform}-${deps.arch}.tar.gz`;
  const archive = tempName(dir, ".tar.gz");
  const fresh = tempName(dir, "");
  let swapped = false;
  try {
    const metaSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]);
    const sums = await releaseGet(deps.fetch, source, `${source.base}/download/${encodeURIComponent(tag)}/checksums.txt`, metaSignal);
    if (!sums.ok) {
      await sums.body?.cancel().catch(() => undefined);
      throw new Error(sums.status === 404 ? `there is no release ${tag}` : `checksums.txt: HTTP ${sums.status}`);
    }
    const expected = checksumFor(await readSmall(sums), asset);
    if (!expected) throw new Error(`release ${tag} has no ${asset} (no build for this platform)`);

    progress(`Downloading memtro ${version} for ${deps.platform}-${deps.arch}…`);
    const dlSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
    const res = await releaseGet(deps.fetch, source, `${source.base}/download/${encodeURIComponent(tag)}/${asset}`, dlSignal);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${asset}: HTTP ${res.status}`);
    }
    const actual = await download(res, archive);
    if (actual !== expected) throw new Error(`the download's checksum does not match checksums.txt (expected ${expected}, got ${actual}); nothing was changed`);

    progress("Verifying…");
    await extractSingleFile(archive, "memtro", fresh, 0o755);
    chmodSync(fresh, 0o755);
    const reported = await runVersion(fresh, deps.env);
    if (normaliseVersion(reported) !== version) {
      throw new Error(`the new executable reports ${JSON.stringify(reported.slice(0, 40))}, not ${version}`);
    }
    if (opts.signal.aborted) throw new Error("cancelled");
    // rename(2) swaps the directory entry: this process keeps running on the old file, the next start gets the new one.
    await rename(fresh, target);
    swapped = true;
    return { kind: "updated", from: VERSION, to: version, path: target };
  } catch (err) {
    return { kind: "failed", reason: reasonOf(err, opts.signal) };
  } finally {
    await rm(archive, { force: true }).catch(() => undefined);
    if (!swapped) await rm(fresh, { force: true }).catch(() => undefined);
  }
}

function seaRuntime(): boolean {
  try {
    // process.getBuiltinModule rather than an import: an older Node 20 has no node:sea, and the CommonJS bundle has
    // no import.meta for createRequire. Any Node that can run as a single executable has both.
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const sea = getBuiltin?.("node:sea") as { isSea?: () => boolean } | undefined;
    return sea?.isSea?.() === true;
  } catch {
    return false;
  }
}

export function defaultUpdateDeps(env: NodeJS.ProcessEnv = process.env): UpdateDeps {
  return {
    env,
    stateDir: dirname(sessionsDir({ env })),
    now: () => new Date(),
    fetch: globalThis.fetch,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    isSea: seaRuntime(),
  };
}
