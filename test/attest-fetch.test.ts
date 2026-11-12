// The attestation check end to end against a local stand-in for api.github.com (and its bundle storage): the three
// tiers, pagination, bundle_url with Snappy, the hosts it may ask and the headers it sends. Nothing reaches the
// network; MEMTRO_RELEASE_BASE points every GitHub host at 127.0.0.1, as the updater's other tests do.
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { nextLink } from "../src/update/attest/fetch.js";
import { checkAttestation, type AttestationResult } from "../src/update/attest/index.js";
import { snappyDecode, SnappyError } from "../src/update/attest/snappy.js";
import { attestationSource } from "../src/update/net.js";
import { VERSION } from "../src/version.js";
import { clone, fixture, type Bundle } from "./attest-fixtures.js";

const JQ = fixture("jqlang-jq-jq-linux-arm64.jq-1.8.2");
const UV = fixture("astral-sh-uv-uv-installer.sh.0.13.7");
const API_PATH = "/repos/memtro-org/memtro-cli/attestations/";

let server: Server;
let base = "";
let handler: (req: IncomingMessage, res: ServerResponse, path: string) => void = () => {};
const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res, new URL(req.url ?? "/", "http://x").pathname);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  seen.length = 0;
  handler = (_req, res) => void res.writeHead(404).end();
});

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void =>
  void res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

