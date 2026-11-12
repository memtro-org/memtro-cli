// install.sh, run for real (piped to sh, as `curl | sh` does) against a local server standing in for GitHub
// releases (MEMTRO_RELEASE_BASE), into a temporary HOME. Nothing here reaches the network or the real home.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/version.js";
import { fakeExecutable, fakeGitHub, makeRelease, sha256, tarGz, type FakeGitHub } from "./update-fixtures.js";

const SCRIPT_PATH = fileURLToPath(new URL("../install.sh", import.meta.url));
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");
const TARGET = `${process.platform}-${process.arch}`;
/** The real release tarball when `npm run bundle && npm run build:sea` has run here. */
const BUILT_TARBALL = fileURLToPath(new URL(`../build/memtro-${TARGET}.tar.gz`, import.meta.url));
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

let gh: FakeGitHub;
let home: string;

before(async () => {
  gh = await fakeGitHub();
});
after(async () => {
  await gh.close();
});
// Each test may hold a copy of the real ~115 MB executable: never leave them behind in the temp directory.
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  gh.requests.length = 0;
  gh.intercept = null;
  gh.latestTag = null;
  gh.releases.clear();
  home = realpathSync(mkdtempSync(join(tmpdir(), "memtro-install-")));
});

function publish(version: string, exe: Buffer = fakeExecutable(version), opts: { tamper?: string } = {}): void {
  const r = makeRelease(version, { [TARGET]: exe }, opts);
  gh.releases.set(r.tag, r);
  gh.latestTag = r.tag;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Pipes the script to a shell, as `curl … | sh` does. Asynchronous: the fake server lives in this process. */
function install(env: Record<string, string> = {}, opts: { shell?: string; script?: string; args?: string[] } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.shell ?? "sh", opts.args ?? [], {
      env: { HOME: home, PATH: SYSTEM_PATH, SHELL: "/bin/zsh", MEMTRO_RELEASE_BASE: gh.base, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.script ?? SCRIPT);
  });
}

const installed = (): string => join(home, ".memtro", "bin", "memtro");
const versionOf = (file: string): string => spawnSync(file, ["--version"], { encoding: "utf8", env: { PATH: SYSTEM_PATH } }).stdout.trim();
const binEntries = (): string[] => (existsSync(join(home, ".memtro", "bin")) ? readdirSync(join(home, ".memtro", "bin")) : []);

test("the script parses under sh and dash", async () => {
  assert.equal(spawnSync("sh", ["-n", SCRIPT_PATH]).status, 0);
  if (existsSync("/bin/dash") || spawnSync("sh", ["-c", "command -v dash"]).status === 0) {
    assert.equal(spawnSync("dash", ["-n", SCRIPT_PATH]).status, 0);
  }
});

test("fresh install of the built executable (or a stand-in), with PATH advice and no file edited", async () => {
  if (existsSync(BUILT_TARBALL)) {
    const r = makeRelease(VERSION, {});
    const tarball = readFileSync(BUILT_TARBALL);
    r.files[`memtro-${TARGET}.tar.gz`] = tarball;
    r.files["checksums.txt"] = `${sha256(tarball)}  memtro-${TARGET}.tar.gz\n`;
    gh.releases.set(r.tag, r);
    gh.latestTag = r.tag;
  } else {
    publish(VERSION);
  }
  const r = await install();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(versionOf(installed()), VERSION);
  assert.equal(statSync(installed()).mode & 0o777, 0o755);
  assert.deepEqual(binEntries(), ["memtro"]);
  assert.match(r.stdout, new RegExp(`Installed memtro ${VERSION.replace(/\./g, "\\.")} at ${installed()}`));
  assert.match(r.stdout, /is not on your PATH/);
  assert.ok(r.stdout.includes(`export PATH="${join(home, ".memtro", "bin")}:$PATH"`), r.stdout);
  assert.ok(r.stdout.includes(join(home, ".zshrc")));
  assert.deepEqual(readdirSync(home), [".memtro"], "nothing but the install directory was created");
  for (const q of gh.requests) assert.equal(q.headers.authorization, undefined);
});

