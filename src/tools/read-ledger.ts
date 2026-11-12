import { statSync } from "node:fs";

/**
 * Which files the model has read this session, and what they looked like then.
 *
 * `edit` and `write` (over an existing file) are refused unless the file is here and its mtime and size still
 * match: the model must have seen the current contents before changing them, or it is editing from memory of a
 * file somebody (or a formatter, or a `bash` call) has since changed. Keyed by the real path, so two spellings of
 * one file are one entry. A successful edit or write records the new state, so consecutive edits work.
 */

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export type LedgerCheck = { ok: true } | { ok: false; reason: "not-read" | "changed" | "missing" };

export class ReadLedger {
  private readonly seen = new Map<string, FileStamp>();

  record(realPath: string, stamp: FileStamp): void {
    this.seen.set(realPath, { mtimeMs: stamp.mtimeMs, size: stamp.size });
  }

  /** Records the file as it is on disk now. */
  recordNow(realPath: string): void {
    const s = statSync(realPath);
    this.record(realPath, { mtimeMs: s.mtimeMs, size: s.size });
  }

  has(realPath: string): boolean {
    return this.seen.has(realPath);
  }

  check(realPath: string): LedgerCheck {
    const before = this.seen.get(realPath);
    if (!before) return { ok: false, reason: "not-read" };
    let now: FileStamp;
    try {
      now = statSync(realPath);
    } catch {
      return { ok: false, reason: "missing" };
    }
    return now.mtimeMs === before.mtimeMs && now.size === before.size ? { ok: true } : { ok: false, reason: "changed" };
  }
}
