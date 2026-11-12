import { VERSION } from "../../version.js";
import type { AttestationSource } from "../net.js";
import { snappyDecode } from "./snappy.js";

/**
 * Asking GitHub for the provenance attestations of one digest
 * (https://docs.github.com/rest/repos/attestations#list-attestations), unauthenticated: no Authorization header,
 * nothing from a Memtro profile, credentials omitted, and no redirect followed. Every response is size-capped.
 *
 * The answer is one of: a list (perhaps after following `Link: rel="next"`), "none" (404, or 200 with an empty
 * list: GitHub's two ways of saying there is no attestation), or "unavailable" with a reason a person can read.
 */

const PER_PAGE = 30;
const MAX_PAGES = 4;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export type Listing = { kind: "list"; entries: unknown[]; truncated: boolean } | { kind: "none" } | { kind: "unavailable"; detail: string };

export function apiHeaders(): Record<string, string> {
  return { "user-agent": `memtro-cli/${VERSION}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
}

class TooLarge extends Error {}

async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > cap) throw new TooLarge();
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** The `rel="next"` target of a Link header, or null. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (m && /(^|;)\s*rel="?next"?\s*(;|$)/.test(m[2]!)) return m[1]!;
  }
  return null;
}

function networkDetail(err: unknown, caller: AbortSignal): string {
  if (caller.aborted) throw err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "GitHub's API did not answer in time";
  return "GitHub's API was unreachable";
}

function statusDetail(status: number): string {
  if (status === 403 || status === 429) return `GitHub's API declined to answer (HTTP ${status}; it allows 60 unauthenticated requests an hour from one address)`;
  if (status >= 500) return `GitHub's API failed (HTTP ${status})`;
  return `GitHub's API answered HTTP ${status}, which this build does not expect`;
}

/**
 * `caller` is the update's own signal: when it is aborted the error propagates (the update was cancelled). `bounded`
 * adds this check's time limit, whose expiry is "unavailable".
 */
export async function listAttestations(fetchImpl: typeof fetch, source: AttestationSource, digestHex: string, caller: AbortSignal, bounded: AbortSignal): Promise<Listing> {
  let url: string | null = `${source.api}/repos/memtro-org/memtro-cli/attestations/sha256:${digestHex}?predicate_type=provenance&per_page=${PER_PAGE}`;
  const entries: unknown[] = [];
  let firstPath = "";
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) return { kind: "list", entries, truncated: true };
    const target: URL = new URL(url);
    if (!source.allowedApi(target)) return { kind: "unavailable", detail: `GitHub's API pointed to ${target.origin}, which this build does not ask` };
    // A next page is a page of the same list: the same digest's path, only the query differs.
    if (page === 0) firstPath = target.pathname;
    else if (target.pathname !== firstPath) return { kind: "unavailable", detail: "GitHub's API pointed the next page at another list" };
    let res: Response;
    let body: Buffer;
    try {
      res = await fetchImpl(target, { method: "GET", headers: apiHeaders(), redirect: "manual", credentials: "omit", signal: bounded });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 404 && page === 0) return { kind: "none" };
        if (res.status === 404) break;
        return { kind: "unavailable", detail: statusDetail(res.status) };
      }
      body = await readCapped(res, MAX_PAGE_BYTES);
    } catch (err) {
      if (err instanceof TooLarge) return { kind: "unavailable", detail: "GitHub's API sent more than this build reads" };
      return { kind: "unavailable", detail: networkDetail(err, caller) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return { kind: "unavailable", detail: "GitHub's API answered with something that is not JSON" };
    }
    const list = typeof parsed === "object" && parsed !== null ? (parsed as { attestations?: unknown }).attestations : undefined;
    if (!Array.isArray(list)) return { kind: "unavailable", detail: "GitHub's API answered in a form this build does not read" };
    entries.push(...list);
    const next = nextLink(res.headers.get("link"));
    url = next ? new URL(next, target).toString() : null;
  }
  return entries.length === 0 ? { kind: "none" } : { kind: "list", entries, truncated: false };
}

export type Fetched = { ok: true; bundle: unknown } | { ok: false; detail: string };

/** An attestation's `bundle_url`: Snappy-compressed JSON on GitHub's storage host. */
export async function fetchBundle(fetchImpl: typeof fetch, source: AttestationSource, raw: string, caller: AbortSignal, bounded: AbortSignal): Promise<Fetched> {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { ok: false, detail: "an attestation's bundle_url is not a URL" };
  }
  if (!source.allowedBundle(target)) return { ok: false, detail: `an attestation's bundle is on ${target.origin}, which this build does not ask` };
  let blob: Buffer;
  try {
    const res = await fetchImpl(target, { method: "GET", headers: { "user-agent": `memtro-cli/${VERSION}`, accept: "*/*" }, redirect: "manual", credentials: "omit", signal: bounded });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, detail: `GitHub's attestation storage answered HTTP ${res.status}` };
    }
    blob = await readCapped(res, MAX_BLOB_BYTES);
  } catch (err) {
    if (err instanceof TooLarge) return { ok: false, detail: "an attestation's bundle is larger than this build reads" };
    if (caller.aborted) throw err;
    return { ok: false, detail: "GitHub's attestation storage could not be reached" };
  }
  try {
    return { ok: true, bundle: JSON.parse(snappyDecode(blob, MAX_BUNDLE_BYTES).toString("utf8")) };
  } catch {
    return { ok: false, detail: "an attestation's bundle could not be decoded" };
  }
}