test("re-install over an existing one replaces it and says so", async () => {
  publish(VERSION);
  assert.equal((await install()).status, 0);
  publish("9.0.0");
  const r = await install();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Replaced memtro ${VERSION.replace(/\./g, "\\.")} with memtro 9\\.0\\.0`));
  assert.equal(versionOf(installed()), "9.0.0");
  assert.deepEqual(binEntries(), ["memtro"]);
});

test("a pinned version, with or without the v, never asks for latest", async () => {
  publish("9.0.0");
  const pinned = makeRelease("3.1.4", { [TARGET]: fakeExecutable("3.1.4") });
  gh.releases.set(pinned.tag, pinned);
  for (const v of ["3.1.4", "v3.1.4"]) {
    const r = await install({ MEMTRO_VERSION: v });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(versionOf(installed()), "3.1.4");
  }
  assert.ok(!gh.requests.some((q) => q.url.includes("latest")));
  const bad = await install({ MEMTRO_VERSION: "latest; rm -rf /" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /not a version/);
});

test("MEMTRO_INSTALL_DIR is honoured; a directory already on PATH gets no advice", async () => {
  publish(VERSION);
  const dir = join(home, "my tools", "bin");
  const r = await install({ MEMTRO_INSTALL_DIR: dir, PATH: `${dir}:${SYSTEM_PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(versionOf(join(dir, "memtro")), VERSION);
  assert.match(r.stdout, /Type memtro to start/);
  assert.doesNotMatch(r.stdout, /not on your PATH/);
  assert.notEqual((await install({ MEMTRO_INSTALL_DIR: "relative/bin" })).status, 0);
});

test("checksum mismatch: non-zero, nothing installed, an existing install untouched", async () => {
  publish(VERSION, fakeExecutable(VERSION), { tamper: TARGET });
  const r = await install();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /checksum mismatch/);
  assert.ok(!existsSync(installed()));

  publish(VERSION);
  assert.equal((await install()).status, 0);
  const before = sha256(readFileSync(installed()));
  publish("9.0.0", fakeExecutable("9.0.0"), { tamper: TARGET });
  assert.notEqual((await install()).status, 0);
  assert.equal(sha256(readFileSync(installed())), before);
  assert.deepEqual(binEntries(), ["memtro"]);
});

test("no build for this platform: a clear message, nothing installed", async () => {
  const r0 = makeRelease("9.0.0", { "plan9-mips": fakeExecutable("9.0.0") });
  gh.releases.set(r0.tag, r0);
  gh.latestTag = r0.tag;
  const r = await install();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`no build for ${TARGET}`));
  assert.ok(!existsSync(installed()));
});

test("no such release, or no latest: non-zero with a message", async () => {
  publish("9.0.0");
  const r = await install({ MEMTRO_VERSION: "7.7.7" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /v7\.7\.7/);
  gh.latestTag = null;
  const r2 = await install();
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /latest release/);
});

test("a tarball with anything but the single file memtro is refused before extraction", async () => {
  for (const entries of [
    [{ name: "../memtro", data: fakeExecutable("9.0.0") }],
    [{ name: "memtro", type: "2", linkname: "/bin/sh" }],
    [{ name: "memtro", data: fakeExecutable("9.0.0") }, { name: "extra", data: Buffer.from("x") }],
  ]) {
    const r0 = makeRelease("9.0.0", {});
    const tarball = tarGz(entries);
    r0.files[`memtro-${TARGET}.tar.gz`] = tarball;
    r0.files["checksums.txt"] = `${sha256(tarball)}  memtro-${TARGET}.tar.gz\n`;
    gh.releases.set(r0.tag, r0);
    gh.latestTag = r0.tag;
    const r = await install();
    assert.notEqual(r.status, 0, JSON.stringify(entries));
    assert.ok(!existsSync(installed()));
    assert.ok(!existsSync(join(home, ".memtro", "memtro")));
  }
});

