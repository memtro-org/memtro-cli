import { X509Certificate } from "node:crypto";
import { attestationSource } from "../net.js";
import { parseBundle } from "./bundle.js";
import { verifyDsse } from "./dsse.js";
import { fetchBundle, listAttestations } from "./fetch.js";
import { checkIdentity, leafIdentity, memtroPolicy, type IdentityPolicy } from "./policy.js";
import { checkTlogEntry } from "./rekor.js";
import { checkChain, embeddedRoot, type TrustedRoot } from "./root.js";
import { arr, isObject, parseJsonObject, Refused, Unjudgeable } from "./verdict.js";

/**
 * Verifies the GitHub build-provenance attestation of a release tarball, in process, against the Sigstore trusted
 * root embedded in this build (root-data.ts). Specification: the facts file of 2026-11-12 (attest-facts.md, kept with
 * the change that added this) and the Sigstore client spec, https://github.com/sigstore/architecture-docs.
 *
 * Three answers. VERIFIED: one provenance attestation for exactly this digest passes every check below. REFUSED:
 * the update must not happen. UNCHECKED: the attestation could not be judged; the update proceeds on the checksum
 * and says so. UNCHECKED exists because Sigstore's keys rotate a few times a year and an embedded root must never
 * be able to strand every installed copy; it is not available for anything that is checkable and wrong.
 *
 * The boundary, branch by branch. Who can cause what: somebody who replaced the release files (the tarball and
 * checksums.txt on the release, a CDN or a mirror) cannot create attestations in this repository, and cannot alter
 * what api.github.com answers over TLS. So "GitHub says there is none" is that attacker's signature, and REFUSED.
 *
 * | Branch                                                                      | Tier       | Why |
 * |-----------------------------------------------------------------------------|------------|-----|
 * | API: network error, DNS, connection refused                                 | unchecked  | GitHub unreachable; says nothing about the file |
 * | API: no answer within the time limit                                        | unchecked  | as above |
 * | API: 403 or 429 (rate limit: 60 an hour per address, unauthenticated)       | unchecked  | a shared NAT can exhaust it |
 * | API: 5xx                                                                    | unchecked  | GitHub's outage |
 * | API: any other non-200 (410 = API version retired, 3xx, 400…)               | unchecked  | the API changed under this build; not attacker-reachable over TLS |
 * | API: 200 that is not JSON, or has no `attestations` list, or is too large   | unchecked  | as above |
 * | API: a `Link: next` off api.github.com/this repository's path               | unchecked  | not followed |
 * | API: 404 on the first page, or 200 with an empty list                       | REFUSED    | GitHub has no provenance for this digest; release.yml always attests, so the file is not ours |
 * | More pages than this build reads and nothing verified in them              | unchecked  | cannot see them all |
 * | Attestation with neither inline `bundle` nor a usable `bundle_url`          | unchecked  | form unknown |
 * | `bundle_url` off the storage host, unreachable, non-200, too big, bad Snappy or JSON | unchecked | transport, not content (the inline bundle is used when present) |
 * | Bundle: no media type, or one other than v0.3                               | unchecked  | a form this build does not read |
 * | Bundle v0.3: any required field missing, wrong type, bad base64, bad DER    | REFUSED    | claims the known form and is malformed |
 * | Bundle v0.3: carries x509CertificateChain or a bare publicKey, or a messageSignature | REFUSED | not the form v0.3 keyless DSSE takes; no fallback path |
 * | Envelope: payload type not in-toto, or not exactly one signature           | REFUSED    | client spec 4.4/4.5 |
 * | Envelope signature does not verify under the leaf's own key                | REFUSED    | checked first, before any branch below can say "unknown" |
 * | Leaf issued by "O=GitHub, Inc." (GitHub's private instance)                | unchecked  | RFC 3161 time only; this build does not check it |
 * | Statement or identity wrong (read from the leaf, before the log and CA)    | REFUSED    | wrong whoever issued it; checked before the log/CA rows can say "unknown" |
 * | No tlog entry, RFC 3161 timestamp present                                  | unchecked  | as above |
 * | No tlog entry and no timestamp                                             | REFUSED    | no signing time at all |
 * | Tlog entry: kind/version not dsse 0.0.1 (e.g. Rekor v2's dsse 0.0.2)        | unchecked  | form unknown |
 * | Tlog entry: no inclusionPromise (no SET)                                   | unchecked  | Rekor v2 has none; no authenticated time |
 * | Tlog entry: log key id not in the embedded root, or not an ECDSA P-256 key | unchecked  | a rotated or new log |
 * | Tlog entry: SET does not verify (incl. integratedTime/logIndex/body edited) | REFUSED   | checkable and wrong |
 * | Tlog entry: log key not valid at integratedTime                            | REFUSED    | checkable and wrong |
 * | Tlog body: other kind, other signature, other certificate, other payload hash | REFUSED | entry is not for this envelope |
 * | Any tlog entry refused, even if another verified                           | REFUSED    | strict: every judged entry must pass |
 * | Leaf's AuthorityKeyIdentifier names no CA in the embedded root             | unchecked  | a rotated Fulcio intermediate |
 * | Leaf missing its AuthorityKeyIdentifier                                    | REFUSED    | every Fulcio leaf carries one |
 * | Known CA: not valid at the signing time, path invalid at it, bad signature, not CA, leaf is CA, no codeSigning EKU, not P-256 | REFUSED | checkable and wrong |
 * | DSSE signature over the PAE does not verify with the leaf key              | REFUSED    | |
 * | Identity: SAN, issuer, repository URI, ref, repository id, owner id, runner differ or are missing | REFUSED | |
 * | Statement: not in-toto v1, not SLSA provenance v1, digest not among subjects | REFUSED  | |
 * | Any other exception after the media type was recognised                    | REFUSED    | a malformed known form |
 * | Several attestations: one VERIFIED                                          | verified   | at least one for exactly this digest |
 * | Several: none verified, at least one REFUSED                                | REFUSED    | stricter than "every one refused": an understood failure is never outvoted by an unknown |
 * | Several: every one unchecked                                                | unchecked  | |
 *
 * The residual risk of the UNCHECKED tier: anybody who can both replace the release files and either block
 * api.github.com for the victim, or store an attestation in this repository (a workflow with `attestations: write`)
 * in a form this build does not know, gets an update that is checked by its checksum alone, and says so.
 *
 * Not checked (the facts' "may be skipped" list): the certificate's embedded SCT (residual: a Fulcio certificate that
 * was mis-issued and never logged to Certificate Transparency would be accepted; the reference clients require
 * one), and the Merkle inclusion proof with its signed checkpoint (residual: a Rekor that signs an entry timestamp
 * but never actually includes the entry in its log would go unnoticed; without witnesses that check is weak anyway).
 * Revocation is unknowable offline.
 */

