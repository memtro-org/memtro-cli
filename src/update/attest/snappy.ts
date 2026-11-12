/**
 * Snappy block format decoder (https://github.com/google/snappy/blob/main/format_description.txt). GitHub serves an
 * attestation's `bundle_url` as Snappy-compressed JSON (cli/cli decodes it with `snappy.Decode`). Every length and
 * offset is checked; the declared size is checked against `maxOut` before anything is allocated.
 */

export class SnappyError extends Error {}

export function snappyDecode(src: Buffer, maxOut: number): Buffer {
  let pos = 0;
  let len = 0;
  for (let shift = 0; ; shift += 7) {
    if (pos >= src.length || shift > 28) throw new SnappyError("bad length header");
    const b = src[pos++]!;
    len += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
  }
  if (len > maxOut) throw new SnappyError("decompresses to more than allowed");
  const out = Buffer.alloc(len);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++]!;
    const type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const k = n - 59;
        if (pos + k > src.length) throw new SnappyError("truncated literal length");
        n = 0;
        for (let i = 0; i < k; i++) n += src[pos + i]! * 2 ** (8 * i);
        pos += k;
      }
      n += 1;
      if (pos + n > src.length || o + n > len) throw new SnappyError("literal overruns");
      src.copy(out, o, pos, pos + n);
      pos += n;
      o += n;
      continue;
    }
    let n: number;
    let off: number;
    if (type === 1) {
      if (pos + 1 > src.length) throw new SnappyError("truncated copy");
      n = ((tag >> 2) & 7) + 4;
      off = ((tag >> 5) << 8) | src[pos]!;
      pos += 1;
    } else if (type === 2) {
      if (pos + 2 > src.length) throw new SnappyError("truncated copy");
      n = (tag >> 2) + 1;
      off = src.readUInt16LE(pos);
      pos += 2;
    } else {
      if (pos + 4 > src.length) throw new SnappyError("truncated copy");
      n = (tag >> 2) + 1;
      off = src.readUInt32LE(pos);
      pos += 4;
    }
    if (off === 0 || off > o || o + n > len) throw new SnappyError("bad copy");
    for (let i = 0; i < n; i++, o++) out[o] = out[o - off]!;
  }
  if (o !== len) throw new SnappyError("shorter than its declared length");
  return out;
}
