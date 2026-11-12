import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * PKCE (RFC 7636) and the `state` value, as the contract states them: a verifier of 32 random bytes in base64url
 * without padding (43 characters), the S256 challenge of it, and 16 random bytes of state.
 */

export const base64url = (bytes: Buffer): string => bytes.toString("base64url");

export function makeVerifier(bytes: Buffer = randomBytes(32)): string {
  return base64url(bytes);
}

/** `BASE64URL(SHA256(ASCII(code_verifier)))`, RFC 7636 §4.2. */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function makeState(bytes: Buffer = randomBytes(16)): string {
  return base64url(bytes);
}

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function newPkce(): Pkce {
  const verifier = makeVerifier();
  return { verifier, challenge: challengeFor(verifier), state: makeState() };
}

/** Constant-time string comparison; unequal lengths are unequal without comparing contents. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
