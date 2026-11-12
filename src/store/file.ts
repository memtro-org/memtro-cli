import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, validProfileName } from "../config.js";
import { looksLikeKey, type CredentialStore } from "./types.js";

/**
 * A file, for where there is no keychain: a Linux server, a container, Windows, or MEMTRO_CREDENTIALS=file.
 *
 * `credentials.json` beside the config, created 0600 in a 0700 directory. It refuses to READ a file that group or
 * others can read, the way ssh refuses a private key with loose permissions: a key that has been world-readable
 * may already have been copied, and quietly using it would hide that. The fix is a chmod, and the message says so.
 *
 * Written through a temporary file opened with mode 0600 from the start (never created and then narrowed, which
 * leaves a window) and renamed into place.
 *
 * On Windows mode bits do not exist, so the permission check is skipped; the file sits in the user's own
 * %APPDATA%, which is what every other CLI on that platform relies on too.
 */

interface CredentialsFile {
  version: 1;
  keys: Record<string, string>;
}

export const credentialsPath = (dir: string): string => join(dir, "credentials.json");

/** True when group or others have any access. Pure, for the test. */
export function tooOpen(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

export function fileStore(dir: string, platform: NodeJS.Platform = process.platform): CredentialStore {
  const path = credentialsPath(dir);
  const checkMode = platform !== "win32";

  const read = (): CredentialsFile => {
    let mode: number;
    try {
      mode = statSync(path).mode;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: {} };
      throw err;
    }
    if (checkMode && tooOpen(mode)) {
      throw new Error(`${path} can be read by other users (mode ${(mode & 0o777).toString(8)}), so it is not being used. Run \`chmod 600 ${path}\`, and consider the key in it exposed: \`memtro logout\` then \`memtro\` signs in with a new one.`);
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialsFile>;
      return { version: 1, keys: parsed.keys && typeof parsed.keys === "object" ? parsed.keys : {} };
    } catch {
      throw new Error(`${path} is not valid JSON. Delete it and run \`memtro\` to sign in again.`);
    }
  };

  const write = (file: CredentialsFile): void => {
    ensureDir(dir);
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // `open`'s mode is filtered through the umask, which can only remove bits; set it exactly regardless.
    if (checkMode) chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };

  const check = (profile: string) => {
    if (!validProfileName(profile)) throw new Error(`Invalid profile name "${profile}".`);
  };

  return {
    kind: "file",
    where: path,
    async get(profile) {
      check(profile);
      const value = read().keys[profile];
      if (!value) return null;
      if (!looksLikeKey(value)) throw new Error(`${path} holds something for profile "${profile}" that is not a Memtro key. Run \`memtro logout\` and sign in again.`);
      return value;
    },
    async set(profile, key) {
      check(profile);
      if (!looksLikeKey(key)) throw new Error("That does not look like a Memtro API key; not storing it.");
      const file = read();
      file.keys[profile] = key;
      write(file);
    },
    async delete(profile) {
      check(profile);
      const file = read();
      if (!(profile in file.keys)) return false;
      delete file.keys[profile];
      if (Object.keys(file.keys).length === 0) {
        try {
          unlinkSync(path);
        } catch {
          write(file);
        }
      } else {
        write(file);
      }
      return true;
    },
  };
}