export type AttestationResult = { status: "verified" } | { status: "refused"; reason: string } | { status: "unchecked"; reason: string };
export type BundleVerdict = { status: "verified" } | { status: "refused"; reason: string } | { status: "unknown"; reason: string };

export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";

/** The statement is SLSA provenance v1 and names exactly this digest among its subjects. */
function checkStatement(payload: Buffer, digestHex: string): void {
  const st = parseJsonObject(payload, "the in-toto statement");
  if (st._type !== IN_TOTO_STATEMENT_V1) throw new Refused("the payload is not an in-toto v1 statement");
  if (st.predicateType !== SLSA_PROVENANCE_V1) throw new Refused("the attestation is not SLSA build provenance");
  const subjects = arr(st.subject, "the statement's subjects", 4096);
  const named = subjects.some((s) => {
    if (!isObject(s) || !isObject(s.digest)) return false;
    const d = s.digest.sha256;
    return typeof d === "string" && /^[0-9a-fA-F]{64}$/.test(d) && d.toLowerCase() === digestHex;
  });
  if (!named) throw new Refused("the attestation does not name this download's digest");
}

// Node escapes the comma in a distinguished name: "O=GitHub\\, Inc.\nCN=Fulcio Intermediate l1".
const GITHUB_INSTANCE_ISSUER = /(^|\n)O=GitHub\\?, Inc\.(\n|$)/;

/** One bundle against one digest, policy and root. Pure: the time is the bundle's own, never the clock. */
export function verifyBundle(raw: unknown, digestHex: string, policy: IdentityPolicy, root: TrustedRoot = embeddedRoot()): BundleVerdict {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new Error("verifyBundle wants a lowercase hex SHA-256");
  try {
    const bundle = parseBundle(raw);
    let leaf: X509Certificate;
    try {
      leaf = new X509Certificate(bundle.leafDer);
    } catch {
      throw new Refused("the leaf certificate does not parse");
    }
    // First what needs no trust anchor: the envelope's signature under the leaf's own key, the statement, and the
    // identity the leaf claims. A bundle that fails any of these is wrong whoever issued it, so it is refused even
    // when the log or the certificate authority below turns out to be one this build does not know: "unknown" is
    // only ever "a correct-looking bundle signed by keys this build cannot vouch for", never a cover for a bad one.
    if (!verifyDsse(bundle.payloadType, bundle.payload, bundle.signature, leaf.publicKey)) throw new Refused("the envelope's signature does not verify");
    // GitHub's own instance (its release attestations; private repositories) is judged no further: its identity and
    // statement follow other rules, and its time is an RFC 3161 token this build does not read.
    if (GITHUB_INSTANCE_ISSUER.test(leaf.issuer)) throw new Unjudgeable("it was signed by GitHub's own Sigstore instance, which this build does not check");
    checkStatement(bundle.payload, digestHex);
    checkIdentity(leafIdentity(bundle.leafDer), policy);

    if (bundle.tlogEntries.length === 0) {
      if (bundle.hasSignedTimestamps) throw new Unjudgeable("it carries only an RFC 3161 timestamp, which this build does not check");
      throw new Refused("the bundle has no transparency log entry and no timestamp");
    }
    // Every entry this build can judge must pass; the signing time is the first verified entry's.
    let timeMs: number | null = null;
    let unknown: Unjudgeable | null = null;
    for (const entry of bundle.tlogEntries) {
      try {
        const t = checkTlogEntry(entry, bundle, root);
        timeMs ??= t;
      } catch (err) {
        if (err instanceof Unjudgeable) unknown ??= err;
        else throw err;
      }
    }
    if (timeMs === null) throw unknown ?? new Refused("no transparency log entry");

    // Now that the time is authenticated: the leaf chains to a trusted CA at it. The checks above stand.
    checkChain(leaf, bundle.leafDer, root, timeMs);
    return { status: "verified" };
  } catch (err) {
    if (err instanceof Unjudgeable) return { status: "unknown", reason: err.message };
    if (err instanceof Refused) return { status: "refused", reason: err.message };
    // Anything else (a DER walk, a key that does not load) happened after the media type claimed the known form.
    return { status: "refused", reason: `the bundle is malformed (${err instanceof Error ? err.message.slice(0, 120) : "unknown error"})` };
  }
}

