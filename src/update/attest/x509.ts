/**
 * The little of DER that Node's X509Certificate does not expose: a certificate's extensions by OID (Fulcio's identity
 * extensions, the SAN's URIs, the key identifiers). Every length is checked against its parent; anything that does
 * not parse is a `DerError`, which the verifier turns into a refusal (the input claimed to be a certificate).
 */

export class DerError extends Error {}

interface Tlv {
  tag: number;
  /** Start of the value. */
  vs: number;
  /** End of the value (exclusive). */
  end: number;
  start: number;
}

/** One TLV at `pos`, which must end at or before `limit`. */
function tlv(buf: Buffer, pos: number, limit: number): Tlv {
  if (pos + 2 > limit) throw new DerError("truncated DER header");
  const tag = buf[pos]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("high-tag-number DER form");
  let len = buf[pos + 1]!;
  let hl = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new DerError("unsupported DER length");
    if (pos + 2 + n > limit) throw new DerError("truncated DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i]!;
    if (len < 128) throw new DerError("non-minimal DER length");
    hl = 2 + n;
  }
  const end = pos + hl + len;
  if (end > limit) throw new DerError("DER value overruns its container");
  return { tag, vs: pos + hl, end, start: pos };
}

function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = parent.vs; p < parent.end; ) {
    const k = tlv(buf, p, parent.end);
    out.push(k);
    p = k.end;
  }
  return out;
}

function expectTag(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (!t || t.tag !== tag) throw new DerError(`expected ${what}`);
  return t;
}

export function oidString(bytes: Buffer): string {
  if (bytes.length === 0 || bytes.length > 64) throw new DerError("bad OID length");
  const arcs: number[] = [];
  let v = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (v === 0 && b === 0x80) throw new DerError("non-minimal OID");
    v = v * 128 + (b & 0x7f);
    if (v > Number.MAX_SAFE_INTEGER / 256) throw new DerError("OID arc too large");
    if (!(b & 0x80)) {
      arcs.push(v);
      v = 0;
    } else if (i === bytes.length - 1) throw new DerError("truncated OID");
  }
  const first = arcs.shift()!;
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...arcs].join(".");
}

export interface Extension {
  critical: boolean;
  /** The extnValue OCTET STRING's contents. */
  value: Buffer;
}

/** The certificate's extensions by OID. A duplicated OID is an error (RFC 5280 4.2: "MUST NOT include more than one"). */
export function extensions(der: Buffer): Map<string, Extension> {
  const cert = expectTag(tlv(der, 0, der.length), 0x30, "a certificate SEQUENCE");
  if (cert.end !== der.length) throw new DerError("trailing bytes after the certificate");
  const tbs = expectTag(children(der, cert)[0], 0x30, "a TBSCertificate SEQUENCE");
  const wrap = children(der, tbs).find((k) => k.tag === 0xa3);
  const out = new Map<string, Extension>();
  if (!wrap) return out;
  const parts = children(der, wrap);
  if (parts.length !== 1) throw new DerError("malformed extensions wrapper");
  const seq = expectTag(parts[0], 0x30, "an Extensions SEQUENCE");
  for (const e of children(der, seq)) {
    expectTag(e, 0x30, "an Extension SEQUENCE");
    const p = children(der, e);
    const oid = oidString(der.subarray(expectTag(p[0], 0x06, "an OID").vs, p[0]!.end));
    let critical = false;
    let octet: Tlv | undefined;
    if (p.length === 3) {
      const b = expectTag(p[1], 0x01, "a BOOLEAN");
      if (b.end - b.vs !== 1) throw new DerError("bad BOOLEAN");
      critical = der[b.vs] === 0xff;
      octet = p[2];
    } else if (p.length === 2) octet = p[1];
    else throw new DerError("malformed Extension");
    expectTag(octet, 0x04, "an OCTET STRING");
    if (out.has(oid)) throw new DerError(`extension ${oid} appears twice`);
    out.set(oid, { critical, value: der.subarray(octet!.vs, octet!.end) });
  }
  return out;
}

export const OID = {
  subjectAltName: "2.5.29.17",
  authorityKeyIdentifier: "2.5.29.35",
  subjectKeyIdentifier: "2.5.29.14",
} as const;

/** A whole-value DER element of `tag` (the value must be exactly one TLV). */
function single(value: Buffer, tag: number, what: string): Buffer {
  const t = expectTag(tlv(value, 0, value.length), tag, what);
  if (t.end !== value.length) throw new DerError(`trailing bytes after ${what}`);
  return value.subarray(t.vs, t.end);
}

/** Every GeneralName in a SubjectAltName, as [tag, bytes]. */
export function subjectAltNames(ext: Extension): Array<{ tag: number; value: Buffer }> {
  const v = ext.value;
  const seq = expectTag(tlv(v, 0, v.length), 0x30, "a GeneralNames SEQUENCE");
  if (seq.end !== v.length) throw new DerError("trailing bytes after GeneralNames");
  return children(v, seq).map((k) => ({ tag: k.tag, value: v.subarray(k.vs, k.end) }));
}

/** AuthorityKeyIdentifier's keyIdentifier ([0] IMPLICIT OCTET STRING), or null when it has none. */
export function authorityKeyId(ext: Extension): Buffer | null {
  const v = ext.value;
  const seq = expectTag(tlv(v, 0, v.length), 0x30, "an AuthorityKeyIdentifier SEQUENCE");
  if (seq.end !== v.length) throw new DerError("trailing bytes after AuthorityKeyIdentifier");
  const id = children(v, seq).find((k) => k.tag === 0x80);
  return id ? v.subarray(id.vs, id.end) : null;
}

export function subjectKeyId(ext: Extension): Buffer {
  return single(ext.value, 0x04, "a SubjectKeyIdentifier OCTET STRING");
}

/**
 * A Fulcio extension's text (https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md): 1.3.6.1.4.1.57264.1.8
 * and later are a DER UTF8String, which must span the whole value. The older .1 to .6 are raw bytes; this verifier
 * reads only the newer ones.
 */
export function fulcioUtf8(ext: Extension): string {
  const bytes = single(ext.value, 0x0c, "a UTF8String");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new DerError("invalid UTF-8 in a Fulcio extension");
  return text;
}
