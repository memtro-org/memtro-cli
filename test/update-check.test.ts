import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { cachedUpdate, refreshUpdateCache, updateCheckDisabled, type UpdateDeps } from "../src/update/index.js";
import { compareVersions, normaliseVersion, parseVersion } from "../src/update/semver.js";
import { VERSION } from "../src/version.js";
import { fakeGitHub, makeRelease, type FakeGitHub } from "./update-fixtures.js";

const NEWER = "9.0.0";
const OLDER = "0.0.1";
const FAKE_KEY = "mk_live_this_must_never_be_sent_0123456789";

let gh: FakeGitHub;
let dir: string;
let clock: Date;

before(async () => {
  gh = await fakeGitHub();
});
after(async () => {
  await gh.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memtro-update-check-"));
  gh.requests.length = 0;
  gh.intercept = null;
  gh.latestTag = null;
  gh.releases.clear();
  clock = new Date("2026-11-12T10:00:00Z");
});

function deps(over: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    // A real-looking key and profile in the environment: none of it may reach a request.
    env: { MEMTRO_RELEASE_BASE: gh.base, MEMTRO_API_KEY: FAKE_KEY, MEMTRO_ORG_API_KEY: FAKE_KEY, MEMTRO_PROFILE: "work" },
    stateDir: join(dir, "state"),
    now: () => clock,
    fetch: globalThis.fetch,
    execPath: "/nowhere/memtro",
    platform: "darwin",
    arch: "arm64",
    isSea: true,
    ...over,
  };
}

function publish(version: string): void {
  const r = makeRelease(version, {});
  gh.releases.set(r.tag, r);
  gh.latestTag = r.tag;
}

const signal = (): AbortSignal => new AbortController().signal;

test("semver: order, pre-releases older than their release, invalid rejected", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.ok(compareVersions("1.0.0-rc.2", "1.0.0-rc.10") < 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  assert.ok(compareVersions("1.0.0-alpha.beta", "1.0.0-alpha.1") > 0);
  assert.equal(compareVersions("v2.3.4", "2.3.4"), 0);
  assert.equal(normaliseVersion("v0.2.0"), "0.2.0");
  for (const bad of ["", "1", "1.2", "01.2.3", "1.2.3.4", "1.2.3+build", "latest", "1.2.3-", "x1.2.3"]) assert.equal(parseVersion(bad), null, bad);
});

test("updateCheckDisabled: env, CI and config", () => {
  assert.equal(updateCheckDisabled({}, undefined), false);
  assert.equal(updateCheckDisabled({}, true), false);
  assert.equal(updateCheckDisabled({}, false), true);
  assert.equal(updateCheckDisabled({ MEMTRO_NO_UPDATE_CHECK: "1" }, undefined), true);
  assert.equal(updateCheckDisabled({ MEMTRO_NO_UPDATE_CHECK: "yes" }, true), true);
  assert.equal(updateCheckDisabled({ MEMTRO_NO_UPDATE_CHECK: "0" }, undefined), false);
  assert.equal(updateCheckDisabled({ CI: "true" }, undefined), true);
  assert.equal(updateCheckDisabled({ CI: "1" }, undefined), true);
  assert.equal(updateCheckDisabled({ CI: "false" }, undefined), false);
  assert.equal(updateCheckDisabled({ CI: "" }, undefined), false);
});

test("nothing cached: cachedUpdate is null and touches no network", () => {
  assert.equal(cachedUpdate(deps()), null);
  assert.equal(gh.requests.length, 0);
});

test("a newer release is cached and reported; the cache file is owner-only", async () => {
  publish(NEWER);
  await refreshUpdateCache(deps(), signal());
  assert.deepEqual(cachedUpdate(deps()), { current: VERSION, latest: NEWER, newer: true, tag: `v${NEWER}` });
  const file = join(dir, "state", "update.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(saved, { checked: clock.toISOString(), latest: NEWER, tag: `v${NEWER}` });
});

test("the same and an older release are not newer", async () => {
  publish(VERSION);
  await refreshUpdateCache(deps(), signal());
  assert.equal(cachedUpdate(deps())?.newer, false);
  rmSync(join(dir, "state"), { recursive: true });
  publish(OLDER);
  await refreshUpdateCache(deps(), signal());
  assert.deepEqual(cachedUpdate(deps()), { current: VERSION, latest: OLDER, newer: false, tag: `v${OLDER}` });
});

test("checks at most once in 24 hours", async () => {
  publish(NEWER);
  await refreshUpdateCache(deps(), signal());
  const after1 = gh.requests.length;
  assert.ok(after1 > 0);
  clock = new Date(clock.getTime() + 23 * 3600_000);
  await refreshUpdateCache(deps(), signal());
  assert.equal(gh.requests.length, after1, "no request within 24 hours");
  clock = new Date(clock.getTime() + 2 * 3600_000);
  await refreshUpdateCache(deps(), signal());
  assert.ok(gh.requests.length > after1, "a request after 24 hours");
});

test("a checked time in the future does not silence checking for ever", async () => {
  publish(NEWER);
  const stateDir = join(dir, "state");
  await refreshUpdateCache(deps(), signal());
  writeFileSync(join(stateDir, "update.json"), JSON.stringify({ checked: "2099-01-01T00:00:00Z", latest: NEWER, tag: `v${NEWER}` }));
  const before = gh.requests.length;
  await refreshUpdateCache(deps(), signal());
  assert.ok(gh.requests.length > before);
});

test("no credentials, cookies or profile on any request; the User-Agent names the CLI", async () => {
  publish(NEWER);
  await refreshUpdateCache(deps(), signal());
  assert.ok(gh.requests.length >= 2, "latest.json and its redirect");
  for (const r of gh.requests) {
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers.cookie, undefined);
    assert.equal(r.headers["user-agent"], `memtro-cli/${VERSION}`);
    const all = JSON.stringify(r.headers);
    assert.ok(!all.includes(FAKE_KEY) && !all.includes("work"), all);
    assert.deepEqual(
      Object.keys(r.headers).filter((h) => !["host", "connection", "user-agent", "accept", "accept-encoding", "accept-language", "sec-fetch-mode"].includes(h)),
      [],
    );
  }
});

