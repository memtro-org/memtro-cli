import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { classifyCallback, startLoopback } from "../src/auth/loopback.js";

const expected = { host: "127.0.0.1:50000", state: "the-state" };
const get = (url: string) => ({ method: "GET", url, host: expected.host });

test("classify: a good callback yields the code", () => {
  assert.deepEqual(classifyCallback(get("/callback?code=abc&state=the-state"), expected), { action: "finish", outcome: { kind: "code", code: "abc" } });
});

test("classify: a state mismatch ends the login without a code", () => {
  const v = classifyCallback(get("/callback?code=abc&state=other"), expected);
  assert.equal(v.action, "finish");
  assert.equal(v.action === "finish" && v.outcome.kind, "error");
  const missing = classifyCallback(get("/callback?code=abc"), expected);
  assert.equal(missing.action === "finish" && missing.outcome.kind, "error");
});

test("classify: access_denied is a cancellation; other errors are errors", () => {
  assert.deepEqual(classifyCallback(get("/callback?error=access_denied&state=the-state"), expected), { action: "finish", outcome: { kind: "denied" } });
  const v = classifyCallback(get("/callback?error=server_error&state=the-state"), expected);
  assert.equal(v.action === "finish" && v.outcome.kind, "error");
});

test("classify: wrong path, wrong method and wrong Host are ignored, not fatal", () => {
  assert.deepEqual(classifyCallback(get("/favicon.ico"), expected), { action: "ignore", status: 404, page: "not-found" });
  assert.deepEqual(classifyCallback(get("/callback/../x?code=a&state=the-state"), expected).action, "ignore");
  assert.equal(classifyCallback({ ...get("/callback?code=a&state=the-state"), method: "POST" }, expected).action, "ignore");
  assert.equal(classifyCallback({ ...get("/callback?code=a&state=the-state"), host: "evil.example:50000" }, expected).action, "ignore");
  assert.equal(classifyCallback({ ...get("/callback?code=a&state=the-state"), host: "localhost:50000" }, expected).action, "ignore");
  assert.equal(classifyCallback({ ...get("/callback?code=a&state=the-state"), host: undefined }, expected).action, "ignore");
});

/** A raw request with a Host of our choosing (fetch will not let a caller set Host). */
function raw(port: number, path: string, host: string, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { Host: host } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (d: string) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("listener: ignores strays, then exchanges the real code and shows success", async () => {
  const seen: string[] = [];
  const loop = await startLoopback({ state: "st", timeoutMs: 5_000, onCode: async (code) => (seen.push(code), "ok") });
  const host = `127.0.0.1:${loop.port}`;
  assert.equal((await raw(loop.port, "/favicon.ico", host)).status, 404);
  assert.equal((await raw(loop.port, "/callback?code=c1&state=st", `rebind.example:${loop.port}`)).status, 400);
  assert.equal((await raw(loop.port, "/callback?code=c1&state=st", host, "POST")).status, 405);
  const ok = await raw(loop.port, "/callback?code=c1&state=st", host);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /You are signed in/);
  assert.doesNotMatch(ok.body, /c1|st&/);
  assert.deepEqual(await loop.result, { kind: "done", value: "ok" });
  assert.deepEqual(seen, ["c1"]);
});

test("listener: a state mismatch fails and never calls onCode", async () => {
  let called = false;
  const loop = await startLoopback({ state: "st", timeoutMs: 5_000, onCode: async () => ((called = true), "x") });
  const res = await raw(loop.port, "/callback?code=c1&state=nope", `127.0.0.1:${loop.port}`);
  assert.equal(res.status, 400);
  const result = await loop.result;
  assert.equal(result.kind, "error");
  assert.equal(called, false);
});

test("listener: cancel in the browser", async () => {
  const loop = await startLoopback({ state: "st", timeoutMs: 5_000, onCode: async () => "x" });
  const res = await raw(loop.port, "/callback?error=access_denied&state=st", `127.0.0.1:${loop.port}`);
  assert.match(res.body, /cancelled/i);
  assert.deepEqual(await loop.result, { kind: "denied" });
});

test("listener: a failed exchange shows the failure page", async () => {
  const loop = await startLoopback({ state: "st", timeoutMs: 5_000, onCode: async () => Promise.reject(new Error("refused")) });
  const res = await raw(loop.port, "/callback?code=c&state=st", `127.0.0.1:${loop.port}`);
  assert.match(res.body, /did not complete/);
  const result = await loop.result;
  assert.equal(result.kind === "error" && result.error.message, "refused");
});

test("listener: times out, and stops listening", async () => {
  const loop = await startLoopback({ state: "st", timeoutMs: 30, onCode: async () => "x" });
  assert.deepEqual(await loop.result, { kind: "timeout" });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(raw(loop.port, "/callback?code=c&state=st", `127.0.0.1:${loop.port}`));
});

test("listener: close() (Ctrl-C) settles as aborted", async () => {
  const loop = await startLoopback({ state: "st", timeoutMs: 5_000, onCode: async () => "x" });
  loop.close();
  assert.deepEqual(await loop.result, { kind: "aborted" });
});
