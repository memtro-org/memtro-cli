#!/usr/bin/env node
// Builds the standalone executable for THIS machine (no cross-building) from build/memtro.cjs:
//   build/memtro-<os>-<arch>          the executable (Node single executable application)
//   build/memtro-<os>-<arch>.tar.gz   a tarball holding that file as `memtro`, mode 0755
// The steps are the Node 24 docs' blob flow (https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html):
// write the preparation blob with --experimental-sea-config, copy the running node, remove the macOS signature,
// inject with postject using the documented sentinel fuse, ad-hoc sign on macOS. Run `npm run bundle` first.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const bundle = join(buildDir, "memtro.cjs");
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function fail(message) {
  console.error(`build-sea: ${message}`);
  process.exit(1);
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
}

const os = { darwin: "darwin", linux: "linux" }[process.platform];
const arch = { arm64: "arm64", x64: "x64" }[process.arch];
if (!os || !arch) fail(`no standalone build for ${process.platform}-${process.arch} (darwin and linux, arm64 and x64 only)`);
const major = Number(process.versions.node.split(".")[0]);
// The blob flow and its flags are the Node 24 line's; the blob must be built by the same node it is injected into.
if (major !== 24) fail(`build with Node 24 (this is ${process.version}): the flow here is the Node 24 one`);
if (!existsSync(bundle)) fail(`${bundle} is missing: run npm run bundle first`);

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const name = `memtro-${os}-${arch}`;
const exe = join(buildDir, name);
const tarball = join(buildDir, `${name}.tar.gz`);
const blob = join(buildDir, "sea-prep.blob");
const config = join(buildDir, "sea-config.json");

rmSync(exe, { force: true });
rmSync(tarball, { force: true });
writeFileSync(
  config,
  `${JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }, null, 2)}\n`,
);
run(process.execPath, ["--experimental-sea-config", config]);

copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (os === "darwin") run("codesign", ["--remove-signature", exe]);

const require = createRequire(import.meta.url);
const postject = join(dirname(require.resolve("postject/package.json")), "dist", "cli.js");
const injectArgs = [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SENTINEL_FUSE];
if (os === "darwin") injectArgs.push("--macho-segment-name", "NODE_SEA");
run(process.execPath, injectArgs);

if (os === "darwin") {
  // Apple silicon kills an unsigned executable; ad-hoc is enough to run, and the signature travels in the file.
  run("codesign", ["--sign", "-", exe]);
  run("codesign", ["--verify", exe]);
}

// Prove it starts and knows its version before anything is packed.
const reported = execFileSync(exe, ["--version"], { env: { PATH: process.env.PATH ?? "", MEMTRO_NO_UPDATE_CHECK: "1" }, encoding: "utf8" }).trim();
if (reported !== version) fail(`the executable reports ${JSON.stringify(reported)}, expected ${version}`);

writeFileSync(tarball, gzipSync(tarSingleFile("memtro", readFileSync(exe), 0o755), { level: 9 }));
rmSync(blob, { force: true });

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`build-sea: ${exe} (${mb(statSync(exe).size)}), ${tarball} (${mb(statSync(tarball).size)}), version ${version}`);

/**
 * A one-entry ustar archive, written here rather than by the system tar so it holds exactly one regular file and
 * nothing else (macOS tar adds AppleDouble `._` entries and pax headers for extended attributes).
 */
function tarSingleFile(fileName, data, mode) {
  const header = Buffer.alloc(512);
  const put = (text, offset, length) => header.write(text, offset, length, "utf8");
  const num = (value, offset, length) => put(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  put(fileName, 0, 100);
  num(mode, 100, 8);
  num(0, 108, 8);
  num(0, 116, 8);
  num(data.length, 124, 12);
  num(Math.floor(Number(process.env.SOURCE_DATE_EPOCH ?? Date.now() / 1000)), 136, 12);
  header.fill(0x20, 148, 156);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}
