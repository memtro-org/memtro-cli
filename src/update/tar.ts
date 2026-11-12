import { createReadStream, type WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { createGunzip } from "node:zlib";

/**
 * A deliberately narrow tar reader for the release tarball: exactly one regular file with the expected name, in
 * ustar or plain v7 format, and nothing else. Every other entry type (directories, links, pax or GNU extension
 * headers, devices), any path with a slash, `..` or a leading `/`, and a second entry are refused, so a tarball
 * can never write anywhere but the one file the caller opened.
 */

const BLOCK = 512;
/** The executable is about 120 MB; anything far larger is not ours. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

export class TarError extends Error {}

interface Header {
  name: string;
  size: number;
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(block: Buffer, start: number, length: number, what: string): number {
  const text = field(block, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new TarError(`the archive's ${what} field is not a number`);
  return parseInt(text, 8);
}

function parseHeader(block: Buffer): Header {
  const stored = octal(block, 148, 8, "checksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  if (sum !== stored) throw new TarError("the archive's header checksum does not match");
  const type = String.fromCharCode(block[156]!);
  if (type !== "0" && type !== "\0") throw new TarError(`the archive holds something other than a regular file (type ${JSON.stringify(type)})`);
  let name = field(block, 0, 100);
  if (field(block, 257, 6) === "ustar") {
    const prefix = field(block, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
  }
  if (name.startsWith("./")) name = name.slice(2);
  if (name === "" || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new TarError(`the archive holds an unexpected path: ${JSON.stringify(name)}`);
  }
  const size = octal(block, 124, 12, "size");
  if (size > MAX_ENTRY_BYTES) throw new TarError("the archive's file is implausibly large");
  return { name, size };
}

function writeChunk(out: WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Reads the gzip-compressed tarball at `archive` and writes its single entry, which must be named `expectedName`,
 * to `dest` (created exclusively, so it never follows or overwrites anything), with `mode`. Throws `TarError` for
 * anything the archive should not contain; the caller removes `dest` on failure.
 */
export async function extractSingleFile(archive: string, expectedName: string, dest: string, mode: number, maxInflated = MAX_ENTRY_BYTES + 64 * BLOCK): Promise<void> {
  const handle = await open(dest, "wx", mode);
  const out = handle.createWriteStream();
  const closed = new Promise<void>((resolve, reject) => {
    out.once("close", resolve);
    out.once("error", reject);
  });
  let pending: Buffer = Buffer.alloc(0);
  type State = "header" | "data" | "padding" | "trailer";
  let state = "header" as State;
  let remaining = 0;
  let padding = 0;
  let found = false;
  try {
    const stream = createReadStream(archive).pipe(createGunzip());
    let inflated = 0;
    for await (const piece of stream as AsyncIterable<Buffer>) {
      // A small archive that inflates without end (a run of zero blocks after the entry) is refused, not read forever.
      inflated += piece.length;
      if (inflated > maxInflated) throw new TarError("the archive inflates to far more than one executable");
      pending = pending.length ? Buffer.concat([pending, piece]) : piece;
      for (;;) {
        if (state === "data") {
          if (!pending.length) break;
          const take = Math.min(remaining, pending.length);
          await writeChunk(out, pending.subarray(0, take));
          pending = pending.subarray(take);
          remaining -= take;
          if (remaining === 0) state = "padding";
          continue;
        }
        if (state === "padding") {
          const take = Math.min(padding, pending.length);
          pending = pending.subarray(take);
          padding -= take;
          if (padding === 0) state = "header";
          else break;
          continue;
        }
        if (pending.length < BLOCK) break;
        const block = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (block.every((b) => b === 0)) {
          state = "trailer";
          continue;
        }
        if (state === "trailer") throw new TarError("the archive has data after its end marker");
        if (found) throw new TarError("the archive holds more than one entry");
        const header = parseHeader(Buffer.from(block));
        if (header.name !== expectedName) throw new TarError(`the archive holds ${JSON.stringify(header.name)}, not ${JSON.stringify(expectedName)}`);
        found = true;
        remaining = header.size;
        padding = (BLOCK - (header.size % BLOCK)) % BLOCK;
        state = remaining > 0 ? "data" : padding > 0 ? "padding" : "header";
      }
    }
    if (!found) throw new TarError(`the archive does not hold ${JSON.stringify(expectedName)}`);
    if (state === "data" || state === "padding") throw new TarError("the archive ends in the middle of its file");
  } finally {
    out.end();
    await closed;
  }
}
