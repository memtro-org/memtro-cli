import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeFor, makeState, makeVerifier, newPkce, sameSecret } from "../src/auth/pkce.js";

// RFC 7636 Appendix B.
const OCTETS = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121];
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("RFC 7636 appendix B: the verifier from its octets", () => {
  assert.equal(makeVerifier(Buffer.from(OCTETS)), VERIFIER);
});

test("RFC 7636 appendix B: S256 challenge", () => {
  assert.equal(challengeFor(VERIFIER), CHALLENGE);
});

test("a fresh verifier is 43 base64url characters and its challenge matches", () => {
  const p = newPkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(p.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.challenge, challengeFor(p.verifier));
  assert.match(p.state, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(newPkce().verifier, p.verifier);
  assert.match(makeState(), /^[A-Za-z0-9_-]{1,128}$/);
});

test("sameSecret compares exactly, including unequal lengths", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret("", ""), true);
});