/** checkAttestation for the jq fixture's digest under jq's identity, via the local server. */
function check(opts: { digest?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<AttestationResult> {
  return checkAttestation(
    { digest: opts.digest ?? JQ.digest, version: "1.8.2", env: opts.env ?? { MEMTRO_RELEASE_BASE: `${base}/releases`, MEMTRO_API_KEY: "mk_live_never_sent" }, fetch: globalThis.fetch, signal: opts.signal ?? new AbortController().signal },
    { policy: JQ.policy, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) },
  );
}

/** Snappy with literals only: valid input for any decoder. */
function snappyLiterals(data: Buffer): Buffer {
  const head: number[] = [];
  for (let n = data.length; ; n >>>= 7) {
    if (n < 0x80) {
      head.push(n);
      break;
    }
    head.push((n & 0x7f) | 0x80);
  }
  const parts: Buffer[] = [Buffer.from(head)];
  for (let p = 0; p < data.length; p += 65536) {
    const chunk = data.subarray(p, p + 65536);
    const n = chunk.length - 1;
    parts.push(n < 60 ? Buffer.from([n << 2]) : n < 256 ? Buffer.from([60 << 2, n]) : Buffer.from([61 << 2, n & 0xff, n >> 8]), chunk);
  }
  return Buffer.concat(parts);
}

function assertClean(): void {
  assert.ok(seen.length > 0);
  for (const r of seen) {
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers.cookie, undefined);
    assert.ok(!JSON.stringify(r.headers).includes("mk_live"), "no Memtro key in any request");
    assert.equal(r.headers["user-agent"], `memtro-cli/${VERSION}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------

test("verified: the inline bundle of a real attestation, with the documented request", async () => {
  handler = (_req, res, path) => (path.startsWith(API_PATH) ? json(res, 200, { attestations: [{ repository_id: 1, bundle: JQ.provenance, bundle_url: null }] }) : res.writeHead(404).end());
  assert.deepEqual(await check(), { status: "verified" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, `${API_PATH}sha256:${JQ.digest}?predicate_type=provenance&per_page=30`);
  assert.equal(seen[0]!.headers.accept, "application/vnd.github+json");
  assert.equal(seen[0]!.headers["x-github-api-version"], "2022-11-28");
  assertClean();
});

test("verified through bundle_url: Snappy-compressed JSON on the storage host", async () => {
  handler = (_req, res, path) => {
    if (path.startsWith(API_PATH)) return json(res, 200, { attestations: [{ bundle: null, bundle_url: `${base}/attestations/5101141/x.json.sn?sig=abc` }] });
    if (path === "/attestations/5101141/x.json.sn") return void res.writeHead(200).end(snappyLiterals(Buffer.from(JSON.stringify(JQ.provenance))));
    res.writeHead(404).end();
  };
  assert.deepEqual(await check(), { status: "verified" });
  assert.equal(seen.length, 2);
  assertClean();
});

test("pagination: the Link header's next page is followed, and an unjudgeable first entry does not hide a good one", async () => {
  handler = (req, res, path) => {
    if (!path.startsWith(API_PATH)) return void res.writeHead(404).end();
    if (!(req.url ?? "").includes("after=")) return json(res, 200, { attestations: [{ bundle: UV.release }] }, { link: `<${base}${API_PATH}sha256:${JQ.digest}?per_page=30&after=abc>; rel="next"` });
    json(res, 200, { attestations: [{ bundle: JQ.provenance }] });
  };
  assert.deepEqual(await check(), { status: "verified" });
  assert.equal(seen.length, 2);
});

test("a Link to another host is not followed: unchecked", async () => {
  handler = (_req, res) => json(res, 200, { attestations: [{ bundle: UV.release }] }, { link: `<https://evil.example${API_PATH}x>; rel="next"` });
  const r = await check();
  assert.equal(r.status, "unchecked");
  assert.equal(seen.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// REFUSED

test("refused: API 404 (no attestation), or 200 with an empty list", async () => {
  handler = (_req, res) => json(res, 404, { message: "Not Found" });
  let r = await check();
  assert.equal(r.status, "refused");
  assert.match((r as { reason: string }).reason, /no build attestation/);
  handler = (_req, res) => json(res, 200, { attestations: [] });
  r = await check();
  assert.equal(r.status, "refused");
});

test("refused: a real attestation for another digest or under another identity", async () => {
  handler = (_req, res) => json(res, 200, { attestations: [{ bundle: JQ.provenance }] });
  assert.equal((await check({ digest: UV.digest })).status, "refused");
  // memtro's own policy (the default) refuses jq's genuine bundle.
  const r = await checkAttestation({ digest: JQ.digest, version: "1.8.2", env: { MEMTRO_RELEASE_BASE: `${base}/releases` }, fetch: globalThis.fetch, signal: new AbortController().signal });
  assert.equal(r.status, "refused");
  assert.match((r as { reason: string }).reason, /issued to/);
});

test("refused: a truncated or malformed bundle that claims v0.3", async () => {
  const truncated = clone(JQ.provenance);
  truncated.verificationMaterial.certificate.rawBytes = truncated.verificationMaterial.certificate.rawBytes.slice(0, 200);
  const noEnvelope: Bundle = { mediaType: JQ.provenance.mediaType, verificationMaterial: JQ.provenance.verificationMaterial };
  for (const b of [truncated, noEnvelope]) {
    handler = (_req, res) => json(res, 200, { attestations: [{ bundle: b }] });
    assert.equal((await check()).status, "refused");
  }
});

test("refused beats unknown: one understood failure and one unknown form", async () => {
  const other = clone(JQ.provenance);
  other.mediaType = "application/vnd.dev.sigstore.bundle.v0.9+json";
  const bad = clone(JQ.provenance);
  bad.dsseEnvelope.signatures[0].sig = bad.dsseEnvelope.signatures[0].sig.replace(/^./, (c: string) => (c === "M" ? "N" : "M"));
  handler = (_req, res) => json(res, 200, { attestations: [{ bundle: other }, { bundle: bad }] });
  assert.equal((await check()).status, "refused");
});

// ---------------------------------------------------------------------------------------------------------------
// UNCHECKED

test("unchecked: API unreachable, timed out, rate-limited (403, 429) or failing (500, 503)", async () => {
  const offline = await check({ env: { MEMTRO_RELEASE_BASE: "http://127.0.0.1:9/releases" } });
  assert.deepEqual(offline, { status: "unchecked", reason: "GitHub's API was unreachable" });

  handler = () => {}; // accepts and never answers
  const slow = await check({ timeoutMs: 200 });
  assert.deepEqual(slow, { status: "unchecked", reason: "GitHub's API did not answer in time" });

  for (const status of [403, 429, 500, 503]) {
    handler = (_req, res) => json(res, status, { message: "x" });
    const r = await check();
    assert.equal(r.status, "unchecked", String(status));
    assert.match((r as { reason: string }).reason, new RegExp(`HTTP ${status}`));
  }
});

test("unchecked: an answer this build does not read (410, a redirect, not JSON, no list)", async () => {
  for (const respond of [
    (res: ServerResponse) => json(res, 410, { message: "gone" }),
    (res: ServerResponse) => void res.writeHead(301, { location: `${base}/elsewhere` }).end(),
    (res: ServerResponse) => void res.writeHead(200).end("<html>"),
    (res: ServerResponse) => json(res, 200, { items: [] }),
  ]) {
    handler = (_req, res) => respond(res);
    assert.equal((await check()).status, "unchecked");
  }
  assert.ok(!seen.some((r) => r.url === "/elsewhere"), "no redirect followed");
});

test("unchecked: every bundle in a form this build does not know", async () => {
  const cases: Array<[string, (b: Bundle) => void]> = [
    ["unknown media type", (b) => (b.mediaType = "application/vnd.dev.sigstore.bundle.v0.4+json")],
    ["missing SET", (b) => delete b.verificationMaterial.tlogEntries[0].inclusionPromise],
    ["unknown log key", (b) => (b.verificationMaterial.tlogEntries[0].logId.keyId = Buffer.alloc(32, 1).toString("base64"))],
    ["Rekor v2 entry", (b) => (b.verificationMaterial.tlogEntries[0].kindVersion.version = "0.0.2")],
  ];
  for (const [label, edit] of cases) {
    const b = clone(JQ.provenance);
    edit(b);
    handler = (_req, res) => json(res, 200, { attestations: [{ bundle: b }] });
    const r = await check();
    assert.equal(r.status, "unchecked", `${label}: ${JSON.stringify(r)}`);
  }
  // GitHub's private-instance (release) attestation alone.
  handler = (_req, res) => json(res, 200, { attestations: [{ bundle: UV.release }] });
  assert.equal((await check()).status, "unchecked");
});

test("unchecked: bundle_url off the storage host, failing, or not Snappy; no bundle at all", async () => {
  for (const [url, serve] of [
    ["https://evil.example/attestations/x", null],
    [`${base}/attestations/gone`, (res: ServerResponse) => void res.writeHead(403).end()],
    [`${base}/attestations/junk`, (res: ServerResponse) => void res.writeHead(200).end(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))],
  ] as const) {
    handler = (_req, res, path) => (path.startsWith(API_PATH) ? json(res, 200, { attestations: [{ bundle: null, bundle_url: url }] }) : serve ? serve(res) : res.writeHead(404).end());
    assert.equal((await check()).status, "unchecked", url);
  }
  assert.ok(!seen.some((r) => r.url.includes("evil")));
  handler = (_req, res) => json(res, 200, { attestations: [{ repository_id: 1 }] });
  assert.equal((await check()).status, "unchecked");
});

test("cancelled by the caller: rejects, never 'unchecked'", async () => {
  handler = () => {};
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(check({ signal: ctl.signal }));
});

// ---------------------------------------------------------------------------------------------------------------
// Hosts and parsing helpers

test("default hosts: api.github.com for this repository's attestations, and the bundle storage host only", () => {
  const s = attestationSource({});
  assert.equal(s.api, "https://api.github.com");
  const api = (u: string) => s.allowedApi(new URL(u));
  const blob = (u: string) => s.allowedBundle(new URL(u));
  assert.equal(api(`https://api.github.com${API_PATH}sha256:${JQ.digest}?after=x`), true);
  for (const bad of [
    `http://api.github.com${API_PATH}x`,
    `https://api.github.com:444${API_PATH}x`,
    `https://u:p@api.github.com${API_PATH}x`,
    "https://api.github.com/repos/memtro-org/memtro-cli-evil/attestations/x",
    "https://api.github.com/repos/jqlang/jq/attestations/x",
    `https://api.github.com.evil.example${API_PATH}x`,
    `https://github.com${API_PATH}x`,
  ]) {
    assert.equal(api(bad), false, bad);
  }
  assert.equal(blob("https://tmaproduction.blob.core.windows.net/attestations/1455158311/2026/11/12/1.json.sn?sv=x"), true);
  for (const bad of ["http://tmaproduction.blob.core.windows.net/attestations/x", "https://evil.blob.core.windows.net/attestations/x", "https://tmaproduction.blob.core.windows.net/other/x", "https://api.github.com/attestations/x"]) {
    assert.equal(blob(bad), false, bad);
  }
  // The test override: one origin, http only on loopback.
  assert.throws(() => attestationSource({ MEMTRO_RELEASE_BASE: "http://example.com/releases" }));
});

test("Link header: only rel=next", () => {
  assert.equal(nextLink('<https://api.github.com/x?after=1>; rel="next", <https://api.github.com/x?before=1>; rel="prev"'), "https://api.github.com/x?after=1");
  assert.equal(nextLink('<https://api.github.com/x?before=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

test("snappy: literals and copies decode; every malformed form throws; the size cap holds", () => {
  const text = Buffer.from(JSON.stringify(JQ.provenance));
  assert.ok(snappyDecode(snappyLiterals(text), 1 << 20).equals(text));
  // "abc" then a 9-byte copy at offset 3.
  assert.equal(snappyDecode(Buffer.from([12, 0x08, 0x61, 0x62, 0x63, 0x15, 0x03]), 64).toString(), "abcabcabcabc");
  for (const bad of [
    Buffer.from([]),
    Buffer.from([12, 0x08, 0x61, 0x62]), // literal runs past the end
    Buffer.from([12, 0x08, 0x61, 0x62, 0x63, 0x15, 0x04]), // offset before the start
    Buffer.from([12, 0x08, 0x61, 0x62, 0x63, 0x15, 0x00]), // offset 0
    Buffer.from([4, 0x08, 0x61, 0x62, 0x63, 0x15, 0x03]), // copy past the declared length
    Buffer.from([13, 0x08, 0x61, 0x62, 0x63, 0x15, 0x03]), // shorter than declared
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), // length header too long
  ]) {
    assert.throws(() => snappyDecode(bad, 64), SnappyError, bad.toString("hex"));
  }
  assert.throws(() => snappyDecode(snappyLiterals(text), 100), /more than allowed/);
});

test("a Link to another digest's list on the same host is not followed: unchecked", async () => {
  handler = (req, res, path) => {
    if (!path.startsWith(API_PATH)) return void res.writeHead(404).end();
    if (path.includes(JQ.digest)) return json(res, 200, { attestations: [{ bundle: UV.release }] }, { link: `<${base}${API_PATH}sha256:${"0".repeat(64)}?after=x>; rel="next"` });
    json(res, 200, { attestations: [{ bundle: JQ.provenance }] });
  };
  const r = await check();
  assert.equal(r.status, "unchecked", JSON.stringify(r));
  assert.equal(seen.length, 1, "the other list was never asked for");
});
