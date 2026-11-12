#!/usr/bin/env node
// Bundles the CLI into one CommonJS file, build/memtro.cjs, the input to the single executable (scripts/build-sea.mjs).
// Node's single executable runs one CommonJS script that can require built-in modules only (Node 24 docs), so
// everything else has to be inside this file. Entry: src/main.ts, the same entry the npm `bin` uses.
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "build", "memtro.cjs");
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // Readable output: stack traces from a user's machine should name real functions.
  minify: false,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "silent",
});

// Any warning fails the build: the one that matters (`import.meta` is empty in CommonJS) produced a program that
// silently did nothing.
const problems = [...result.errors, ...result.warnings];
if (problems.length) {
  for (const p of problems) console.error(`bundle: ${p.text}${p.location ? ` (${p.location.file}:${p.location.line})` : ""}`);
  process.exit(1);
}

// Zero runtime dependencies: the only things left outside the bundle may be Node built-ins.
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const external = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imp of output.imports) if (imp.external && !builtins.has(imp.path)) external.add(imp.path);
}
if (external.size) {
  console.error(`bundle: non-built-in imports left outside the bundle: ${[...external].join(", ")}`);
  process.exit(1);
}

const bytes = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].bytes;
console.log(`bundle: ${outfile} (${(bytes / 1024).toFixed(0)} KB)`);
