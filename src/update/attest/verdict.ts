/**
 * The two ways a single bundle can fail, as exceptions inside the verifier, and the strict decoders every field goes
 * through. `Refused`: the bundle is in a form this verifier fully understands and a check failed (or the form is
 * malformed). `Unjudgeable`: the bundle is in a form, or names a key or authority, this build does not know, so it
 * cannot say either way. See the tier table in index.ts for which is which, and why.
 */

export class Refused extends Error {}
export class Unjudgeable extends Error {}

export const refuse = (why: string): never => {
  throw new Refused(why);
};

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v[key]` as an object, or a refusal naming `what`. */
export function obj(v: unknown, what: string): JsonObject {
  if (!isObject(v)) refuse(`${what} is missing or not an object`);
  return v as JsonObject;
}

export function str(v: unknown, what: string, max = 1 << 20): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) refuse(`${what} is missing, empty or too long`);
  return v as string;
}

export function arr(v: unknown, what: string, max = 64): Json[] {
  if (!Array.isArray(v) || v.length > max) refuse(`${what} is missing, not a list, or too long`);
  return v as Json[];
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Standard base64 (what protobuf JSON emits), canonical and within `min`..`max` decoded bytes. Node's own decoder
 * skips characters it does not know, so the text is checked first and the result re-encoded and compared.
 */
export function b64(v: unknown, what: string, min = 1, max = 1 << 20): Buffer {
  if (typeof v !== "string" || !B64.test(v)) refuse(`${what} is not base64`);
  const out = Buffer.from(v as string, "base64");
  if (out.toString("base64") !== v) refuse(`${what} is not canonical base64`);
  if (out.length < min || out.length > max) refuse(`${what} has an implausible length (${out.length} bytes)`);
  return out;
}

/** A decimal integer carried as a JSON string (protobuf int64), as a safe integer. */
export function int64(v: unknown, what: string): number {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(v)) refuse(`${what} is not a decimal integer`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) refuse(`${what} is out of range`);
  return n;
}

/** JSON.parse of bytes that must be valid UTF-8 and a JSON object. */
export function parseJsonObject(bytes: Buffer, what: string): JsonObject {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) refuse(`${what} is not valid UTF-8`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse(`${what} is not JSON`);
  }
  return obj(parsed, what);
}
