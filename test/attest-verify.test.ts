// The build-attestation verifier against real bundles (jq, uv, cli/cli) and the embedded Sigstore root, offline.
// The clock is never read: each bundle is judged at the time its own signed log entry gives. Every tamper case
// must come out REFUSED; every "this build cannot judge it" case must come out unknown (unchecked).
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { test } from "node:test";
import { pae, verifyDsse } from "../src/update/attest/dsse.js";
import { embeddedRoot, judge, memtroPolicy, MEMTRO_REPOSITORY, verifyBundle, type IdentityPolicy, type TrustedRoot } from "../src/update/attest/index.js";
import { checkIdentity, FULCIO_OIDS, leafIdentity, type Identity } from "../src/update/attest/policy.js";
import { checkChain } from "../src/update/attest/root.js";
import { TRUSTED_ROOT_JSON, TRUSTED_ROOT_SHA256 } from "../src/update/attest/root-data.js";
import { Refused, Unjudgeable } from "../src/update/attest/verdict.js";
import { clone, entry0, FIXTURES, fixture, fixtureBytes, flip, type Bundle } from "./attest-fixtures.js";

const JQ = fixture("jqlang-jq-jq-linux-arm64.jq-1.8.2");
const JQ_OLD = fixture("jqlang-jq-jq-linux-arm64.jq-1.8.1");
const UV = fixture("astral-sh-uv-uv-installer.sh.0.13.7");

const verdict = (b: Bundle, digest = JQ.digest, policy: IdentityPolicy = JQ.policy, root?: TrustedRoot) => verifyBundle(b, digest, policy, root);

function refused(b: Bundle, why?: RegExp, opts: { digest?: string; policy?: IdentityPolicy; root?: TrustedRoot } = {}): void {
  const v = verdict(b, opts.digest, opts.policy, opts.root);
  assert.equal(v.status, "refused", JSON.stringify(v));
  if (why) assert.match((v as { reason: string }).reason, why);
}

function unknown(b: Bundle, why?: RegExp, root?: TrustedRoot): void {
  const v = verdict(b, JQ.digest, JQ.policy, root);
  assert.equal(v.status, "unknown", JSON.stringify(v));
  if (why) assert.match((v as { reason: string }).reason, why);
}

const jq = (): Bundle => clone(JQ.provenance);
const reencode = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

// ---------------------------------------------------------------------------------------------------------------
// The embedded root

