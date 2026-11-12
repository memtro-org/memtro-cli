/**
 * The size rule every tool result follows: at most 2000 lines and 50 KB reach the model, and a cut is always
 * said, with how much was left out and how to get it.
 */

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
/** A single line longer than this is cut where it is shown. */
export const MAX_LINE_CHARS = 2000;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

export function cutLine(line: string, max = MAX_LINE_CHARS): string {
  return line.length > max ? `${line.slice(0, max)}… [line cut: ${line.length - max} more characters]` : line;
}

export interface Cut {
  text: string;
  /** Lines left out (whole or partial). */
  omittedLines: number;
  omittedBytes: number;
}

/** The first lines that fit. */
export function head(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Cut {
  const lines = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const add = bytes(line) + 1;
    if (kept.length >= maxLines || size + add > maxBytes) break;
    kept.push(line);
    size += add;
  }
  const rest = lines.slice(kept.length);
  if (kept.length === 0 && lines.length > 0 && lines[0]!.length > 0) {
    // One enormous line: keep its start rather than nothing.
    const first = truncateBytes(lines[0]!, maxBytes);
    return { text: first, omittedLines: lines.length, omittedBytes: bytes(text) - bytes(first) };
  }
  return { text: kept.join("\n"), omittedLines: rest.length, omittedBytes: rest.length ? bytes(rest.join("\n")) + 1 : 0 };
}

/** The last lines that fit. */
export function tail(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Cut {
  const lines = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = bytes(lines[i]!) + 1;
    if (kept.length >= maxLines || size + add > maxBytes) break;
    kept.unshift(lines[i]!);
    size += add;
  }
  const dropped = lines.length - kept.length;
  if (kept.length === 0 && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    const end = last.length > maxBytes ? last.slice(last.length - maxBytes) : last;
    return { text: end, omittedLines: dropped, omittedBytes: bytes(text) - bytes(end) };
  }
  return { text: kept.join("\n"), omittedLines: dropped, omittedBytes: dropped ? bytes(lines.slice(0, dropped).join("\n")) + 1 : 0 };
}

export function truncateBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Back off to a character boundary.
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

/** A text result capped from the top, with the closing line saying what was cut and what to do about it. */
export function capText(text: string, howToGetMore: string): string {
  const cut = head(text);
  if (cut.omittedLines === 0 && cut.omittedBytes === 0) return text;
  return `${cut.text}\n[Output cut: ${cut.omittedLines} more line${cut.omittedLines === 1 ? "" : "s"} (${kb(cut.omittedBytes)}) not shown. ${howToGetMore}]`;
}
