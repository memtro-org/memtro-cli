import { existsSync } from "node:fs";
import { validProfileName } from "../config.js";
import { runWithInput, type RunResult } from "./run.js";
import { looksLikeKey, type CredentialStore } from "./types.js";

/**
 * The macOS Keychain, through `/usr/bin/security`, without the key ever appearing in an argument list.
 *
 * `security add-generic-password -w <key>` is the documented way and the wrong one: for as long as the process
 * runs, `ps -ww` shows the key to every user on the machine. `-w` with no value prompts for it instead, but on
 * the controlling terminal, not on stdin, so it cannot be driven from here.
 *
 * `security -i` reads whole commands from stdin ("enter multiple commands on stdin; when EOF is read, security
 * will exit" — man security), and that is what this uses: the process is started as `security -i` and nothing
 * else, and the command, including the secret, arrives on the pipe. The key is written with `-X`, the hex form,
 * so what crosses the pipe is [0-9a-f] and the command parser never sees a character it could read as quoting.
 *
 * Everything else interpolated into the stream (the profile name, the service, the label) goes through `quoted`,
 * which refuses any character outside a short safe set rather than trying to escape it. Profile names are
 * already restricted to [a-z0-9_-]; the check here is the second lock on the same door.
 *
 * Reading back uses `find-generic-password -w`, which prints the password alone; exit status 44 is
 * errSecItemNotFound (-25300) and means "no key", which is not the same thing as "could not ask".
 */

export const SECURITY = "/usr/bin/security";
export const SERVICE = "memtro-cli";
const NOT_FOUND = 44;

const SAFE = /^[A-Za-z0-9 ._()-]*$/;

/** A double-quoted token for the `security -i` command stream. Throws rather than escaping. */
export function quoted(value: string): string {
  if (!SAFE.test(value)) throw new Error("Refusing to put an unexpected character into the keychain command stream.");
  return `"${value}"`;
}

const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");

function checkProfile(profile: string): void {
  if (!validProfileName(profile)) throw new Error(`Invalid profile name "${profile}".`);
}

/** The exact line sent to `security -i` for each operation. Pure, so the escaping is tested without a keychain. */
export const keychainCommand = {
  set(profile: string, key: string): string {
    checkProfile(profile);
    if (!looksLikeKey(key)) throw new Error("That does not look like a Memtro API key; not storing it.");
    return `add-generic-password -U -a ${quoted(profile)} -s ${quoted(SERVICE)} -l ${quoted(`Memtro CLI (${profile})`)} -X ${quoted(hex(key))}\n`;
  },
  get(profile: string): string {
    checkProfile(profile);
    return `find-generic-password -a ${quoted(profile)} -s ${quoted(SERVICE)} -w\n`;
  },
  delete(profile: string): string {
    checkProfile(profile);
    return `delete-generic-password -a ${quoted(profile)} -s ${quoted(SERVICE)}\n`;
  },
};

/** The argument list the process is started with. Never contains anything but the interactive flag. */
export const KEYCHAIN_ARGS: readonly string[] = ["-i"];

type Runner = (command: string, args: readonly string[], input: string) => Promise<RunResult>;

/** What `security` said went wrong, without anything it might have echoed back from the command. */
function failure(op: string, result: RunResult): Error {
  const said = result.stderr.split("\n").find((l) => l.trim() && !l.includes("-X")) ?? `exit status ${result.code}`;
  return new Error(`The macOS Keychain refused to ${op} the key: ${said.trim()}`);
}

export function keychainAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && existsSync(SECURITY);
}

export function keychainStore(run: Runner = runWithInput): CredentialStore {
  return {
    kind: "keychain",
    where: `the macOS Keychain (service "${SERVICE}")`,
    async get(profile) {
      const result = await run(SECURITY, KEYCHAIN_ARGS, keychainCommand.get(profile));
      if (result.code === NOT_FOUND) return null;
      if (result.code !== 0) throw failure("read", result);
      const value = result.stdout.replace(/^security> /gm, "").trim();
      if (!value) return null;
      if (!looksLikeKey(value)) throw new Error(`The Keychain item for profile "${profile}" does not hold a Memtro key. Run \`memtro logout\` and sign in again.`);
      return value;
    },
    async set(profile, key) {
      const result = await run(SECURITY, KEYCHAIN_ARGS, keychainCommand.set(profile, key));
      if (result.code !== 0) throw failure("store", result);
    },
    async delete(profile) {
      const result = await run(SECURITY, KEYCHAIN_ARGS, keychainCommand.delete(profile));
      if (result.code === NOT_FOUND) return false;
      if (result.code !== 0) throw failure("delete", result);
      return true;
    },
  };
}
