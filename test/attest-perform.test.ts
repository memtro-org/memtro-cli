// performUpdate with the REAL attestation check, against a local fake release and a fake attestation API on the same
// 127.0.0.1 origin (MEMTRO_RELEASE_BASE stands in for every GitHub host). Nothing reaches the network.
//
// What this cannot cover: the fake cannot produce a genuinely valid attestation for a tarball made here (that needs
// a Fulcio certificate for memtro's release workflow and a Rekor entry). So the "verified" path through performUpdate
// is covered by injecting a verifier (deps.verifyAttestation, whose default is the real one); the real verifier's
// "verified" answer is covered on real bundles in attest-verify.test.ts and attest-fetch.test.ts. Only memtro's first
// attested release can show the real check verifying a real memtro tarball under memtro's own identity.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import type { AttestationRequest } from "../src/update/attest/index.js";
import { performUpdate, type UpdateDeps, type UpdateOutcome } from "../src/update/index.js";
import { VERSION } from "../src/version.js";
import { fixture } from "./attest-fixtures.js";
import { fakeExecutable, fakeGitHub, makeRelease, sha256, type FakeGitHub } from "./update-fixtures.js";

const NEWER = "9.0.0";
const TARGET = `${process.platform}-${process.arch}`;
const FAKE_KEY = "mk_live_this_must_never_be_sent_0123456789";
const API_PATH = "/repos/memtro-org/memtro-cli/attestations/";
const JQ = fixture("jqlang-jq-jq-linux-arm64.jq-1.8.2");

let gh: FakeGitHub;
let dir: string;
let exe: string;
let ran: string;
const OLD = fakeExecutable(VERSION);

before(async () => (gh = await fakeGitHub()));
after(() => gh.close());
afterEach(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  gh.requests.length = 0;
  gh.intercept = null;
  gh.releases.clear();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "memtro-attest-perform-")));
  mkdirSync(join(dir, "bin"));
  exe = join(dir, "bin", "memtro");
  ran = join(dir, "ran.txt");
  writeFileSync(exe, OLD, { mode: 0o755 });
  // The new "executable" records that it was ever run, so a refused download can be shown never to have been.
  const r = makeRelease(NEWER, { [TARGET]: Buffer.from(`#!/bin/sh\necho ran >> "${ran}"\necho ${NEWER}\n`) });
  gh.releases.set(r.tag, r);
  gh.latestTag = r.tag;
});

const deps = (over: Partial<UpdateDeps> = {}): UpdateDeps => ({
  env: { MEMTRO_RELEASE_BASE: gh.base, MEMTRO_API_KEY: FAKE_KEY, PATH: process.env.PATH },
  stateDir: join(dir, "state"),
  now: () => new Date("2026-11-12T10:00:00Z"),
  fetch: globalThis.fetch,
  execPath: exe,
  platform: process.platform,
  arch: process.arch,
  isSea: true,
  ...over,
});

const update = (d: UpdateDeps = deps()): Promise<UpdateOutcome> => performUpdate(d, { signal: new AbortController().signal });

/** Answer the attestation API (and only it) with `respond`. */
function api(respond: (res: ServerResponse, path: string) => void): void {
  gh.intercept = (path, res) => (path.startsWith(API_PATH) ? (respond(res, path), true) : false);
}
const json = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

function assertUntouched(): void {
  assert.equal(sha256(readFileSync(exe)), sha256(OLD), "the old executable is byte-identical");
  assert.deepEqual(readdirSync(join(dir, "bin")), ["memtro"], "no temporary file left behind");
  assert.equal(existsSync(ran), false, "the refused download was never run");
}

function assertNoCredentials(): void {
  for (const r of gh.requests) {
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers.cookie, undefined);
    assert.ok(!JSON.stringify(r.headers).includes(FAKE_KEY));
  }
}

const tarballSum = (): string => sha256(gh.releases.get(`v${NEWER}`)!.files[`memtro-${TARGET}.tar.gz`] as Buffer);

