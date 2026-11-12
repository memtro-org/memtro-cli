#!/usr/bin/env node
// Smoke-tests a built executable: node scripts/smoke-sea.mjs <executable> <expected version>
//   --version prints exactly the expected version; --help exits 0; whoami with no credential exits 3.
// It runs with no Memtro key, a throwaway HOME and config, and a base URL nothing listens on.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [exe, version] = process.argv.slice(2);
if (!exe || !version) {
  console.error("usage: smoke-sea.mjs <executable> <version>");
  process.exit(2);
}
const home = mkdtempSync(join(tmpdir(), "memtro-smoke-"));
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_STATE_HOME: join(home, "state"),
  MEMTRO_CREDENTIALS: "file",
  MEMTRO_BASE_URL: "http://127.0.0.1:9",
  MEMTRO_RELEASE_BASE: "http://127.0.0.1:9",
  MEMTRO_NO_UPDATE_CHECK: "1",
};
let failed = false;
function check(args, expectStatus, expectStdout) {
  const started = process.hrtime.bigint();
  const r = spawnSync(exe, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const ok = r.status === expectStatus && (expectStdout === undefined || r.stdout.trim() === expectStdout);
  const shown = ok && expectStdout !== undefined ? `: ${r.stdout.trim()}` : "";
  console.log(`${ok ? "ok  " : "FAIL"} memtro ${args.join(" ")}: exit ${r.status} in ${ms.toFixed(0)} ms${shown}${ok ? "" : `\n${r.stdout}${r.stderr}${r.error ?? ""}`}`);
  if (!ok) failed = true;
}
check(["--version"], 0, version);
check(["--version"], 0, version);
check(["--help"], 0);
check(["whoami"], 3);
rmSync(home, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