test("the embedded trusted root is byte-identical to the recorded Sigstore file", () => {
  const sum = createHash("sha256").update(Buffer.from(TRUSTED_ROOT_JSON, "utf8")).digest("hex");
  assert.equal(sum, "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66");
  assert.equal(TRUSTED_ROOT_SHA256, sum);
  assert.equal(TRUSTED_ROOT_JSON, fixtureBytes("trusted_root.json").toString("utf8"));
  const root = embeddedRoot();
  assert.deepEqual(
    root.tlogs.map((t) => [t.baseUrl, t.keyDetails]),
    [
      ["https://rekor.sigstore.dev", "PKIX_ECDSA_P256_SHA_256"],
      ["https://log2025-1.rekor.sigstore.dev", "PKIX_ED25519"],
    ],
  );
  assert.equal(root.cas.length, 2);
  // Rekor v1's log id is the SHA-256 of its key (the v2 log's Ed25519 id is derived differently).
  for (const t of root.tlogs.filter((x) => x.keyDetails === "PKIX_ECDSA_P256_SHA_256")) {
    assert.ok(createHash("sha256").update(t.key.export({ type: "spki", format: "der" })).digest().equals(t.keyId), "log id is the key's SPKI hash");
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Real bundles, under their own repositories' identities

for (const name of FIXTURES) {
  test(`real bundle verifies under its own repository's policy, as gh did: ${name}`, () => {
    const f = fixture(name);
    assert.ok(f.ghVerifiedDigests.includes(f.digest), "gh attestation verify accepted this digest");
    assert.deepEqual(verifyBundle(f.provenance, f.digest, f.policy), { status: "verified" });
    // GitHub's own release attestation (RFC 3161 only, GitHub's instance) is beyond this build: unknown, not refused.
    if (f.release) assert.equal(verifyBundle(f.release, f.digest, f.policy).status, "unknown");
  });
}

test("no dependence on today's date: the same verdict with the clock moved to 2100", () => {
  const realNow = Date.now;
  Date.now = () => Date.parse("2100-01-01T00:00:00Z");
  try {
    assert.deepEqual(verdict(jq()), { status: "verified" });
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Identity policy

test("memtro's own policy: exact values, repository and owner ids as confirmed with the API", () => {
  assert.deepEqual(MEMTRO_REPOSITORY, { slug: "memtro-org/memtro-cli", repositoryId: 1455158311, ownerId: 341420199 });
  assert.deepEqual(memtroPolicy("0.3.0"), {
    san: "https://github.com/memtro-org/memtro-cli/.github/workflows/release.yml@refs/tags/v0.3.0",
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryUri: "https://github.com/memtro-org/memtro-cli",
    sourceRef: "refs/tags/v0.3.0",
    repositoryId: 1455158311,
    ownerId: 341420199,
    runnerEnvironment: "github-hosted",
    trigger: "push",
  });
});

test("a real bundle under the WRONG repository's policy is refused, including memtro's", () => {
  refused(jq(), /issued to/, { policy: UV.policy });
  refused(jq(), /issued to/, { policy: memtroPolicy("1.8.2") });
  refused(clone(UV.provenance), /issued to/, { digest: UV.digest, policy: JQ.policy });
});

test("the wrong tag (version) is refused", () => {
  refused(jq(), /issued to/, { policy: JQ_OLD.policy });
});

test("every policy field is enforced: changing any one of them refuses the real bundle", () => {
  const fields: Array<[keyof IdentityPolicy, unknown]> = [
    ["san", JQ.policy.san.replace("jq-1.8.2", "jq-1.8.3")],
    ["issuer", "https://token.actions.githubusercontent.com/"],
    ["sourceRepositoryUri", "https://github.com/jqlang/jq2"],
    ["sourceRef", "refs/tags/jq-1.8.1"],
    ["repositoryId", JQ.policy.repositoryId + 1],
    ["ownerId", JQ.policy.ownerId + 1],
    ["runnerEnvironment", "self-hosted"],
  ];
  for (const [k, v] of fields) refused(jq(), undefined, { policy: { ...JQ.policy, [k]: v } });
  // Case matters: GitHub's own matching is case-insensitive, this one is exact.
  refused(jq(), /issued to/, { policy: { ...JQ.policy, san: JQ.policy.san.replace("jqlang", "JQLang") } });
});

function identityFor(policy: IdentityPolicy, over: { san?: Array<string | null>; drop?: string } = {}): Identity {
  const fulcio = new Map<string, string>([
    [FULCIO_OIDS.issuer, policy.issuer],
    [FULCIO_OIDS.sourceRepositoryUri, policy.sourceRepositoryUri],
    [FULCIO_OIDS.sourceRef, policy.sourceRef],
    [FULCIO_OIDS.repositoryId, String(policy.repositoryId)],
    [FULCIO_OIDS.ownerId, String(policy.ownerId)],
    [FULCIO_OIDS.runnerEnvironment, policy.runnerEnvironment],
    ...(policy.trigger !== undefined ? [[FULCIO_OIDS.trigger, policy.trigger] as [string, string]] : []),
  ]);
  if (over.drop) fulcio.delete(over.drop);
  return { sans: over.san ?? [policy.san], fulcio };
}

test("policy: exact matches only; prefixes and look-alikes are refused", () => {
  const p = memtroPolicy("0.2.0");
  checkIdentity(identityFor(p), p);
  for (const san of [
    "https://github.com/memtro-org/memtro-cli-evil/.github/workflows/release.yml@refs/tags/v0.2.0",
    "https://github.com/memtro-org/memtro-cli/.github/workflows/release.yml@refs/tags/v0.2.0-evil",
    "https://github.com/memtro-org/memtro-cli/.github/workflows/release.yml@refs/tags/v0.2.00",
    "https://github.com/memtro-org/memtro-cli/.github/workflows/release.yml@refs/heads/v0.2.0",
    "https://github.com/memtro-org/memtro-cli/.github/workflows/ci.yml@refs/tags/v0.2.0",
    "https://github.com/Memtro-org/memtro-cli/.github/workflows/release.yml@refs/tags/v0.2.0",
    "https://github.com/memtro-org/memtro-cli/.github/workflows/release.yml@refs/tags/v0.2.0 ",
    "https://github.com/memtro-org/memtro-cli/",
  ]) {
    assert.throws(() => checkIdentity(identityFor(p, { san: [san] }), p), Refused, san);
  }
  assert.throws(() => checkIdentity({ ...identityFor(p), fulcio: new Map([...identityFor(p).fulcio, [FULCIO_OIDS.sourceRepositoryUri, "https://github.com/memtro-org/memtro-cli-evil"]]) }, p), Refused);
  assert.throws(() => checkIdentity({ ...identityFor(p), fulcio: new Map([...identityFor(p).fulcio, [FULCIO_OIDS.sourceRef, "refs/tags/v0.2.0-evil"]]) }, p), Refused);
  assert.throws(() => checkIdentity({ ...identityFor(p), fulcio: new Map([...identityFor(p).fulcio, [FULCIO_OIDS.repositoryId, "01455158311"]]) }, p), Refused);
  // A run started by anything but the tag push (workflow_dispatch on the tag ref), or with no trigger recorded: refused.
  assert.throws(() => checkIdentity({ ...identityFor(p), fulcio: new Map([...identityFor(p).fulcio, [FULCIO_OIDS.trigger, "workflow_dispatch"]]) }, p), Refused);
  assert.throws(() => checkIdentity(identityFor(p, { drop: FULCIO_OIDS.trigger }), p), /no trigger/);
  // Two SANs, a non-URI SAN, or none: refused.
  assert.throws(() => checkIdentity(identityFor(p, { san: [p.san, p.san] }), p), Refused);
  assert.throws(() => checkIdentity(identityFor(p, { san: [null] }), p), Refused);
  assert.throws(() => checkIdentity(identityFor(p, { san: [] }), p), Refused);
});

test("policy: a missing Fulcio extension fails; constraints are never silently dropped (GHSA-52v5-jr5w-gjxr)", () => {
  const p = memtroPolicy("0.2.0");
  for (const oid of Object.values(FULCIO_OIDS)) {
    assert.throws(() => checkIdentity(identityFor(p, { drop: oid }), p), (e: unknown) => e instanceof Refused && /has no/.test(e.message), oid);
  }
});

test("policy: the real leaf's identity is read from the DER-encoded extensions", () => {
  const der = Buffer.from(JQ.provenance.verificationMaterial.certificate.rawBytes, "base64");
  const id = leafIdentity(der);
  assert.deepEqual(id.sans, [JQ.policy.san]);
  assert.equal(id.fulcio.get(FULCIO_OIDS.repositoryId), "5101141");
  assert.equal(id.fulcio.get(FULCIO_OIDS.runnerEnvironment), "github-hosted");
  checkIdentity(id, JQ.policy);
});

// ---------------------------------------------------------------------------------------------------------------
// One tamper per check that may not be skipped

test("DSSE: a flipped envelope signature is refused", () => {
  const b = jq();
  b.dsseEnvelope.signatures[0].sig = flip(b.dsseEnvelope.signatures[0].sig);
  refused(b, /signature/);
});

test("DSSE: the signature is over the PAE with the leaf's key; any change to the payload fails it", () => {
  const b = jq();
  const leaf = new X509Certificate(Buffer.from(b.verificationMaterial.certificate.rawBytes, "base64"));
  const payload = Buffer.from(b.dsseEnvelope.payload, "base64");
  const sig = Buffer.from(b.dsseEnvelope.signatures[0].sig, "base64");
  assert.equal(verifyDsse(b.dsseEnvelope.payloadType, payload, sig, leaf.publicKey), true);
  assert.equal(verifyDsse(b.dsseEnvelope.payloadType, Buffer.concat([payload, Buffer.from(" ")]), sig, leaf.publicKey), false);
  assert.equal(verifyDsse("application/vnd.in-toto+jsonx", payload, sig, leaf.publicKey), false);
  // Another repository's key does not verify it.
  const other = new X509Certificate(Buffer.from(UV.provenance.verificationMaterial.certificate.rawBytes, "base64"));
  assert.equal(verifyDsse(b.dsseEnvelope.payloadType, payload, sig, other.publicKey), false);
});

test("DSSE: PAE uses UTF-8 byte lengths, byte-exact, including non-ASCII (GHSA-jfc7-64v2-mr8c)", () => {
  assert.equal(pae("application/vnd.in-toto+json", Buffer.from("{}")).toString("utf8"), "DSSEv1 28 application/vnd.in-toto+json 2 {}");
  const body = Buffer.from('{"name":"é😀"}', "utf8");
  const out = pae("tÿpe", body);
  assert.ok(out.equals(Buffer.concat([Buffer.from("DSSEv1 5 tÿpe 17 ", "utf8"), body])), out.toString("utf8"));
  assert.equal(body.length, 17);
  // A latin1 rendering of the same would differ, so a signature over one never verifies the other.
  assert.ok(!out.equals(Buffer.from(`DSSEv1 4 tÿpe ${'{"name":"é😀"}'.length} {"name":"é😀"}`, "latin1")));
});

test("payload edited (a subject renamed) is refused", () => {
  const b = jq();
  const st = JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64").toString("utf8"));
  st.subject[0].name = "x";
  b.dsseEnvelope.payload = reencode(st);
  refused(b, /payload|signature/);
});

test("SET: integratedTime changed without re-signing is refused (GHSA-xgjw-pm74-86q4)", () => {
  for (const delta of [1, -1, 86_400, -86_400 * 365]) {
    const b = jq();
    entry0(b).integratedTime = String(Number(entry0(b).integratedTime) + delta);
    refused(b, /signed entry timestamp does not verify/);
  }
});

test("SET: a flipped SET, an edited logIndex, an edited body, another log id: refused", () => {
  const a = jq();
  entry0(a).inclusionPromise.signedEntryTimestamp = flip(entry0(a).inclusionPromise.signedEntryTimestamp);
  refused(a, /signed entry timestamp/);
  const b = jq();
  entry0(b).logIndex = String(Number(entry0(b).logIndex) + 1);
  refused(b, /signed entry timestamp/);
  const c = jq();
  const body = JSON.parse(Buffer.from(entry0(c).canonicalizedBody, "base64").toString("utf8"));
  body.spec.payloadHash.value = "0".repeat(64);
  entry0(c).canonicalizedBody = reencode(body);
  refused(c, /signed entry timestamp/);
});

test("tlog binding: a genuine log entry for a different artifact is refused (cosign GHSA-whqx-f9j3-ch6m)", () => {
  const b = jq();
  b.verificationMaterial.tlogEntries = clone(JQ_OLD.provenance.verificationMaterial.tlogEntries);
  refused(b, /log entry records a different/);
});

test("tlog binding: an entry naming another certificate is refused, even with the matching envelope", () => {
  // jq 1.8.1's envelope and entry with jq 1.8.2's leaf: the entry's certificate is not this leaf.
  const b = clone(JQ_OLD.provenance);
  b.verificationMaterial.certificate = clone(JQ.provenance.verificationMaterial.certificate);
  // The envelope's signature is now checked under the leaf first, so this is refused there; the log binding below it
  // would refuse it too.
  refused(b, /signature does not verify|different certificate/, { digest: JQ_OLD.digest, policy: JQ_OLD.policy });
});

test("tlog: a second, forged entry beside a genuine one is refused (every judged entry must pass)", () => {
  const b = jq();
  const forged = clone(entry0(b));
  forged.integratedTime = String(Number(forged.integratedTime) + 5);
  b.verificationMaterial.tlogEntries.push(forged);
  refused(b, /signed entry timestamp/);
});

test("chain: the CA must be valid at the signing time, every certificate on the path too (GHSA-wfqv-66vq-46rm)", () => {
  const root = embeddedRoot();
  const leafDer = Buffer.from(JQ.provenance.verificationMaterial.certificate.rawBytes, "base64");
  const leaf = new X509Certificate(leafDer);
  const t = Number(entry0(JQ.provenance).integratedTime) * 1000;
  checkChain(leaf, leafDer, root, t);
  // The leaf lives ten minutes: an hour later (or a day before) it was not valid.
  assert.throws(() => checkChain(leaf, leafDer, root, t + 3_600_000), (e: unknown) => e instanceof Refused && /not valid at the signing time/.test(e.message));
  assert.throws(() => checkChain(leaf, leafDer, root, t - 86_400_000), Refused);
  // The CA's own window closed before the signing time.
  const closed: TrustedRoot = { ...root, cas: root.cas.map((c) => ({ ...c, validFor: { start: c.validFor.start, end: t - 1 } })) };
  refused(jq(), /not trusted at the signing time/, { root: closed });
});

test("chain: a known CA (by key id) that did not sign the leaf is refused, not unknown", () => {
  const root = embeddedRoot();
  const real = root.cas.find((c) => c.chain.length === 2)!;
  const old = root.cas.find((c) => c.chain.length === 1)!;
  // The 2021 root-only chain presented under the real intermediate's key id, valid for all time.
  const impostor: TrustedRoot = { ...root, cas: [{ chain: old.chain, issuerKeyId: real.issuerKeyId, validFor: { start: 0, end: null } }] };
  refused(jq(), /does not chain/, { root: impostor });
});

test("chain: a leaf from another time swapped in is refused", () => {
  const b = jq();
  b.verificationMaterial.certificate = clone(JQ_OLD.provenance.verificationMaterial.certificate);
  refused(b);
});

test("statement: a digest not among the subjects is refused (sigstore-ruby GHSA-mhg6-2q2v-9h2c)", () => {
  refused(jq(), /does not name this download's digest/, { digest: JQ_OLD.digest });
  refused(jq(), /does not name/, { digest: "0".repeat(64) });
  // A prefix of a real subject digest is not a match.
  const sub = JQ.ghVerifiedDigests[0]!;
  refused(jq(), /does not name/, { digest: `${sub.slice(0, 63)}0` === sub ? `${sub.slice(0, 63)}1` : `${sub.slice(0, 63)}0` });
  assert.throws(() => verdict(jq(), JQ.digest.toUpperCase()), /lowercase hex/);
});

test("statement: not SLSA provenance, or not an in-toto statement, is refused (its signature also fails)", () => {
  for (const edit of [(st: Bundle) => (st.predicateType = "https://slsa.dev/provenance/v0.2"), (st: Bundle) => (st._type = "https://in-toto.io/Statement/v0.1")]) {
    const b = jq();
    const st = JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64").toString("utf8"));
    edit(st);
    b.dsseEnvelope.payload = reencode(st);
    refused(b);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// A fallback or alternate parse path cannot bypass anything (cosign GHSA-fx35-mq7g-6g98)

test("v0.3 with a v0.1-style certificate chain (with or without the leaf field) is refused, not read another way", () => {
  const a = jq();
  a.verificationMaterial.x509CertificateChain = { certificates: [a.verificationMaterial.certificate] };
  refused(a, /certificate chain/);
  const b = jq();
  b.verificationMaterial.x509CertificateChain = { certificates: [b.verificationMaterial.certificate] };
  delete b.verificationMaterial.certificate;
  refused(b, /certificate chain/);
  const c = jq();
  c.verificationMaterial.publicKey = { hint: "x" };
  refused(c, /bare key/);
  const d = jq();
  d.messageSignature = { messageDigest: { algorithm: "SHA2_256", digest: "AA==" }, signature: "AA==" };
  refused(d, /message/);
});

test("the GitHub release attestation's form cannot stand in for provenance under memtro's policy", () => {
  assert.equal(verifyBundle(clone(UV.release), UV.digest, memtroPolicy("0.13.7")).status, "unknown");
  // And the API's other answer for the same digest, judged together with a refusal, never verifies.
  assert.equal(judge([{ status: "unknown", reason: "x" }, { status: "refused", reason: "y" }]).status, "refused");
});

// ---------------------------------------------------------------------------------------------------------------
// Malformed but claiming the known form: refused

test("malformed v0.3 bundles are refused, not unknown", () => {
  const cases: Array<[string, (b: Bundle) => void]> = [
    ["truncated leaf certificate", (b) => (b.verificationMaterial.certificate.rawBytes = b.verificationMaterial.certificate.rawBytes.slice(0, 400))],
    ["leaf certificate not base64", (b) => (b.verificationMaterial.certificate.rawBytes = `!${b.verificationMaterial.certificate.rawBytes.slice(1)}`)],
    ["no certificate", (b) => delete b.verificationMaterial.certificate],
    ["no envelope", (b) => delete b.dsseEnvelope],
    ["two signatures", (b) => b.dsseEnvelope.signatures.push(b.dsseEnvelope.signatures[0])],
    ["no signatures", (b) => (b.dsseEnvelope.signatures = [])],
    ["another payload type", (b) => (b.dsseEnvelope.payloadType = "application/json")],
    ["payload not base64", (b) => (b.dsseEnvelope.payload = "%%%%")],
    ["no tlog entries and no timestamp", (b) => (b.verificationMaterial.tlogEntries = [])],
    ["integratedTime not a number", (b) => (entry0(b).integratedTime = "12e3")],
    ["integratedTime as a JSON number", (b) => (entry0(b).integratedTime = Number(entry0(b).integratedTime))],
    ["log id the wrong length", (b) => (entry0(b).logId.keyId = "AAAA")],
    ["SET not base64", (b) => (entry0(b).inclusionPromise.signedEntryTimestamp = "not base64!")],
    ["body not JSON", (b) => (entry0(b).canonicalizedBody = Buffer.from("{").toString("base64"))],
    ["verificationMaterial a string", (b) => (b.verificationMaterial = "x")],
    ["tlogEntries an object", (b) => (b.verificationMaterial.tlogEntries = {})],
    ["base64 with whitespace", (b) => (b.dsseEnvelope.payload = ` ${b.dsseEnvelope.payload}`)],
  ];
  for (const [label, edit] of cases) {
    const b = jq();
    edit(b);
    const v = verdict(b);
    assert.equal(v.status, "refused", `${label}: ${JSON.stringify(v)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// What this build cannot judge: unknown (the update proceeds unchecked)

test("unknown media types, Rekor v2 entries, a missing SET, an unknown log key or CA: unknown", () => {
  for (const mt of ["application/vnd.dev.sigstore.bundle.v0.4+json", "application/vnd.dev.sigstore.bundle+json;version=0.2", "", 3]) {
    const b = jq();
    b.mediaType = mt;
    unknown(b, /media type/);
  }
  const noType = jq();
  delete noType.mediaType;
  unknown(noType);
  unknown("not a bundle");

  const v2 = jq();
  entry0(v2).kindVersion = { kind: "dsse", version: "0.0.2" };
  unknown(v2, /Rekor v2/);
  const intoto = jq();
  entry0(intoto).kindVersion = { kind: "intoto", version: "0.0.2" };
  unknown(intoto, /kind/);

  const noSet = jq();
  delete entry0(noSet).inclusionPromise;
  unknown(noSet, /no signed entry timestamp/);

  const otherLog = jq();
  entry0(otherLog).logId.keyId = Buffer.alloc(32, 7).toString("base64");
  unknown(otherLog, /log the embedded trusted root does not know/);

  const root = embeddedRoot();
  unknown(jq(), /log the embedded trusted root does not know/, { ...root, tlogs: root.tlogs.filter((t) => t.keyDetails !== "PKIX_ECDSA_P256_SHA_256") });
  unknown(jq(), /certificate authority the embedded trusted root does not know/, { ...root, cas: [] });

  const rfc3161Only = jq();
  rfc3161Only.verificationMaterial.tlogEntries = [];
  rfc3161Only.verificationMaterial.timestampVerificationData = { rfc3161Timestamps: [{ signedTimestamp: "AAAA" }] };
  unknown(rfc3161Only, /RFC 3161/);
});

test("an unknown entry beside a genuine one does not stop it verifying", () => {
  const b = jq();
  const v2 = clone(entry0(b));
  v2.kindVersion = { kind: "dsse", version: "0.0.2" };
  delete v2.inclusionPromise;
  b.verificationMaterial.tlogEntries.unshift(v2);
  assert.deepEqual(verdict(b), { status: "verified" });
});

test("judge: verified wins; otherwise any refusal; unknown only when every one is unknown; none is refused", () => {
  assert.deepEqual(judge([{ status: "refused", reason: "a" }, { status: "verified" }]), { status: "verified" });
  assert.equal(judge([{ status: "refused", reason: "a" }]).status, "refused");
  assert.equal(judge([]).status, "refused");
  assert.equal(judge([{ status: "unknown", reason: "a" }, { status: "unknown", reason: "b" }]).status, "unchecked");
  assert.equal(judge([{ status: "unknown", reason: "a" }], { truncated: true }).status, "unchecked");
  assert.ok(Unjudgeable && Refused);
});

test("a bundle that is wrong whoever signed it is refused even when its log or CA is unknown (never 'unknown')", () => {
  const unknownLog = (b: Bundle) => (b.verificationMaterial.tlogEntries[0].logId.keyId = Buffer.alloc(32, 1).toString("base64"));
  // Wrong version under memtro-style tag policy: identity differs, refused although the log is unknown.
  const a = jq();
  unknownLog(a);
  refused(a, /issued to/, { policy: { ...JQ.policy, san: JQ.policy.san.replace("jq-1.8.2", "jq-9.9.9"), sourceRef: "refs/tags/jq-9.9.9" } });
  // Another digest: refused although the log is unknown.
  const b = jq();
  unknownLog(b);
  refused(b, /does not name this download's digest/, { digest: "0".repeat(64) });
  // A flipped envelope signature: refused although the log is unknown.
  const c = jq();
  unknownLog(c);
  const sig = Buffer.from(c.dsseEnvelope.signatures[0].sig, "base64");
  sig[sig.length - 1]! ^= 1;
  c.dsseEnvelope.signatures[0].sig = sig.toString("base64");
  refused(c, /signature does not verify/);
  // And the correct one with the unknown log stays unknown.
  const d = jq();
  unknownLog(d);
  unknown(d, /transparency log the embedded trusted root does not know/);
});

test("the build trigger is read from the real leaf: jq's tag push verifies under trigger push, not under another", () => {
  assert.equal(verdict(jq(), JQ.digest, { ...JQ.policy, trigger: "push" }).status, "verified");
  refused(jq(), /trigger/, { policy: { ...JQ.policy, trigger: "workflow_dispatch" } });
});

test("the embedded root cannot be changed at run time", () => {
  const root = embeddedRoot();
  assert.ok(Object.isFrozen(root) && Object.isFrozen(root.tlogs) && Object.isFrozen(root.cas));
  assert.throws(() => (root.tlogs as unknown as unknown[]).push({}));
  assert.equal(embeddedRoot(), root);
});