test("a downloaded executable that does not start is not installed", async () => {
  publish("9.0.0", fakeExecutable("9.0.0", 1));
  const r = await install();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not start/);
  assert.deepEqual(binEntries(), []);
});

test("the proof run sees no Memtro key", async () => {
  const spy = Buffer.from(`#!/bin/sh\nenv > "${join(home, "seen.txt")}"\necho 9.0.0\n`);
  publish("9.0.0", spy);
  assert.equal((await install({ MEMTRO_API_KEY: "mk_live_secret_secret" })).status, 0);
  assert.ok(!readFileSync(join(home, "seen.txt"), "utf8").includes("mk_live_secret_secret"));
});

test("a truncated script runs nothing, wherever it is cut", async () => {
  publish(VERSION);
  const lines = SCRIPT.split("\n");
  for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9, 0.97]) {
    const cut = lines.slice(0, Math.floor(lines.length * fraction)).join("\n");
    for (const shell of ["sh", ...(existsSync("/bin/dash") ? ["dash"] : [])]) {
      await install({}, { script: cut, shell });
    }
  }
  // Also cut mid-line, through the middle of the file.
  await install({}, { script: SCRIPT.slice(0, Math.floor(SCRIPT.length / 2)) });
  assert.equal(gh.requests.length, 0, "no request reached the server");
  assert.deepEqual(readdirSync(home), [], "nothing was created");
});

test("MEMTRO_MODIFY_PATH=1 appends once, and only once, to the right file for each shell", async () => {
  publish(VERSION);
  const dir = join(home, ".memtro", "bin");
  const cases: Array<[string, string, string]> = [
    ["/bin/zsh", join(home, ".zshrc"), `export PATH="${dir}:$PATH"`],
    ["/usr/local/bin/fish", join(home, ".config", "fish", "config.fish"), `fish_add_path "${dir}"`],
    ["/bin/bash", join(home, process.platform === "darwin" ? ".bash_profile" : ".bashrc"), `export PATH="${dir}:$PATH"`],
    ["/bin/ksh", join(home, ".profile"), `export PATH="${dir}:$PATH"`],
  ];
  for (const [shell, rc, line] of cases) {
    const first = await install({ MEMTRO_MODIFY_PATH: "1", SHELL: shell });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(first.stdout.includes(`Added ${dir} to PATH in ${rc}`), first.stdout);
    const second = await install({ MEMTRO_MODIFY_PATH: "1", SHELL: shell });
    assert.ok(second.stdout.includes("already adds"), second.stdout);
    const text = readFileSync(rc, "utf8");
    assert.equal(text.split("\n").filter((l) => l === line).length, 1, `${rc}:\n${text}`);
  }
  // Existing content is kept.
  writeFileSync(join(home, ".zshrc"), `alias x=y\n${readFileSync(join(home, ".zshrc"), "utf8")}`);
  await install({ MEMTRO_MODIFY_PATH: "1" });
  assert.match(readFileSync(join(home, ".zshrc"), "utf8"), /^alias x=y\n/);
});

