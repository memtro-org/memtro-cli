import { verify } from "node:crypto";
import { quote, type Bundle } from "./bundle.js";
import { inWindow, sha256, type TrustedRoot } from "./root.js";
import { arr, b64, int64, obj, parseJsonObject, refuse, str, Unjudgeable, type Json } from "./verdict.js";

/**
 * One Rekor v1 transparency-log entry: its signed entry timestamp (the only thing that authenticates
 * `integratedTime`, which is the signing time everything else is judged at), and the binding of the logged body to
 * this envelope and this certificate (without it any valid log entry would do: cosign GHSA-whqx-f9j3-ch6m).
 *
 * The Merkle inclusion proof and the signed checkpoint are not checked; see the residual risks in index.ts.
 */

const PEM = /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=\n]+)\n?-----END CERTIFICATE-----\n?$/;

function pemToDer(text: string): Buffer {
  const m = PEM.exec(text);
  if (!m) refuse("the log entry's certificate is not one PEM certificate");
  return b64(m![1]!.replace(/\n/g, ""), "the log entry's certificate", 64, 16 * 1024);
}

/** Returns the authenticated signing time (ms). Throws Refused or Unjudgeable. */
export function checkTlogEntry(raw: Json, bundle: Bundle, root: TrustedRoot): number {
  const e = obj(raw, "a transparency log entry");
  const kv = obj(e.kindVersion, "the log entry's kindVersion");
  const kind = str(kv.kind, "kindVersion.kind", 64);
  const version = str(kv.version, "kindVersion.version", 64);
  if (kind !== "dsse" || version !== "0.0.1") {
    if (kind === "dsse" && version === "0.0.2") throw new Unjudgeable("its log entry is a Rekor v2 entry (dsse 0.0.2), which this build cannot check");
    throw new Unjudgeable(`its log entry is of kind ${quote(kind)} ${quote(version)}, which this build does not read`);
  }
  const keyId = b64(obj(e.logId, "the log entry's logId").keyId, "logId.keyId", 32, 32);
  // Rekor v1 entries always carry the promise; an entry without it gives no authenticated time to judge at.
  if (e.inclusionPromise === undefined) throw new Unjudgeable("its log entry has no signed entry timestamp");
  const log = root.tlogs.find((t) => t.keyId.equals(keyId));
  if (!log) throw new Unjudgeable("it was logged by a transparency log the embedded trusted root does not know");
  if (log.keyDetails !== "PKIX_ECDSA_P256_SHA_256") throw new Unjudgeable(`its log signs with ${quote(log.keyDetails)}, which this build does not check for v1 entries`);

  const set = b64(obj(e.inclusionPromise, "inclusionPromise").signedEntryTimestamp, "the signed entry timestamp", 8, 512);
  const integratedTime = int64(e.integratedTime, "integratedTime");
  const logIndex = int64(e.logIndex, "logIndex");
  const bodyB64 = str(e.canonicalizedBody, "canonicalizedBody", 256 * 1024);
  const body = b64(bodyB64, "canonicalizedBody", 2, 192 * 1024);

  // RFC 8785 canonical JSON of exactly these four members (sigstore-js tlog/set.ts). For this fixed set, plain
  // JSON.stringify in this key order is canonical: the keys are already in code-unit order and every value is base64,
  // lowercase hex or a safe integer, none of which needs escaping.
  const signed = Buffer.from(JSON.stringify({ body: bodyB64, integratedTime, logID: keyId.toString("hex"), logIndex }), "utf8");
  let ok = false;
  try {
    ok = verify("sha256", signed, log.key, set);
  } catch {
    ok = false;
  }
  if (!ok) refuse("the transparency log's signed entry timestamp does not verify");
  const timeMs = integratedTime * 1000;
  if (!inWindow(timeMs, log.validFor)) refuse("the transparency log's key was not valid when the entry was logged");

  // The logged body must be this envelope, signed by this certificate.
  const tb = parseJsonObject(body, "the log entry's body");
  if (tb.kind !== kind || tb.apiVersion !== version) refuse("the log entry's body is not the kind its entry says");
  const spec = obj(tb.spec, "the log entry's spec");
  const sigs = arr(spec.signatures, "the log entry's signatures", 8);
  if (sigs.length !== 1) refuse(`the log entry records ${sigs.length} signatures, not exactly one`);
  const s0 = obj(sigs[0], "the log entry's signature");
  if (!b64(s0.signature, "the log entry's signature", 8, 512).equals(bundle.signature)) refuse("the log entry records a different signature than the envelope's");
  const verifierPem = b64(s0.verifier, "the log entry's certificate", 64, 32 * 1024).toString("utf8");
  if (!pemToDer(verifierPem).equals(bundle.leafDer)) refuse("the log entry records a different certificate than the bundle's");
  const ph = obj(spec.payloadHash, "the log entry's payloadHash");
  if (ph.algorithm !== "sha256" || ph.value !== sha256(bundle.payload).toString("hex")) refuse("the log entry records a different payload than the envelope's");
  return timeMs;
}