test("falls back to the tag releases/latest redirects to when latest.json is missing", async () => {
  publish(NEWER);
  gh.intercept = (path, res) => (path.endsWith("/latest.json") ? (res.writeHead(404).end(), true) : false);
  await refreshUpdateCache(deps(), signal());
  assert.deepEqual(cachedUpdate(deps()), { current: VERSION, latest: NEWER, newer: true, tag: `v${NEWER}` });
  assert.ok(gh.requests.some((r) => r.url === "/releases/latest"));
});

test("an invalid latest is ignored", async () => {
  publish(NEWER);
  gh.intercept = (path, res) => {
    if (path.endsWith("/latest.json")) return res.writeHead(200).end(JSON.stringify({ version: "latest!", tag: "vlatest!" })), true;
    if (path === "/releases/latest") return res.writeHead(302, { location: "/releases/tag/nightly" }).end(), true;
    return false;
  };
  await refreshUpdateCache(deps(), signal());
  assert.equal(cachedUpdate(deps()), null);
  // A tag that disagrees with its version is not believed either.
  writeFileSync(join(dir, "state", "update.json"), JSON.stringify({ checked: clock.toISOString(), latest: "9.0.0", tag: "v8.0.0" }));
  assert.equal(cachedUpdate(deps()), null);
  writeFileSync(join(dir, "state", "update.json"), "{not json");
  assert.equal(cachedUpdate(deps()), null);
});

test("a redirect to a host that is not the release host is refused", async () => {
  publish(NEWER);
  gh.intercept = (path, res) => {
    if (path.endsWith("/latest.json")) return res.writeHead(302, { location: "http://127.0.0.2:9/latest.json" }).end(), true;
    if (path === "/releases/latest") return res.writeHead(302, { location: "https://evil.example/releases/tag/v9.9.9" }).end(), true;
    return false;
  };
  await refreshUpdateCache(deps(), signal());
  assert.equal(cachedUpdate(deps()), null);
  assert.equal(gh.requests.length, 2, "neither redirect was followed");
});

test("an unreachable host resolves quietly, remembers the attempt, and keeps what it knew", async () => {
  publish(NEWER);
  await refreshUpdateCache(deps(), signal());
  clock = new Date(clock.getTime() + 25 * 3600_000);
  const unreachable = deps({ env: { MEMTRO_RELEASE_BASE: "http://127.0.0.1:9/releases" } });
  await refreshUpdateCache(unreachable, signal());
  assert.equal(cachedUpdate(deps())?.latest, NEWER);
  const saved = JSON.parse(readFileSync(join(dir, "state", "update.json"), "utf8")) as { checked: string };
  assert.equal(saved.checked, clock.toISOString());
});

test("a slow host is given up on after the short timeout; an abort resolves at once and records nothing", async () => {
  publish(NEWER);
  gh.intercept = () => true; // never answers
  const started = Date.now();
  await refreshUpdateCache(deps(), signal());
  const took = Date.now() - started;
  assert.ok(took >= 2500 && took < 6000, `took ${took} ms`);

  rmSync(join(dir, "state"), { recursive: true, force: true });
  const ctl = new AbortController();
  const pending = refreshUpdateCache(deps(), ctl.signal);
  setTimeout(() => ctl.abort(), 50);
  const t0 = Date.now();
  await pending;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(cachedUpdate(deps()), null);
  assert.throws(() => statSync(join(dir, "state", "update.json")));
});

test("never rejects, even when the state directory cannot be written", async () => {
  publish(NEWER);
  const blocker = join(dir, "file");
  writeFileSync(blocker, "");
  await refreshUpdateCache(deps({ stateDir: join(blocker, "state") }), signal());
  await refreshUpdateCache(deps({ env: { MEMTRO_RELEASE_BASE: "ftp://nope" } }), signal());
});

test("without the override, only github.com over https is asked", async () => {
  const urls: string[] = [];
  const recording: typeof fetch = async (input) => {
    urls.push(String(input));
    throw new Error("offline");
  };
  await refreshUpdateCache(deps({ env: {}, fetch: recording }), signal());
  assert.deepEqual(urls, [
    "https://github.com/memtro-org/memtro-cli/releases/latest/download/latest.json",
    "https://github.com/memtro-org/memtro-cli/releases/latest",
  ]);
});
