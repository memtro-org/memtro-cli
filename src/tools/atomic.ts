import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * Writing a file so a reader never sees half of it: a temporary file in the same directory (so the rename is on
 * one filesystem and atomic), flushed, given the old file's mode, then renamed over the target. `target` must be
 * the real path: renaming over a symlink would replace the link rather than the file it points to.
 */
export function writeAtomic(target: string, content: string): void {
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  let mode: number | null = null;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {
    // a new file: the umask decides, as for any other
  }
  const temp = path.join(dir, `.${path.basename(target)}.memtro-${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", mode ?? 0o666);
  try {
    try {
      writeSync(fd, content, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (mode !== null) chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // already gone
    }
    throw err;
  }
}

export type Eol = "\n" | "\r\n";

/** The file's line ending: CRLF when most of its line breaks are CRLF. */
export function detectEol(text: string): Eol {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

export const toLf = (s: string) => s.replace(/\r\n/g, "\n");
export const fromLf = (s: string, eol: Eol) => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);
