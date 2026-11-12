/**
 * Shared by the test/md-*.test.ts files: the checks every rendering must pass, measured with the screen's own width
 * module (src/tui/full/screen/width.ts), and a simple stand-in measure for the test that the measure is injectable.
 */
import assert from "node:assert/strict";
import type { Line, Style } from "../../../src/tui/full/types.js";
import type { Measure } from "../../../src/tui/md/measure.js";
import { lineWidth } from "../../../src/tui/full/screen/width.js";
import { renderMarkdown, renderMarkdownGroups } from "../../../src/tui/md/index.js";

const WIDE = new Set([..."界日本語中文字漢😀🎉表"].map((c) => c.codePointAt(0)!));

/** One cell per code point, two for a handful of CJK characters and emoji: simple enough to reason about. */
export const standIn: Measure = {
  graphemes: (text) => Array.from(text),
  displayWidth: (text) => {
    let w = 0;
    for (const ch of text) w += WIDE.has(ch.codePointAt(0)!) ? 2 : 1;
    return w;
  },
};

/** Cells a line takes on the real screen. */
export const width = (line: Line): number => lineWidth(line);

export const plain = (lines: Line[]): string => lines.map((l) => l.map((s) => s.text).join("")).join("\n");

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Every line fits, and no span carries a newline, tab or control character. */
export function assertFits(lines: Line[], w: number, label = ""): void {
  lines.forEach((line, i) => {
    assert.ok(width(line) <= w, `${label} line ${i} is ${width(line)} wide, more than ${w}: ${JSON.stringify(line.map((s) => s.text).join(""))}`);
    for (const span of line) {
      assert.ok(!CONTROL.test(span.text), `${label} line ${i} carries a control character: ${JSON.stringify(span.text)}`);
      if (span.style?.link) assert.match(span.style.link, /^(https?:|mailto:)/, `${label} link ${span.style.link}`);
    }
  });
}

export function md(source: string, w = 60, streaming = false): Line[] {
  const lines = renderMarkdown(source, { width: w, streaming });
  assertFits(lines, w);
  return lines;
}

export function groups(source: string, w = 60, streaming = true): Line[][] {
  return renderMarkdownGroups(source, { width: w, streaming });
}

/** The spans whose text contains `needle`, with their styles. */
export function stylesOf(lines: Line[], needle: string): (Style | undefined)[] {
  const out: (Style | undefined)[] = [];
  for (const l of lines) for (const s of l) if (s.text.includes(needle)) out.push(s.style);
  return out;
}

/**
 * Milliseconds of CPU the main thread spent running `fn` (`process.threadCpuUsage`, Node 23.9 and later; wall time
 * where it is missing). The scaling checks measure this rather than wall time: on a loaded machine a long render is
 * preempted more often than a short one, which inflates a wall-time ratio, and the whole process's CPU would count
 * the garbage collector's and compiler's helper threads, which come in bursts.
 */
export function cpuMs(fn: () => void): number {
  const thread = (process as { threadCpuUsage?: (prev?: NodeJS.CpuUsage) => NodeJS.CpuUsage }).threadCpuUsage;
  if (!thread) {
    const t = performance.now();
    fn();
    return performance.now() - t;
  }
  const start = thread.call(process);
  fn();
  const d = thread.call(process, start);
  return (d.user + d.system) / 1000;
}