// ---------------------------------------------------------------------------------------------------------------

test("verified (injected verifier): the update proceeds and says so; the verifier gets this tarball's digest and version", async () => {
  const calls: AttestationRequest[] = [];
  const out = await update(deps({ verifyAttestation: async (req) => (calls.push(req), { status: "verified" }) }));
  assert.deepEqual(out, { kind: "updated", from: VERSION, to: NEWER, path: exe, attestation: "verified" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.digest, tarballSum());
  assert.equal(calls[0]!.version, NEWER);
  assert.equal(readFileSync(ran, "utf8"), "ran\n", "proved after the attestation check");
});

test("the attestation is checked only after the checksum matched: a checksum mismatch never asks", async () => {
  const r = makeRelease(NEWER, { [TARGET]: fakeExecutable(NEWER) }, { tamper: TARGET });
  gh.releases.set(r.tag, r);
  let asked = 0;
  const out = await update(deps({ verifyAttestation: async () => (asked++, { status: "verified" }) }));
  assert.equal(out.kind, "failed");
  assert.equal(asked, 0);
});

test("refused (real check): API 404, no attestation for this digest: failed, nothing replaced, nothing run", async () => {
  // The fake answers 404 for anything it does not know, as GitHub does for a digest with no attestation.
  const out = await update();
  assert.equal(out.kind, "failed", JSON.stringify(out));
  assert.match((out as { reason: string }).reason, /not a memtro release build: .*no build attestation/);
  assertUntouched();
  assert.ok(gh.requests.some((r) => r.url === `${API_PATH}sha256:${tarballSum()}`), "asked about exactly this tarball");
  assertNoCredentials();
});

test("refused (real check): API 200 with an empty list", async () => {
  api((res) => json(res, 200, { attestations: [] }));
  const out = await update();
  assert.equal(out.kind, "failed");
  assertUntouched();
});

test("refused (real check): a genuine attestation of something else, and a malformed bundle claiming v0.3", async () => {
  api((res) => json(res, 200, { attestations: [{ bundle: JQ.provenance }] }));
  let out = await update();
  assert.equal(out.kind, "failed");
  assertUntouched();
  const broken = structuredClone(JQ.provenance);
  delete broken.dsseEnvelope;
  api((res) => json(res, 200, { attestations: [{ bundle: broken }] }));
  out = await update();
  assert.equal(out.kind, "failed");
  assertUntouched();
});

for (const [label, respond, detail] of [
  ["500", (res: ServerResponse) => json(res, 500, {}), /HTTP 500/],
  ["403 rate limit", (res: ServerResponse) => json(res, 403, { message: "API rate limit exceeded" }), /HTTP 403/],
  ["429", (res: ServerResponse) => json(res, 429, {}), /HTTP 429/],
  ["unreachable (connection dropped)", (res: ServerResponse) => void res.socket?.destroy(), /unreachable/],
  ["an unknown bundle form", (res: ServerResponse) => json(res, 200, { attestations: [{ bundle: { ...JQ.provenance, mediaType: "application/vnd.dev.sigstore.bundle.v0.4+json" } }] }), /cannot judge/],
] as const) {
  test(`could not be checked (real check): ${label}: the update proceeds on the checksum and says why`, async () => {
    api(respond);
    const out = await update();
    assert.equal(out.kind, "updated", JSON.stringify(out));
    const o = out as Extract<UpdateOutcome, { kind: "updated" }>;
    assert.equal(o.attestation, "unchecked");
    assert.match(o.detail ?? "", detail);
    assert.equal(readFileSync(exe, "utf8").includes(NEWER), true, "the new file is in place");
    assertNoCredentials();
  });
}

test("cancelled while the attestation is being checked: failed as cancelled, nothing replaced", async () => {
  api(() => {}); // never answers
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const out = await performUpdate(deps(), { signal: ctl.signal });
  assert.deepEqual(out, { kind: "failed", reason: "the update was cancelled" });
  assertUntouched();
});
