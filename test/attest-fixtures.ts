// Real GitHub build-provenance bundles, saved 2026-11-12 with `gh attestation verify`'s verdict on each, and helpers
// to tamper with them. Nothing here reaches the network. Sources: test/fixtures/attest/ (fetched unauthenticated from
// api.github.com; the asset digests were recomputed from the downloaded release files).
import { readFileSync } from "node:fs";
import type { IdentityPolicy } from "../src/update/attest/index.js";

const DIR = new URL("./fixtures/attest/", import.meta.url);

export interface Fixture {
  name: string;
  /** The release asset's SHA-256. */
  digest: string;
  /** `initiator: "user"`: the actions/attest provenance. */
  provenance: Bundle;
  /** `initiator: "github"`: GitHub's own release attestation, when the file has one. */
  release: Bundle | null;
  /** The identity gh reported for the provenance, as this verifier's policy. Taken from gh's output, not our parser. */
  policy: IdentityPolicy;
  /** gh's own verdict: the subjects of the statement it verified. */
  ghVerifiedDigests: string[];
}

// The bundle's JSON, deliberately loose: tests edit it.
export type Bundle = any;

const DIGESTS: Record<string, string> = {
  "jqlang-jq-jq-linux-arm64.jq-1.8.2": "8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309",
  "jqlang-jq-jq-linux-arm64.jq-1.8.1": "6bc62f25981328edd3cfcfe6fe51b073f2d7e7710d7ef7fcdac28d4e384fc3d4",
  "astral-sh-uv-uv-installer.sh.0.13.7": "d263ee68314cf5bea36b08e6bd9e2c4563240d7adb73756cf33af5c199b92db4",
  "cli-cli-gh_2.103.3_linux_arm64.tar.gz": "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63",
};

export const fixtureBytes = (file: string): Buffer => readFileSync(new URL(file, DIR));

export function fixture(name: keyof typeof DIGESTS | string): Fixture {
  const list = JSON.parse(fixtureBytes(`${name}.bundles.json`).toString("utf8")) as Array<{ initiator: string; bundle: Bundle }>;
  const gh = JSON.parse(fixtureBytes(`${name}.gh-verify.json`).toString("utf8")) as Array<{ verificationResult: Bundle }>;
  const vr = gh[0]!.verificationResult;
  const c = vr.signature.certificate;
  return {
    name,
    digest: DIGESTS[name]!,
    provenance: list.find((x) => x.initiator === "user")!.bundle,
    release: list.find((x) => x.initiator === "github")?.bundle ?? null,
    policy: {
      san: c.subjectAlternativeName,
      issuer: c.issuer,
      sourceRepositoryUri: c.sourceRepositoryURI,
      sourceRef: c.sourceRepositoryRef,
      repositoryId: Number(c.sourceRepositoryIdentifier),
      ownerId: Number(c.sourceRepositoryOwnerIdentifier),
      runnerEnvironment: c.runnerEnvironment,
    },
    ghVerifiedDigests: (vr.statement.subject as Array<{ digest: { sha256: string } }>).map((s) => s.digest.sha256),
  };
}

export const FIXTURES = Object.keys(DIGESTS);

export const clone = <T>(v: T): T => structuredClone(v);

/** Base64 text with one bit flipped near its end. */
export function flip(b64: string): string {
  const b = Buffer.from(b64, "base64");
  b[b.length - 3]! ^= 1;
  return b.toString("base64");
}

export const entry0 = (b: Bundle): Bundle => b.verificationMaterial.tlogEntries[0];
