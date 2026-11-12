#!/usr/bin/env node
// Writes checksums.txt and latest.json for a release, from the tarballs in a directory:
//   node scripts/release-manifest.mjs <dir> <version>
// checksums.txt: `sha256  filename`, one line per tarball (sha256sum's format, which install.sh and the updater read).
// latest.json:   { version, tag, published, assets: { "<os>-<arch>": { file, sha256 } } }
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version] = process.argv.slice(2);
if (!dir || !version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: release-manifest.mjs <dir> <x.y.z>");
  process.exit(2);
}
const expected = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const tarballs = readdirSync(dir)
  .filter((f) => /^memtro-(darwin|linux)-(arm64|x64)\.tar\.gz$/.test(f))
  .sort();
if (!tarballs.length) {
  console.error(`release-manifest: no memtro-<os>-<arch>.tar.gz in ${dir}`);
  process.exit(1);
}
const missing = expected.filter((t) => !tarballs.includes(`memtro-${t}.tar.gz`));
if (missing.length && process.env.ALLOW_MISSING !== "1") {
  console.error(`release-manifest: missing builds: ${missing.join(", ")}`);
  process.exit(1);
}

const assets = {};
const lines = [];
for (const file of tarballs) {
  const sha256 = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
  const target = file.slice("memtro-".length, -".tar.gz".length);
  assets[target] = { file, sha256 };
  lines.push(`${sha256}  ${file}`);
}
writeFileSync(join(dir, "checksums.txt"), `${lines.join("\n")}\n`);
const manifest = { version, tag: `v${version}`, published: new Date().toISOString(), assets };
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`release-manifest: ${tarballs.length} tarballs, checksums.txt and latest.json for v${version}`);