/** Several verdicts into one answer; see the last rows of the table above. */
export function judge(verdicts: BundleVerdict[], opts: { truncated?: boolean } = {}): AttestationResult {
  if (verdicts.some((v) => v.status === "verified")) return { status: "verified" };
  const refused = verdicts.find((v): v is Extract<BundleVerdict, { status: "refused" }> => v.status === "refused");
  if (refused) return { status: "refused", reason: `its build attestation failed a check: ${refused.reason}` };
  if (verdicts.length === 0) return { status: "refused", reason: "GitHub has no build attestation for this download, so it was not built by memtro's release workflow" };
  if (opts.truncated) return { status: "unchecked", reason: "there were more attestations than this build reads" };
  const first = verdicts[0] as Extract<BundleVerdict, { status: "unknown" }>;
  return { status: "unchecked", reason: `this build cannot judge its attestation: ${first.reason}` };
}

export interface AttestationRequest {
  /** The tarball's SHA-256, lowercase hex. */
  digest: string;
  /** The version being installed; the identity policy names its tag. */
  version: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  /** The update's signal: aborting it rejects (the update was cancelled), it is never "unchecked". */
  signal: AbortSignal;
}

export type AttestationVerifier = (req: AttestationRequest) => Promise<AttestationResult>;

const ATTEST_TIMEOUT_MS = 20_000;

/** Fetches and judges. Rejects only when `req.signal` is aborted; every other failure is a result. */
export async function checkAttestation(req: AttestationRequest, opts: { policy?: IdentityPolicy; root?: TrustedRoot; timeoutMs?: number } = {}): Promise<AttestationResult> {
  const digest = req.digest.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) return { status: "refused", reason: "the download's digest is not a SHA-256" };
  const policy = opts.policy ?? memtroPolicy(req.version);
  const root = opts.root ?? embeddedRoot();
  const source = attestationSource(req.env);
  const bounded = AbortSignal.any([req.signal, AbortSignal.timeout(opts.timeoutMs ?? ATTEST_TIMEOUT_MS)]);

  const listing = await listAttestations(req.fetch, source, digest, req.signal, bounded);
  if (listing.kind === "unavailable") return { status: "unchecked", reason: listing.detail };
  if (listing.kind === "none") return judge([]);

  const verdicts: BundleVerdict[] = [];
  for (const entry of listing.entries) {
    if (req.signal.aborted) throw req.signal.reason;
    let raw: unknown;
    if (isObject(entry) && isObject(entry.bundle)) raw = entry.bundle;
    else if (isObject(entry) && typeof entry.bundle_url === "string") {
      const got = await fetchBundle(req.fetch, source, entry.bundle_url, req.signal, bounded);
      if (!got.ok) {
        verdicts.push({ status: "unknown", reason: got.detail });
        continue;
      }
      raw = got.bundle;
    } else {
      verdicts.push({ status: "unknown", reason: "an attestation came with no bundle" });
      continue;
    }
    const v = verifyBundle(raw, digest, policy, root);
    if (v.status === "verified") return v;
    verdicts.push(v);
  }
  return judge(verdicts, { truncated: listing.truncated });
}

// Re-exported for the tests and for anybody reading this module first.
export { memtroPolicy, tagPolicy, MEMTRO_REPOSITORY, type IdentityPolicy } from "./policy.js";
export { embeddedRoot, parseTrustedRoot, type TrustedRoot } from "./root.js";
