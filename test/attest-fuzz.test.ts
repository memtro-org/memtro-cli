// Random mutation of the real bundles: whatever is changed, the verifier answers with a tier (never throws, never
// hangs) and never "verified". Seeded, so a failure reproduces. Offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyBundle } from "../src/update/attest/index.js";
import { extensions } from "../src/update/attest/x509.js";
import { leafIdentity } from "../src/update/attest/policy.js";
import { snappyDecode } from "../src/update/attest/snappy.js";
import { clone, FIXTURES, fixture, type Bundle } from "./attest-fixtures.js";

/** mulberry32: a small deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Path = Array<string | number>;
const B64_FIELDS: Path[] = [
  ["verificationMaterial", "certificate", "rawBytes"],
  ["dsseEnvelope", "payload"],
  ["dsseEnvelope", "signatures", 0, "sig"],
  ["verificationMaterial", "tlogEntries", 0, "canonicalizedBody"],
  ["verificationMaterial", "tlogEntries", 0, "inclusionPromise", "signedEntryTimestamp"],
  ["verificationMaterial", "tlogEntries", 0, "logId", "keyId"],
];

function at(o: any, p: Path): { parent: any; key: string | number } {
  let cur = o;
  for (const k of p.slice(0, -1)) cur = cur[k];
  return { parent: cur, key: p[p.length - 1]! };
}

/** One byte-level change to the decoded bytes of a base64 field. */
function mutateBytes(buf: Buffer, r: () => number): Buffer {
  const i = Math.floor(r() * Math.max(1, buf.length));
  switch (Math.floor(r() * 6)) {
    case 0: {
      const b = Buffer.from(buf);
      b[i] = (b[i]! ^ (1 << Math.floor(r() * 8))) & 0xff;
      return b;
    }
    case 1:
      return buf.subarray(0, i);
    case 2:
      return Buffer.concat([buf, Buffer.from([Math.floor(r() * 256)])]);
    case 3:
      return Buffer.concat([buf.subarray(0, i), Buffer.from([Math.floor(r() * 256)]), buf.subarray(i)]);
    case 4: {
      // A DER length byte made long-form, indefinite, or huge.
      const b = Buffer.from(buf);
      b[Math.min(i, b.length - 1)] = [0x80, 0x84, 0xff, 0x00][Math.floor(r() * 4)]!;
      return b;
    }
    default:
      return Buffer.concat([buf.subarray(0, i), buf.subarray(i + 1)]);
  }
}

function mutateJson(b: any, r: () => number): void {
  const choices: Path[] = [
    ["mediaType"],
    ["dsseEnvelope", "payloadType"],
    ["verificationMaterial", "tlogEntries", 0, "integratedTime"],
    ["verificationMaterial", "tlogEntries", 0, "logIndex"],
    ["verificationMaterial", "tlogEntries", 0, "kindVersion", "version"],
    ["verificationMaterial", "tlogEntries", 0, "inclusionPromise"],
    ["verificationMaterial", "certificate"],
    ["verificationMaterial", "tlogEntries"],
    ["dsseEnvelope", "signatures"],
  ];
  const { parent, key } = at(b, choices[Math.floor(r() * choices.length)]!);
  const replacements: unknown[] = [undefined, null, 0, "", "x", [], {}, "1".repeat(20), -1, 1e308];
  const v = replacements[Math.floor(r() * replacements.length)];
  if (v === undefined) delete parent[key];
  else parent[key] = v;
}

test("fuzz: 300 random mutations of each real bundle are each a tier, never verified, never an exception", () => {
  for (const name of FIXTURES) {
    const f = fixture(name);
    const original = JSON.stringify(f.provenance);
    // The unmutated bundle verifies: the mutations below are what make the difference.
    assert.equal(verifyBundle(f.provenance, f.digest, f.policy).status, "verified", name);
    const r = rng(0x5eed + name.length);
    let tiers = { refused: 0, unknown: 0 };
    for (let i = 0; i < 300; i++) {
      const b: Bundle = clone(f.provenance);
      if (r() < 0.75) {
        const { parent, key } = at(b, B64_FIELDS[Math.floor(r() * B64_FIELDS.length)]!);
        parent[key] = mutateBytes(Buffer.from(parent[key], "base64"), r).toString("base64");
      } else mutateJson(b, r);
      if (JSON.stringify(b) === original) continue;
      const started = Date.now();
      let v;
      assert.doesNotThrow(() => (v = verifyBundle(b, f.digest, f.policy)), `${name} #${i}`);
      assert.ok(Date.now() - started < 2000, `${name} #${i} took too long`);
      assert.notEqual(v!.status, "verified", `${name} #${i}: a mutated bundle verified`);
      tiers[v!.status as "refused" | "unknown"]++;
    }
    assert.ok(tiers.refused > 200, `${name}: most mutations of the known form are refused (${JSON.stringify(tiers)})`);
  }
});

test("fuzz: the DER walker and identity reader on mutated leaves only ever throw their own errors", () => {
  const leaf = Buffer.from(fixture(FIXTURES[0]!).provenance.verificationMaterial.certificate.rawBytes, "base64");
  const r = rng(42);
  // Truncated at every offset.
  for (let n = 0; n < leaf.length; n++) {
    try {
      leafIdentity(leaf.subarray(0, n));
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  }
  // Deep nesting and huge declared lengths.
  const nested = Buffer.concat([Buffer.alloc(20000, 0x30).map((_, i) => (i % 2 ? 0x80 : 0x30)), Buffer.alloc(2)]);
  assert.throws(() => extensions(nested));
  assert.throws(() => extensions(Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff])));
  assert.throws(() => extensions(Buffer.from([0x30, 0x80, 0x00, 0x00])), /length/);
  for (let i = 0; i < 2000; i++) {
    const m = mutateBytes(leaf, r);
    try {
      leafIdentity(m);
    } catch (err) {
      assert.ok(err instanceof Error, `#${i}`);
    }
  }
});

test("fuzz: Snappy on random and hostile input throws or returns within its cap", () => {
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(r() * 64);
    const b = Buffer.alloc(n);
    for (let j = 0; j < n; j++) b[j] = Math.floor(r() * 256);
    try {
      const out = snappyDecode(b, 4096);
      assert.ok(out.length <= 4096);
    } catch (err) {
      assert.ok(err instanceof Error);
    }
  }
  // A five-byte length header claiming 34 GB, and a literal claiming 4 GB.
  assert.throws(() => snappyDecode(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7f]), 1 << 20), /more than allowed/);
  assert.throws(() => snappyDecode(Buffer.from([0x10, 0xfc, 0xff, 0xff, 0xff, 0xff]), 1 << 20), /overruns/);
});
