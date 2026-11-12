import { verify, type KeyObject } from "node:crypto";

/**
 * DSSE (https://github.com/secure-systems-lab/dsse/blob/master/protocol.md): the signature is over the
 * pre-authentication encoding, `"DSSEv1" SP LEN(type) SP type SP LEN(body) SP body`, LEN the ASCII decimal byte
 * length. Byte lengths of the UTF-8 encoding, never string lengths (sigstore-js GHSA-jfc7-64v2-mr8c used latin1).
 */

export const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";

export function pae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, "ascii"), type, Buffer.from(` ${payload.length} `, "ascii"), payload]);
}

/** ECDSA P-256 / SHA-256, DER-encoded signature (what Fulcio-keyed signers produce). */
export function verifyDsse(payloadType: string, payload: Buffer, signature: Buffer, key: KeyObject): boolean {
  try {
    return verify("sha256", pae(payloadType, payload), key, signature);
  } catch {
    return false;
  }
}
