/**
 * A unified diff, line based, with no dependency. Small on purpose: it is for a person to read before saying yes
 * and for the model to see what it changed, not for `patch`.
 *
 * Common leading and trailing lines are trimmed first (an edit touches a few lines of a long file), then the
 * middle is aligned with a longest-common-subsequence table when that is cheap enough, and shown as one
 * replacement when it is not. The result is capped; a cut says so.
 */

export const CONTEXT_LINES = 3;
export const MAX_DIFF_LINES = 400;
const MAX_LCS_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; text: string; a: number; b: number };

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function align(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: " ", text: a[i]!, a: i, b: i });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length <= MAX_LCS_CELLS && midA.length > 0 && midB.length > 0) {
    const n = midA.length;
    const m = midB.length;
    // lcs[i][j] = LCS length of midA[i..] and midB[j..], flattened.
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * (m + 1) + j] = midA[i] === midB[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ kind: " ", text: midA[i]!, a: start + i, b: start + j });
        i++;
        j++;
      } else if (j < m && (i >= n || lcs[i * (m + 1) + j + 1]! >= lcs[(i + 1) * (m + 1) + j]!)) {
        ops.push({ kind: "+", text: midB[j]!, a: start + i, b: start + j });
        j++;
      } else {
        ops.push({ kind: "-", text: midA[i]!, a: start + i, b: start + j });
        i++;
      }
    }
  } else {
    midA.forEach((text, i) => ops.push({ kind: "-", text, a: start + i, b: start }));
    midB.forEach((text, j) => ops.push({ kind: "+", text, a: endA, b: start + j }));
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ kind: " ", text: a[i]!, a: i, b: j });
  return reorder(ops);
}

/** Within each run of changed lines, removals first, then additions. */
function reorder(ops: Op[]): Op[] {
  const out: Op[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === " ") {
      out.push(ops[i]!);
      i++;
      continue;
    }
    const run: Op[] = [];
    while (i < ops.length && ops[i]!.kind !== " ") run.push(ops[i++]!);
    out.push(...run.filter((o) => o.kind === "-"), ...run.filter((o) => o.kind === "+"));
  }
  return out;
}

export interface DiffOptions {
  context?: number;
  maxLines?: number;
}

/** A unified diff of `before` → `after` for `path`, or "" when they are the same. `before` null means a new file. */
export function unifiedDiff(path: string, before: string | null, after: string, opts: DiffOptions = {}): string {
  if (before === after) return "";
  const context = opts.context ?? CONTEXT_LINES;
  const maxLines = opts.maxLines ?? MAX_DIFF_LINES;
  const a = splitLines((before ?? "").replace(/\r\n/g, "\n"));
  const b = splitLines(after.replace(/\r\n/g, "\n"));
  const ops = align(a, b);

  // Group changes into hunks with `context` lines either side.
  const changed = ops.map((o, i) => (o.kind === " " ? -1 : i)).filter((i) => i >= 0);
  const lines: string[] = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  if (changed.length === 0) {
    // Only line endings or a final newline differ.
    lines.push("@@ line endings or the final newline changed @@");
    return lines.join("\n");
  }
  let h = 0;
  let total = 0;
  while (h < changed.length) {
    const from = Math.max(0, changed[h]! - context);
    let to = Math.min(ops.length - 1, changed[h]! + context);
    let k = h + 1;
    while (k < changed.length && changed[k]! - context <= to + 1) {
      to = Math.min(ops.length - 1, changed[k]! + context);
      k++;
    }
    const hunk = ops.slice(from, to + 1);
    const aStart = hunk.find((o) => o.kind !== "+")?.a ?? hunk[0]!.a;
    const bStart = hunk.find((o) => o.kind !== "-")?.b ?? hunk[0]!.b;
    const aCount = hunk.filter((o) => o.kind !== "+").length;
    const bCount = hunk.filter((o) => o.kind !== "-").length;
    lines.push(`@@ -${aCount ? aStart + 1 : aStart},${aCount} +${bCount ? bStart + 1 : bStart},${bCount} @@`);
    for (const o of hunk) {
      if (total >= maxLines) {
        const left = ops.slice(ops.indexOf(o)).filter((x) => x.kind !== " ").length;
        lines.push(`[diff cut: ${left} more changed line${left === 1 ? "" : "s"} not shown]`);
        return lines.join("\n");
      }
      lines.push(`${o.kind}${o.text.length > 500 ? `${o.text.slice(0, 500)}…` : o.text}`);
      total++;
    }
    h = k;
  }
  return lines.join("\n");
}

/** Lines added and removed, for a one-line summary. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
