import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { validProfileName } from "../config.js";
import { runWithInput, type RunResult } from "./run.js";
import { looksLikeKey, type CredentialStore } from "./types.js";

/**
 * The Secret Service (GNOME Keyring, KWallet) on Linux, through libsecret's `secret-tool`.
 *
 * `secret-tool store` reads the secret from stdin when stdin is not a terminal, so the key never appears in an
 * argument list; the attributes (`service memtro-cli account <profile>`) do, and they are not secret. A machine
 * with `secret-tool` installed but no running keyring (a server over SSH, a container) fails here, and the caller
 * falls back to the file store and says so.
 */

export const SERVICE = "memtro-cli";

type Runner = (command: string, args: readonly string[], input: string) => Promise<RunResult>;

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const attributes = (profile: string): string[] => {
  if (!validProfileName(profile)) throw new Error(`Invalid profile name "${profile}".`);
  return ["service", SERVICE, "account", profile];
};

export function secretToolStore(binary: string, run: Runner = runWithInput): CredentialStore {
  const problem = (op: string, r: RunResult) => new Error(`The Secret Service refused to ${op} the key: ${r.stderr.trim() || `exit status ${r.code}`}`);
  return {
    kind: "secret-tool",
    where: "the Secret Service keyring (secret-tool)",
    async get(profile) {
      const r = await run(binary, ["lookup", ...attributes(profile)], "");
      const value = r.stdout.trim();
      // `lookup` exits 1 with nothing on either stream when there is no such item.
      if (r.code !== 0 && !value && !r.stderr.trim()) return null;
      if (r.code !== 0) throw problem("read", r);
      if (!value) return null;
      if (!looksLikeKey(value)) throw new Error(`The keyring item for profile "${profile}" does not hold a Memtro key. Run \`memtro logout\` and sign in again.`);
      return value;
    },
    async set(profile, key) {
      if (!looksLikeKey(key)) throw new Error("That does not look like a Memtro API key; not storing it.");
      const r = await run(binary, ["store", `--label=Memtro CLI (${profile})`, ...attributes(profile)], key);
      if (r.code !== 0) throw problem("store", r);
    },
    async delete(profile) {
      const had = (await this.get(profile).catch(() => null)) !== null;
      const r = await run(binary, ["clear", ...attributes(profile)], "");
      if (r.code !== 0 && r.stderr.trim()) throw problem("delete", r);
      return had;
    },
  };
}
