/** Unified diffs: headers, hunks, line numbers, full-width backgrounds, changed spans, wrapping, cleaning. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDiff } from "../src/tui/md/index.js";
import { assertFits, plain, width } from "./fixtures/md/helpers.js";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 123..456 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -8,4 +8,5 @@ export function main() {
 const a = 1;
-const total = compute(a, 2);
+const total = compute(a, 3);
+console.log(total);
 return total;
\\ No newline at end of file
 }
`;

test("file headers, hunk headers, context, added and removed rows, with old and new line numbers", () => {
  const lines = renderDiff(DIFF, { width: 50 });
  assertFits(lines, 50);
  assert.deepEqual(plain(lines).split("\n").map((l) => l.trimEnd()), [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 123..456 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -8,4 +8,5 @@ export function main() {",
    " 8  8   const a = 1;",
    " 9    - const total = compute(a, 2);",
    "    9 + const total = compute(a, 3);",
    "   10 + console.log(total);",
    "10 11   return total;",
    "\\ No newline at end of file",
    "11 12   }",
  ]);
  assert.equal(lines[0]![0]!.style?.fg, "muted");
  assert.equal(lines[2]![0]!.style?.bold, true);
  assert.equal(lines[4]![0]!.style?.fg, "info");
  assert.equal(lines[10]![0]!.style?.italic, true);
});

test("added and removed rows carry their background across the full width; the gutter is muted", () => {
  const lines = renderDiff(DIFF, { width: 50 });
  const removed = lines[6]!;
  const added = lines[8]!;
  assert.equal(width(removed), 50);
  assert.equal(width(added), 50);
  assert.ok(removed.every((s) => s.style?.bg === "removedBg" || s.style?.bg === "removed"));
  assert.ok(added.every((s) => s.style?.bg === "addedBg"));
  assert.equal(removed[0]!.style?.fg, "muted");
  assert.equal(removed.find((s) => s.text === "- ")?.style?.fg, "removed");
  assert.equal(added.find((s) => s.text === "+ ")?.style?.fg, "added");
  // Context rows have no background.
  assert.ok(lines[5]!.every((s) => !s.style?.bg));
});

test("the changed span of a similar replaced pair is picked out; dissimilar pairs are not", () => {
  const lines = renderDiff(DIFF, { width: 50 });
  const changedOld = lines[6]!.find((s) => s.style?.bg === "removed");
  const changedNew = lines[7]!.find((s) => s.style?.bg === "added");
  assert.equal(changedOld?.text, "2");
  assert.equal(changedNew?.text, "3");
  const other = renderDiff("@@ -1 +1 @@\n-alpha beta gamma\n+completely different", { width: 50 });
  assert.ok(other.flat().every((s) => s.style?.bg !== "removed" && s.style?.bg !== "added"));
});

test("long lines wrap with a continuation marker and keep their background", () => {
  const lines = renderDiff(DIFF, { width: 20 });
  assertFits(lines, 20);
  const cont = lines.filter((l) => l.some((s) => s.text.includes("↪")));
  assert.ok(cont.length >= 3);
  assert.ok(lines.every((l) => width(l) <= 20));
  const wrappedAdded = lines.find((l) => l.some((s) => s.text.includes("↪")) && l.some((s) => s.style?.bg === "addedBg"));
  assert.ok(wrappedAdded && width(wrappedAdded) === 20);
  // The text survives whole across the pieces.
  assert.match(plain(lines).replace(/\n *↪ /g, ""), /console\.log\(total\);/);
});

test("a diff without hunk headers is read by its markers, with no numbers", () => {
  const lines = renderDiff("-old line\n+new line\n same", { width: 30 });
  assert.deepEqual(plain(lines).split("\n").map((l) => l.trimEnd()), ["- old line", "+ new line", "  same"]);
});

test("narrow and degenerate widths still return lines that fit, and nothing throws", () => {
  for (const w of [1, 2, 5, 6, 10, 19, 21]) assertFits(renderDiff(DIFF, { width: w }), Math.max(1, w), `w${w}`);
  assert.deepEqual(renderDiff("", { width: 40 }), []);
  assertFits(renderDiff("@@ -x +y @@\n@@\n+\n-\n\\", { width: 10 }), 10);
});

test("everything is cleaned: escapes, controls and bidi characters never reach a span", () => {
  const nasty = "--- a/\u001b[31mfile\n+++ b/file\u0007\n@@ -1 +1 @@ \u001b]0;title\u0007\n-old\u001b[2J\n+new‮\u0000\n \tctx\r\n";
  const lines = renderDiff(nasty, { width: 60 });
  assertFits(lines, 60);
  for (const s of lines.flat()) assert.ok(!/[\u0000-\u001f\u007f-\u009f‪-‮]/.test(s.text), JSON.stringify(s.text));
  assert.match(plain(lines), /ctx/);
});

test("a huge line pair is fast", () => {
  const t = performance.now();
  renderDiff(`@@ -1,1 +1,1 @@\n-${"a".repeat(100_000)}\n+${"a".repeat(99_999)}b`, { width: 80 });
  assert.ok(performance.now() - t < 1000);
});
