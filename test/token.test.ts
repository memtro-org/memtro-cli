import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { challengeFor, makeVerifier } from "../src/auth/pkce.js";
import { exchangeCode } from "../src/auth/token.js";
import { CliError, EXIT } from "../src/errors.js";
import { startFakePlatform, type FakePlatform } from "./fake-platform.js";

let fake: FakePlatform;
before(async () => (fake = await startFakePlatform()));
after(() => fake.close());

const ua = { userAgent: "memtro-cli/test" };

/** Ask the fake for a code the way the approval page would hand one to a loopback redirect. */
async function codeFor(challenge: string, redirectUri: string): Promise<string> {
  const url = `${fake.base}/cli/authorize?code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}&state=s`;
  const res = await fetch(url, { redirect: "manual" });
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

test("exchange: success returns the key, the person and the organisation", async () => {
  const verifier = makeVerifier();
  const redirectUri = "http://127.0.0.1:50123/callback";
  const code = await codeFor(challengeFor(verifier), redirectUri);
  const t = await exchangeCode(fake.base, { code, codeVerifier: verifier, redirectUri }, ua);
  assert.match(t.api_key, /^sk-memtro-/);
  assert.equal(t.organisation.name, "Analytical Engines");
  assert.equal(t.user.email, "ada@example.com");
  const sent = fake.requests.at(-1)!;
  assert.equal(sent.headers.authorization, undefined, "the exchange carries no credentials");
  assert.equal(sent.headers["user-agent"], "memtro-cli/test");
  assert.deepEqual(Object.keys(sent.body as object), ["code", "code_verifier", "redirect_uri"]);
});

test("exchange: a wrong verifier is invalid_grant, and burns the code", async () => {
  const verifier = makeVerifier();
  const redirectUri = "http://127.0.0.1:50124/callback";
  const code = await codeFor(challengeFor(verifier), redirectUri);
  await assert.rejects(exchangeCode(fake.base, { code, codeVerifier: makeVerifier(), redirectUri }, ua), (e: CliError) => e.exitCode === EXIT.failure && /refused the sign-in code/.test(e.message));
  await assert.rejects(exchangeCode(fake.base, { code, codeVerifier: verifier, redirectUri }, ua), /refused the sign-in code/);
});

test("exchange: a mismatched redirect_uri is invalid_grant", async () => {
  const verifier = makeVerifier();
  const code = await codeFor(challengeFor(verifier), "http://127.0.0.1:50125/callback");
  await assert.rejects(exchangeCode(fake.base, { code, codeVerifier: verifier, redirectUri: "http://127.0.0.1:50126/callback" }, ua), /refused/);
});

test("exchange: an unreachable platform is exit 4, and says nothing was stored", async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  await assert.rejects(exchangeCode(`http://127.0.0.1:${port}`, { code: "c", codeVerifier: "v", redirectUri: "manual" }, ua), (e: CliError) => e.exitCode === EXIT.unavailable && /Nothing was stored/.test(e.message));
});

test("exchange: 503 temporarily_unavailable is exit 4; other statuses do not print the body", async () => {
  let status = 503;
  const server = createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status === 503 ? { error: "temporarily_unavailable" } : { error: "sk-memtro-SECRETSECRET echo" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(exchangeCode(base, { code: "c", codeVerifier: "v", redirectUri: "manual" }, ua), (e: CliError) => e.exitCode === EXIT.unavailable);
    status = 418;
    await assert.rejects(exchangeCode(base, { code: "c", codeVerifier: "v", redirectUri: "manual" }, ua), (e: CliError) => e.exitCode === EXIT.failure && !e.message.includes("SECRET"));
    status = 400;
    await assert.rejects(exchangeCode(base, { code: "c", codeVerifier: "v", redirectUri: "manual" }, ua), (e: CliError) => !e.message.includes("SECRET"));
  } finally {
    server.close();
  }
});
