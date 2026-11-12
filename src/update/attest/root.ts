import { createHash, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import { TRUSTED_ROOT_JSON } from "./root-data.js";
import { Refused, Unjudgeable } from "./verdict.js";
import { authorityKeyId, extensions, OID, subjectKeyId } from "./x509.js";

/**
 * The embedded Sigstore trusted root (root-data.ts), parsed once into what the verifier needs: the transparency
 * logs' keys by key id, and the certificate authorities' chains with the key identifier a leaf names them by.
 * A root that does not parse is a programming error (the test of root-data.ts catches it), so this throws.
 */

export interface Window {
  start: number;
  /** null: still valid. */
  end: number | null;
}

export interface TrustedLog {
  baseUrl: string;
  keyId: Buffer;
  keyDetails: string;
  key: KeyObject;
  validFor: Window;
}

export interface TrustedCa {
  /** Issuing certificate first, the self-signed root last. */
  chain: X509Certificate[];
  /** The issuing certificate's SubjectKeyIdentifier: a leaf's AuthorityKeyIdentifier must name it. */
  issuerKeyId: Buffer;
  validFor: Window;
}

export interface TrustedRoot {
  tlogs: TrustedLog[];
  cas: TrustedCa[];
}

export const inWindow = (t: number, w: Window): boolean => t >= w.start && (w.end === null || t <= w.end);

function bad(why: string): never {
  throw new Error(`the embedded trusted root is malformed: ${why}`);
}

function windowOf(v: unknown): Window {
  const w = v as { start?: unknown; end?: unknown } | undefined;
  const start = typeof w?.start === "string" ? Date.parse(w.start) : NaN;
  const end = w?.end === undefined ? null : typeof w.end === "string" ? Date.parse(w.end) : NaN;
  if (Number.isNaN(start) || (end !== null && Number.isNaN(end))) bad("a validFor window");
  return { start, end };
}

function field(v: unknown, key: string): unknown {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
}

function text64(v: unknown): string {
  if (typeof v !== "string" || !v) bad("a text field");
  return v as string;
}

export function parseTrustedRoot(text: string): TrustedRoot {
  const raw = JSON.parse(text) as { mediaType?: unknown; tlogs?: unknown; certificateAuthorities?: unknown };
  if (raw.mediaType !== "application/vnd.dev.sigstore.trustedroot+json;version=0.1") bad("media type");
  if (!Array.isArray(raw.tlogs) || !Array.isArray(raw.certificateAuthorities)) bad("lists");
  const tlogs = (raw.tlogs as unknown[]).map((t): TrustedLog => {
    const pk = field(t, "publicKey");
    const spki = Buffer.from(text64(field(pk, "rawBytes")), "base64");
    const keyId = Buffer.from(text64(field(field(t, "logId"), "keyId")), "base64");
    if (keyId.length !== 32 || spki.length === 0) bad("a log key");
    return {
      baseUrl: text64(field(t, "baseUrl")),
      keyId,
      keyDetails: text64(field(pk, "keyDetails")),
      key: createPublicKey({ key: spki, format: "der", type: "spki" }),
      validFor: windowOf(field(pk, "validFor")),
    };
  });
  const cas = (raw.certificateAuthorities as unknown[]).map((c): TrustedCa => {
    const certs = field(field(c, "certChain"), "certificates");
    if (!Array.isArray(certs) || certs.length === 0) bad("a certificate chain");
    const ders = (certs as unknown[]).map((x) => Buffer.from(text64(field(x, "rawBytes")), "base64"));
    const ski = extensions(ders[0]!).get(OID.subjectKeyIdentifier);
    if (!ski) bad("an issuing certificate without a SubjectKeyIdentifier");
    return { chain: ders.map((d) => new X509Certificate(d)), issuerKeyId: subjectKeyId(ski!), validFor: windowOf(field(c, "validFor")) };
  });
  return { tlogs, cas };
}

let cached: TrustedRoot | null = null;
export function embeddedRoot(): TrustedRoot {
  if (!cached) {
    const root = parseTrustedRoot(TRUSTED_ROOT_JSON);
    // Read-only from here on: the lists cannot be pushed to or edited by anything else in the process.
    for (const t of root.tlogs) Object.freeze(t.validFor), Object.freeze(t);
    for (const c of root.cas) Object.freeze(c.validFor), Object.freeze(c.chain), Object.freeze(c);
    Object.freeze(root.tlogs);
    Object.freeze(root.cas);
    cached = Object.freeze(root);
  }
  return cached;
}

export const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

const CODE_SIGNING = "1.3.6.1.5.5.7.3.3";

/**
 * The leaf chains to a Fulcio CA of the embedded root that was valid at `timeMs` (the authenticated signing time),
 * every certificate on the path valid at that time too (cosign GHSA-wfqv-66vq-46rm: issuers are checked at the
 * signing time, not today). The leaf names its issuer by AuthorityKeyIdentifier: an identifier no CA in the root
 * has is a CA this build does not know (a rotation), which is Unjudgeable; a known CA that does not vouch for the
 * leaf is a refusal.
 */
export function checkChain(leaf: X509Certificate, leafDer: Buffer, root: TrustedRoot, timeMs: number): void {
  const akiExt = extensions(leafDer).get(OID.authorityKeyIdentifier);
  if (!akiExt) throw new Refused("the leaf certificate does not name its issuer's key");
  const aki = authorityKeyId(akiExt);
  if (!aki) throw new Refused("the leaf certificate does not name its issuer's key");
  const candidates = root.cas.filter((ca) => ca.issuerKeyId.equals(aki));
  if (candidates.length === 0) throw new Unjudgeable("its certificate was issued by a certificate authority the embedded trusted root does not know");

  if (leaf.ca) throw new Refused("the leaf certificate is a CA certificate");
  if (!(leaf.keyUsage ?? []).includes(CODE_SIGNING)) throw new Refused("the leaf certificate is not for code signing");
  const key = leaf.publicKey;
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Refused("the leaf certificate's key is not ECDSA P-256");

  let why = "";
  for (const ca of candidates) {
    if (!inWindow(timeMs, ca.validFor)) {
      why = "the certificate authority was not trusted at the signing time";
      continue;
    }
    const path = [leaf, ...ca.chain];
    const validAt = (c: X509Certificate): boolean => timeMs >= c.validFromDate.getTime() && timeMs <= c.validToDate.getTime();
    let ok = path.every(validAt);
    if (!ok) why = "a certificate on the path was not valid at the signing time";
    for (let i = 0; ok && i < path.length - 1; i++) {
      if (!path[i]!.checkIssued(path[i + 1]!) || !path[i]!.verify(path[i + 1]!.publicKey)) {
        ok = false;
        why = "the leaf certificate does not chain to the trusted certificate authority";
      }
    }
    const top = path[path.length - 1]!;
    if (ok && !top.verify(top.publicKey)) {
      ok = false;
      why = "the trusted root certificate is not self-signed";
    }
    if (ok && !ca.chain.every((c) => c.ca)) {
      ok = false;
      why = "an issuing certificate is not a CA";
    }
    if (ok) return;
  }
  throw new Refused(why);
}
