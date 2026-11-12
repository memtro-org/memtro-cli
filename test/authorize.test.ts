import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAuthorizeUrl, cleanPastedCode, deviceLabel, loopbackRedirect, wantsManual } from "../src/auth/authorize.js";
import { browserCommand } from "../src/auth/browser.js";

test("the authorize URL carries exactly the contract's parameters", () => {
  const url = new URL(
    buildAuthorizeUrl("https://platform.memtro.com/", { challenge: "c".repeat(43), redirectUri: "http://127.0.0.1:53111/callback", state: "s_1-2", device: "ada's mac & co" }),
  );
  assert.equal(url.origin + url.pathname, "https://platform.memtro.com/cli/authorize");
  assert.deepEqual([...url.searchParams.keys()], ["code_challenge", "code_challenge_method", "redirect_uri", "state", "device"]);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:53111/callback");
  assert.equal(url.searchParams.get("device"), "ada's mac & co");
});

test("the device label is optional and the manual redirect is the literal", () => {
  const url = new URL(buildAuthorizeUrl("http://localhost:3000", { challenge: "c", redirectUri: "manual", state: "s" }));
  assert.equal(url.searchParams.get("redirect_uri"), "manual");
  assert.equal(url.searchParams.has("device"), false);
});

test("loopback redirect: 127.0.0.1, explicit port, /callback, ports outside 1024-65535 refused", () => {
  assert.equal(loopbackRedirect(53111), "http://127.0.0.1:53111/callback");
  assert.throws(() => loopbackRedirect(80));
  assert.throws(() => loopbackRedirect(70000));
});

test("device label: the host name, trimmed, control characters stripped, length left to the platform", () => {
  assert.equal(deviceLabel("  ada-mbp\u0007\n "), "ada-mbp");
  assert.equal(deviceLabel("x".repeat(100)).length, 100);
});

test("manual mode: on request, over SSH, on a display-less Linux; never without a terminal to paste into", () => {
  const base = { noBrowser: false, env: {}, platform: "darwin" as const, stdinIsTTY: true };
  assert.equal(wantsManual(base), false);
  assert.equal(wantsManual({ ...base, noBrowser: true }), true);
  assert.equal(wantsManual({ ...base, env: { SSH_CONNECTION: "1 2 3 4" } }), true);
  assert.equal(wantsManual({ ...base, platform: "linux" }), true);
  assert.equal(wantsManual({ ...base, platform: "linux", env: { DISPLAY: ":0" } }), false);
  assert.equal(wantsManual({ ...base, env: { SSH_TTY: "/dev/ttys1" }, stdinIsTTY: false }), false);
});

test("pasted codes are trimmed and must be base64url", () => {
  assert.equal(cleanPastedCode("  abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456\n"), "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456");
  assert.equal(cleanPastedCode("short"), null);
  assert.equal(cleanPastedCode("abcdefghijklmnopqrstuvwxyz; rm -rf /"), null);
});

test("the browser is opened with an argument array per platform, never a shell", () => {
  const url = "https://platform.memtro.com/cli/authorize?a=1&b=2";
  assert.deepEqual(browserCommand("darwin", url), { command: "open", args: [url] });
  assert.deepEqual(browserCommand("linux", url), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserCommand("win32", url), { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
  assert.equal(browserCommand("darwin", "file:///etc/passwd"), null);
});