test("runs under dash", { skip: !existsSync("/bin/dash") }, async () => {
  publish(VERSION);
  const r = await install({}, { shell: "dash" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(versionOf(installed()), VERSION);
});

test("works with wget when there is no curl", async () => {
  const tools = ["sh", "uname", "tar", "gzip", "mktemp", "awk", "sed", "grep", "head", "env", "cp", "mv", "chmod", "mkdir", "rm", "basename", "dirname", "cat", "printf", "sysctl", "shasum", "sha256sum", "wget", "perl"];
  const wgetPath = spawnSync("sh", ["-c", "command -v wget"], { encoding: "utf8", env: { PATH: SYSTEM_PATH } }).stdout.trim();
  if (!wgetPath) return;
  publish(VERSION);
  const bin = join(home, "..", `${home.split("/").pop()}-tools`);
  mkdirSync(bin);
  for (const t of tools) {
    const p = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8", env: { PATH: SYSTEM_PATH } }).stdout.trim();
    if (p.startsWith("/")) symlinkSync(p, join(bin, t));
  }
  const r = await install({ PATH: bin });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(versionOf(installed()), VERSION);
});

test("plain http is refused unless it is a loopback test server; unknown arguments are refused", async () => {
  const r = await install({ MEMTRO_RELEASE_BASE: "http://example.com/releases" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /https/);
  const a = await install({}, { args: ["-s", "--", "--frobnicate"] });
  assert.notEqual(a.status, 0);
  const h = await install({}, { args: ["-s", "--", "--help"] });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /MEMTRO_VERSION/);
  assert.deepEqual(readdirSync(home), []);
});

// ---- review regressions ----

test("a hard link or device named memtro is refused before extraction, by its listed type", async () => {
  for (const entries of [
    [{ name: "memtro", type: "1", linkname: "/etc/hosts" }],
    [{ name: "memtro", type: "3" }],
  ]) {
    const r0 = makeRelease("9.0.0", {});
    const tarball = tarGz(entries);
    r0.files[`memtro-${TARGET}.tar.gz`] = tarball;
    r0.files["checksums.txt"] = `${sha256(tarball)}  memtro-${TARGET}.tar.gz\n`;
    gh.releases.set(r0.tag, r0);
    gh.latestTag = r0.tag;
    const r = await install();
    assert.notEqual(r.status, 0, JSON.stringify(entries));
    assert.ok(!existsSync(installed()));
  }
});

test("an install directory with spaces and glob characters is quoted everywhere, and judged on PATH exactly", async () => {
  publish(VERSION);
  const dir = join(home, "my tools", "b*n");
  const r = await install({ MEMTRO_INSTALL_DIR: dir, PATH: `${SYSTEM_PATH}:${join(home, "my tools", "bin")}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(versionOf(join(dir, "memtro")), VERSION);
  assert.match(r.stdout, /is not on your PATH/, "b*n is not matched as a pattern against .../bin");
  assert.ok(r.stdout.includes(`export PATH="${dir}:$PATH"`));
  assert.deepEqual(readdirSync(dir), ["memtro"]);
});

test("HOME unset with MEMTRO_INSTALL_DIR set: installs and gives PATH advice without touching any rc file", async () => {
  publish(VERSION);
  const dir = join(home, "bin");
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("sh", [], { env: { PATH: SYSTEM_PATH, MEMTRO_RELEASE_BASE: gh.base, MEMTRO_INSTALL_DIR: dir, MEMTRO_MODIFY_PATH: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(SCRIPT);
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(versionOf(join(dir, "memtro")), VERSION);
  assert.match(r.stdout, /export PATH=/);
  assert.deepEqual(readdirSync(home), ["bin"]);
});

test("a truncated script runs nothing at any byte offset before its last line (sweep)", async () => {
  publish(VERSION);
  const last = SCRIPT.lastIndexOf('main "$@"');
  assert.ok(last > 0);
  // Every 23rd byte through the file, and every byte of the last 80 before the call itself.
  const offsets = new Set<number>();
  for (let i = 0; i < last; i += 23) offsets.add(i);
  for (let i = Math.max(0, last - 80); i <= last + 'main "$'.length; i++) if (i < last + 4) offsets.add(i);
  for (const at of offsets) {
    const r = await install({}, { script: SCRIPT.slice(0, at) });
    assert.equal(gh.requests.length, 0, `cut at byte ${at} reached the server`);
    assert.deepEqual(readdirSync(home), [], `cut at byte ${at} created something: ${r.stdout}${r.stderr}`);
  }
});
