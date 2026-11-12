import { IN_TOTO_PAYLOAD_TYPE } from "./dsse.js";
import { arr, b64, isObject, obj, refuse, str, Unjudgeable, type Json } from "./verdict.js";

/**
 * A Sigstore bundle (https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto, as proto3
 * JSON), read into the one shape this verifier judges: v0.3, a single Fulcio leaf certificate, a DSSE envelope with
 * one signature over an in-toto statement. The media type decides whether the bundle claims that form at all; once
 * it does, anything missing or malformed is a refusal, never "unknown".
 */

/** Both spellings of bundle v0.3 that the proto lists. Every bundle GitHub emitted when this was written is the first. */
export const KNOWN_MEDIA_TYPES: ReadonlySet<string> = new Set(["application/vnd.dev.sigstore.bundle.v0.3+json", "application/vnd.dev.sigstore.bundle+json;version=0.3"]);

export interface Bundle {
  leafDer: Buffer;
  payloadType: string;
  payload: Buffer;
  signature: Buffer;
  /** Raw entries; rekor.ts reads each. */
  tlogEntries: Json[];
  /** RFC 3161 timestamps are present (which this build does not check). */
  hasSignedTimestamps: boolean;
}

/** A short, printable rendering of something a bundle said, for a reason line. */
export const quote = (v: unknown): string => JSON.stringify(typeof v === "string" ? v.slice(0, 60) : typeof v).replace(/[^\x20-\x7e]/g, "?");

export function parseBundle(raw: unknown): Bundle {
  if (!isObject(raw) || typeof raw.mediaType !== "string") throw new Unjudgeable("a bundle with no media type");
  if (!KNOWN_MEDIA_TYPES.has(raw.mediaType)) throw new Unjudgeable(`a bundle of media type ${quote(raw.mediaType)}, which this build does not read`);

  const vm = obj(raw.verificationMaterial, "verificationMaterial");
  // v0.3 carries exactly the leaf. A chain (v0.1/0.2 only) or a bare public key beside or instead of it is not the
  // form this verifier reads, and there is no fallback to another path (cosign GHSA-fx35-mq7g-6g98).
  if (vm.x509CertificateChain !== undefined) refuse("a v0.3 bundle carries a certificate chain, which only v0.1 and v0.2 may");
  if (vm.publicKey !== undefined) refuse("the bundle is signed with a bare key, not a Fulcio certificate");
  const leafDer = b64(obj(vm.certificate, "verificationMaterial.certificate").rawBytes, "the leaf certificate", 64, 16 * 1024);

  if (raw.messageSignature !== undefined) refuse("the bundle signs a message, not a DSSE envelope");
  const env = obj(raw.dsseEnvelope, "dsseEnvelope");
  const payloadType = str(env.payloadType, "dsseEnvelope.payloadType", 256);
  if (payloadType !== IN_TOTO_PAYLOAD_TYPE) refuse(`the envelope's payload type is ${quote(payloadType)}, not in-toto`);
  const payload = b64(env.payload, "dsseEnvelope.payload", 2, 4 * 1024 * 1024);
  const sigs = arr(env.signatures, "dsseEnvelope.signatures", 8);
  if (sigs.length !== 1) refuse(`the envelope has ${sigs.length} signatures, not exactly one`);
  const signature = b64(obj(sigs[0], "the envelope's signature").sig, "the envelope's signature", 8, 512);

  const tlogEntries = vm.tlogEntries === undefined ? [] : arr(vm.tlogEntries, "verificationMaterial.tlogEntries", 8);
  let hasSignedTimestamps = false;
  if (vm.timestampVerificationData !== undefined) {
    const tvd = obj(vm.timestampVerificationData, "timestampVerificationData");
    if (tvd.rfc3161Timestamps !== undefined) hasSignedTimestamps = arr(tvd.rfc3161Timestamps, "rfc3161Timestamps", 8).length > 0;
  }
  return { leafDer, payloadType, payload, signature, tlogEntries, hasSignedTimestamps };
}
