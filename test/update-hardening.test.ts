// Regression tests for the updater review: hosts a release may come from, an archive that inflates without end,
// and a directory others can write. Nothing here reaches the network.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { test } from "node:test";
import { performUpdate } from "../src/update/index.js";
import { releaseSource } from "../src/update/net.js";
import { extractSingleFile } from "../src/update/tar.js";
import { fakeExecutable, tarGz } from "./update-fixtures.js";

test("default release source: only this repository on github.com, the asset hosts, https, no port or user", () => {
  const s = releaseSource({});
  const ok = (u: string) => s.allowed(new URL(u));
  assert.equal(ok("https://github.com/memtro-org/memtro-cli/releases/download/v0.3.0/checksums.txt"), true);
  assert.equal(ok("https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x"), true);
  for (const bad of [
    "https://github.com/attacker/memtro-cli/releases/download/v0.3.0/memtro-darwin-arm64.tar.gz",
    "https://github.com/memtro-org/memtro-cli-evil/releases/download/v0.3.0/x",
    "https://github.com/memtro-org/memtro-clireleases/x",
    "http://github.com/memtro-org/memtro-cli/releases/latest",
    "https://github.com:8443/memtro-org/memtro-cli/releases/latest",
    "https://user:pw@github.com/memtro-org/memtro-cli/releases/latest",
    "https://evil.example/memtro-org/memtro-cli/releases/latest",
    "https://github.com.evil.example/memtro-org/memtro-cli/releases/latest",
  ]) {
    assert.equal(ok(bad), false, bad);
  }
});

test("tar: an archive that keeps inflating after its one file is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memtro-tarbomb-"));
  try {
    const tar = gunzipSync(tarGz([{ name: "memtro", data: Buffer.from("x") }]));
    const bomb = gzipSync(Buffer.concat([tar, Buffer.alloc(4 * 1024 * 1024)]));
    const archive = join(dir, "a.tar.gz");
    writeFileSync(archive, bomb);
    await assert.rejects(extractSingleFile(archive, "memtro", join(dir, "out"), 0o755, 1024 * 1024), /inflates/);
    // The same archive within the cap is fine.
    await extractSingleFile(archive, "memtro", join(dir, "out2"), 0o755, 8 * 1024 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("performUpdate: an install directory every user can write is not updated, and nothing is fetched", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "memtro-worldw-")));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    chmodSync(bin, 0o777);
    const exe = join(bin, "memtro");
    writeFileSync(exe, fakeExecutable("0.2.0"), { mode: 0o755 });
    let fetched = 0;
    const out = await performUpdate(
      {
        env: { MEMTRO_RELEASE_BASE: "http://127.0.0.1:9" },
        stateDir: join(dir, "state"),
        now: () => new Date(),
        fetch: (async () => {
          fetched++;
          throw new Error("no");
        }) as typeof fetch,
        execPath: exe,
        platform: "darwin",
        arch: "arm64",
        isSea: true,
      },
      { signal: new AbortController().signal },
    );
    assert.equal(out.kind, "unmanaged");
    assert.match((out as { reason: string }).reason, /writable by every user/);
    assert.equal(fetched, 0);
    assert.ok(existsSync(exe));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
