#!/usr/bin/env node
// The program's entry point: the npm `bin` (dist/main.js) and the standalone executable's bundle both start here.
// It always runs. There is deliberately no "was I invoked directly" test: in a CommonJS bundle `import.meta.url` is
// empty and in a single executable `process.argv[1]` is not a script path, so any such test silently does nothing.
import { run } from "./cli.js";

async function main(): Promise<void> {
  // A closed pipe (`memtro search x | head -1`) is the reader's choice, not an error worth a stack trace.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });
  const code = await run({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
  // exitCode rather than exit(): exit() can cut off output still queued for a pipe on macOS.
  process.exitCode = code;
}

void main();
