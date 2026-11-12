import { VERSION } from "../version.js";

/**
 * Requests to the release host. Each one is a plain `fetch` with a fixed set of headers: no Authorization, no
 * cookie, nothing from a Memtro profile, and never through `ApiClient`. Redirects are followed by hand so every hop
 * is checked against the hosts a GitHub release download goes through; anything else is refused.
 */

export const DEFAULT_RELEASE_BASE = "https://github.com/memtro-org/memtro-cli/releases";

/** Where GitHub sends `releases/download/...` (observed 2026-11-12: release-assets; objects is the older host). */
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
