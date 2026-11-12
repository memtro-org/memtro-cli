import { VERSION } from "../version.js";

/**
 * Requests to the release host. Each one is a plain `fetch` with a fixed set of headers: no Authorization, no
 * cookie, nothing from a Memtro profile, and never through `ApiClient`. Redirects are followed by hand so every hop
 * is checked against the hosts a GitHub release download goes through; anything else is refused.
 */

export const DEFAULT_RELEASE_BASE = "https://github.com/memtro-org/memtro-cli/releases";

/** Where GitHub sends `releases/download/...` (observed 2026-11-12: release-assets; objects is the older host). */
// The attestation check's hosts are separate (attestationSource below): a release download never goes there.
const GITHUB_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const MAX_HOPS = 5;

export class FetchRefused extends Error {}

export interface ReleaseSource {
  /** `https://github.com/<owner>/<repo>/releases`, without a trailing slash. */
  base: string;
  /** May this URL be requested? */
  allowed(url: URL): boolean;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * The release base. `MEMTRO_RELEASE_BASE` is undocumented and exists for the tests, which stand a local server in
 * for GitHub; when it is set, only that origin is allowed (plain http only on a loopback address).
 */
export function releaseSource(env: NodeJS.ProcessEnv): ReleaseSource {
  const override = env.MEMTRO_RELEASE_BASE;
  if (override) {
    let url: URL;
    try {
      url = new URL(override);
    } catch {
      throw new FetchRefused("MEMTRO_RELEASE_BASE is not a URL");
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      throw new FetchRefused("MEMTRO_RELEASE_BASE must be https (or http on a loopback address)");
    }
    const origin = url.origin;
    return { base: override.replace(/\/+$/, ""), allowed: (u) => u.origin === origin };
  }
  // On github.com itself only this repository's releases: a redirect to another repository's assets (or anywhere
  // else on github.com) is not a release of memtro. The asset hosts serve signed, per-asset URLs.
  const repoPath = new URL(DEFAULT_RELEASE_BASE).pathname + "/";
  return {
    base: DEFAULT_RELEASE_BASE,
    allowed: (u) =>
      u.protocol === "https:" && GITHUB_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port && (u.hostname !== "github.com" || u.pathname.startsWith(repoPath)),
  };
}

/**
 * Where the build-attestation check may go: GitHub's REST API, for this repository's attestations only, and the
 * storage host GitHub's `bundle_url` points at (observed 2026-11-12: tmaproduction.blob.core.windows.net, a
 * per-object signed URL; the bundle is fetched there only when the API sends no inline copy). Same rules as the
 * release hosts: https, no port, no user, exact host names. Under `MEMTRO_RELEASE_BASE` (tests) its one origin
 * stands in for both.
 */
export const ATTESTATION_API = "https://api.github.com";
const ATTESTATION_PATH = "/repos/memtro-org/memtro-cli/attestations/";
const BUNDLE_HOSTS = new Set(["tmaproduction.blob.core.windows.net"]);

export interface AttestationSource {
  /** `https://api.github.com`, or the test origin. */
  api: string;
  allowedApi(url: URL): boolean;
  allowedBundle(url: URL): boolean;
}

export function attestationSource(env: NodeJS.ProcessEnv): AttestationSource {
  if (env.MEMTRO_RELEASE_BASE) {
    // releaseSource validates the override (https, or http on a loopback address) and throws when it is wrong.
    const release = releaseSource(env);
    const origin = new URL(release.base).origin;
    const same = (u: URL): boolean => u.origin === origin && !u.username && !u.password;
    return { api: origin, allowedApi: (u) => same(u) && u.pathname.startsWith(ATTESTATION_PATH), allowedBundle: same };
  }
  const plain = (u: URL): boolean => u.protocol === "https:" && !u.username && !u.password && !u.port;
  return {
    api: ATTESTATION_API,
    allowedApi: (u) => plain(u) && u.hostname === "api.github.com" && u.pathname.startsWith(ATTESTATION_PATH),
    allowedBundle: (u) => plain(u) && BUNDLE_HOSTS.has(u.hostname) && u.pathname.startsWith("/attestations/"),
  };
}

export function requestHeaders(): Record<string, string> {
  return { "user-agent": `memtro-cli/${VERSION}`, accept: "*/*" };
}

/**
 * GET `url`, following up to five redirects when `follow` is true, each one checked. With `follow` false a
 * redirect response is returned as it is (used to read `releases/latest`'s Location).
 */
export async function releaseGet(
  fetchImpl: typeof fetch,
  source: ReleaseSource,
  url: string,
  signal: AbortSignal,
  follow = true,
): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (!source.allowed(current)) throw new FetchRefused(`refusing to fetch from ${current.origin}`);
    const res = await fetchImpl(current, { method: "GET", headers: requestHeaders(), redirect: "manual", credentials: "omit", signal });
    if (res.status < 300 || res.status >= 400 || !follow) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location) throw new FetchRefused(`a redirect from ${current.origin} named no location`);
    if (hop + 1 >= MAX_HOPS) throw new FetchRefused("too many redirects");
    current = new URL(location, current);
  }
}
