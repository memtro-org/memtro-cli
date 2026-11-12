// memtro's own release: the real build-provenance attestations of v0.2.0's four tarballs, as GitHub's API answered
// on 2026-11-12 (unauthenticated `GET /repos/memtro-org/memtro-cli/attestations/sha256:<digest>?predicate_type=provenance`).
// They must verify offline under memtro's production policy, so the project's own identity (workflow path, tag ref,
// repository and owner ids, runner, trigger) is covered by the suite. Offline: the API answer is served from the file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkAttestation, memtroPolicy, verifyBundle } from "../src/update/attest/index.js";
import { FULCIO_OIDS, leafIdentity } from "../src/update/attest/policy.js";

/** SHA-256 of each tarball, from the release's checksums.txt (and latest.json), v0.2.0. */
const V020: Record<string, string> = {
  "darwin-arm64": "f27f8499beeee28708dd820a0dbb3ffe15de2afda780cedb9fd1c5734d378ced",
  "darwin-x64": "f71609a4605b58bdaf8166a04680b4b64c72b10ca97b2e903521f373d346522c",
  "linux-arm64": "906f56afd0a0fe6dcc27556cdec3d4f185ed318b2289854e019ebebd55b1361d",
  "linux-x64": "0b5f38c06ecd9028afaf8cf9d9b1358faeaa3d09a9af445dbc3a8669f304abbc",
};

const listing = (target: string): { attestations: Array<{ bundle: any; initiator: string }> } =>
  JSON.parse(readFileSync(new URL(`./fixtures/attest/memtro-cli-v0.2.0-${target}.attestations.json`, import.meta.url), "utf8"));

const flip = (hex: string): string => hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");

for (const [target, digest] of Object.entries(V020)) {
  test(`memtro v0.2.0 ${target}: the real attestation verifies under memtro's policy, and only for 0.2.0 and this digest`, async () => {
    const l = listing(target);
    assert.equal(l.attestations.length, 1);
    const bundle = l.attestations[0]!.bundle;
    assert.equal(bundle.mediaType, "application/vnd.dev.sigstore.bundle.v0.3+json");
    assert.deepEqual(verifyBundle(bundle, digest, memtroPolicy("0.2.0")), { status: "verified" });
    assert.equal(verifyBundle(bundle, digest, memtroPolicy("0.2.1")).status, "refused", "another version's tag");
    assert.equal(verifyBundle(bundle, flip(digest), memtroPolicy("0.2.0")).status, "refused", "another file");
    // The identity as the certificate carries it.
    const id = leafIdentity(Buffer.from(bundle.verificationMaterial.certificate.rawBytes, "base64"));
    assert.deepEqual(id.sans, ["https://github.com/memtro-org/memtro-cli/.github/workflows/release.yml@refs/tags/v0.2.0"]);
    assert.equal(id.fulcio.get(FULCIO_OIDS.trigger), "push");
    assert.equal(id.fulcio.get(FULCIO_OIDS.repositoryId), "1455158311");
    assert.equal(id.fulcio.get(FULCIO_OIDS.ownerId), "341420199");
    // Through the whole check, with the API answer served from the file.
    const served: typeof fetch = async (input) => {
      const u = new URL(String(input));
      assert.equal(u.pathname, `/repos/memtro-org/memtro-cli/attestations/sha256:${digest}`);
      return new Response(JSON.stringify(l), { status: 200, headers: { "content-type": "application/json" } });
    };
    const r = await checkAttestation({ digest, version: "0.2.0", env: {}, fetch: served, signal: new AbortController().signal });
    assert.deepEqual(r, { status: "verified" });
  });
}
