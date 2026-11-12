import { Refused } from "./verdict.js";
import { extensions, fulcioUtf8, OID, subjectAltNames } from "./x509.js";

/**
 * Who must have signed: the certificate identity Fulcio wrote from the workflow's OIDC token. Every field is an
 * exact, case-sensitive match and every one is required; a certificate missing an extension fails, it is never a
 * pass (sigstore-js GHSA-52v5-jr5w-gjxr dropped constraints silently). Fulcio's extensions are described at
 * https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md; only the newer DER-encoded ones (.8 and later) are
 * read.
 */

export interface IdentityPolicy {
  /** The certificate's only SAN, a URI: the workflow file at the ref it ran from. */
  san: string;
  /** 1.3.6.1.4.1.57264.1.8, Issuer (V2). */
  issuer: string;
  /** .12, Source Repository URI. */
  sourceRepositoryUri: string;
  /** .14, Source Repository Ref. */
  sourceRef: string;
  /** .15, Source Repository Identifier: survives a rename, unlike the URI. */
  repositoryId: number;
  /** .17, Source Repository Owner Identifier. */
  ownerId: number;
  /** .11, Runner Environment. */
  runnerEnvironment: string;
  /** .20, Build Trigger: the event that started the run ("push" for a pushed tag). Checked when given. */
  trigger?: string;
}

const FULCIO = "1.3.6.1.4.1.57264.1.";
export const FULCIO_OIDS = {
  issuer: `${FULCIO}8`,
  runnerEnvironment: `${FULCIO}11`,
  sourceRepositoryUri: `${FULCIO}12`,
  sourceRef: `${FULCIO}14`,
  repositoryId: `${FULCIO}15`,
  ownerId: `${FULCIO}17`,
  trigger: `${FULCIO}20`,
} as const;

/** memtro-org/memtro-cli, confirmed with `gh api repos/memtro-org/memtro-cli --jq '.id, .owner.id'` on 2026-11-12. */
export const MEMTRO_REPOSITORY = { slug: "memtro-org/memtro-cli", repositoryId: 1455158311, ownerId: 341420199 } as const;

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

/** A tag-triggered GitHub-hosted workflow run in `slug`, at `refs/tags/<tag>`. */
export function tagPolicy(opts: { slug: string; workflow: string; ref: string; repositoryId: number; ownerId: number }): IdentityPolicy {
  return {
    san: `https://github.com/${opts.slug}/${opts.workflow}@${opts.ref}`,
    issuer: GITHUB_ACTIONS_ISSUER,
    sourceRepositoryUri: `https://github.com/${opts.slug}`,
    sourceRef: opts.ref,
    repositoryId: opts.repositoryId,
    ownerId: opts.ownerId,
    runnerEnvironment: "github-hosted",
    // release.yml publishes only from a pushed tag; a run started any other way (workflow_dispatch on a tag ref)
    // never attests, so a certificate saying otherwise is not one of ours.
    trigger: "push",
  };
}

/** The release workflow of this repository at the tag of the version being installed. */
export function memtroPolicy(version: string): IdentityPolicy {
  return tagPolicy({ ...MEMTRO_REPOSITORY, workflow: ".github/workflows/release.yml", ref: `refs/tags/v${version}` });
}

export interface Identity {
  /** Every SAN GeneralName: URIs as text, anything else as null. */
  sans: Array<string | null>;
  /** Fulcio extension text by OID; absent when the certificate does not carry it. */
  fulcio: Map<string, string>;
}

/** Reads the identity from the leaf's DER. A malformed extension throws (a refusal upstream). */
export function leafIdentity(der: Buffer): Identity {
  const ext = extensions(der);
  const sanExt = ext.get(OID.subjectAltName);
  const sans = sanExt
    ? subjectAltNames(sanExt).map((g) => {
        // uniformResourceIdentifier [6] IMPLICIT IA5String: ASCII only.
        if (g.tag !== 0x86 || g.value.some((b) => b > 0x7e || b < 0x20)) return null;
        return g.value.toString("ascii");
      })
    : [];
  const fulcio = new Map<string, string>();
  for (const oid of Object.values(FULCIO_OIDS)) {
    const e = ext.get(oid);
    if (e) fulcio.set(oid, fulcioUtf8(e));
  }
  return { sans, fulcio };
}

/** Throws Refused unless the identity is exactly the policy's. */
export function checkIdentity(id: Identity, policy: IdentityPolicy): void {
  const san = id.sans.length === 1 ? id.sans[0] : null;
  if (san === null || san === undefined) throw new Refused("the certificate does not carry exactly one URI identity");
  if (san !== policy.san) throw new Refused(`the certificate was issued to ${JSON.stringify(san.slice(0, 160))}, not ${policy.san}`);
  const want: Array<[keyof typeof FULCIO_OIDS, string]> = [
    ["issuer", policy.issuer],
    ["sourceRepositoryUri", policy.sourceRepositoryUri],
    ["sourceRef", policy.sourceRef],
    ["repositoryId", decimal(policy.repositoryId)],
    ["ownerId", decimal(policy.ownerId)],
    ["runnerEnvironment", policy.runnerEnvironment],
    ...(policy.trigger !== undefined ? [["trigger", policy.trigger] as [keyof typeof FULCIO_OIDS, string]] : []),
  ];
  for (const [name, expected] of want) {
    const got = id.fulcio.get(FULCIO_OIDS[name]);
    if (got === undefined) throw new Refused(`the certificate has no ${name} (${FULCIO_OIDS[name]})`);
    if (got !== expected) throw new Refused(`the certificate's ${name} is ${JSON.stringify(got.slice(0, 160))}, not ${JSON.stringify(expected)}`);
  }
}

function decimal(n: number): string {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`policy ids must be positive integers; got ${n}`);
  return String(n);
}
