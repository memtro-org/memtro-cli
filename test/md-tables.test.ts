/** GitHub tables: sizing, fair shrinking with wrapping, alignment, escapes, ragged rows, wide characters, stacking. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { displayWidth } from "../src/tui/full/screen/width.js";
import { fitColumns } from "../src/tui/md/table.js";
import { md, plain, stylesOf } from "./fixtures/md/helpers.js";

const rows = (src: string, w = 60): string[] => plain(md(src, w)).split("\n");

/** Display columns at which `│` appears in a row. */
function bars(row: string): number[] {
  const out: number[] = [];
  let col = 0;
  for (const ch of row) {
    if (ch === "│" || ch === "┼") out.push(col);
    col += displayWidth(ch);
  }
  return out;
}

test("columns are sized to their content, with alignment honoured", () => {
  assert.deepEqual(rows("| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | 1 |\n| long text | c | 333 |"), [
    "Left      │ Center │ Right",
    "──────────┼────────┼──────",
    "a         │   b    │     1",
    "long text │   c    │   333",
  ]);
});

test("cells keep inline formatting; escaped pipes are literal; ragged rows are padded and extra cells dropped", () => {
  const lines = md("| a | b |\n|---|---|\n| **bold** \\| pipe | `code` |\n| only |\n| x | y | z |", 60);
  assert.deepEqual(plain(lines).split("\n"), ["a           │ b", "────────────┼─────", "bold | pipe │ code", "only        │", "x           │ y"]);
  assert.equal(stylesOf(lines, "bold")[0]?.bold, true);
  assert.equal(stylesOf(lines, "code")[0]?.fg, "synString");
  // Header cells are bold, separators use the rule colour.
  assert.deepEqual(lines[0]![0], { text: "a", style: { bold: true } });
  assert.equal(stylesOf(lines, "│")[0]?.fg, "rule");
});

test("wide characters are aligned by display width", () => {
  const out = rows("| Name | 名前 |\n|---|---|\n| 東京 | x |\n| ab | 日本語 |\n| 😀 | y |");
  const first = bars(out[0]!);
  for (const r of out) assert.deepEqual(bars(r), first, `aligned: ${r}`);
});

test("a table too wide is shrunk fairly and its cells wrap within their columns", () => {
  const src =
    "| Name | Description of the thing | n |\n|:--|:--|--:|\n| alpha | a long description that must wrap within its column nicely | 1 |\n| beta | short | 22 |";
  const out = rows(src, 40);
  assert.deepEqual(out, [
    "Name  │ Description of the thing    │  n",
    "──────┼─────────────────────────────┼───",
    "alpha │ a long description that     │  1",
    "      │ must wrap within its column │",
    "      │ nicely                      │",
    "beta  │ short                       │ 22",
  ]);
  // Narrow columns keep their width; the wide one gives way.
  assert.deepEqual(fitColumns([5, 60, 2], 40), [5, 33, 2]);
  assert.deepEqual(fitColumns([30, 30], 40), [20, 20]);
  assert.equal(fitColumns([10, 10, 10, 10], 20), null);
});

test("when it cannot fit even shrunk, each row becomes a block of header: value lines", () => {
  assert.deepEqual(rows("| a | b | c | d |\n|---|---|---|---|\n| one | two | three | four |\n| 5 | 6 | 7 | 8 |", 20), [
    "a: one",
    "b: two",
    "c: three",
    "d: four",
    "",
    "a: 5",
    "b: 6",
    "c: 7",
    "d: 8",
  ]);
  // A header-only table that cannot fit lists its headers.
  assert.deepEqual(rows("| alpha | beta | gamma | delta |\n|---|---|---|---|", 20), ["alpha · beta · gamma", "· delta"]);
  // An empty header is named by position.
  assert.match(plain(md("| | b | c | d |\n|---|---|---|---|\n| first | second | third | fourth |", 16)), /Column 1: first\nb: second/);
});

test("a header with no rows, and a streaming table, render what they have", () => {
  assert.deepEqual(rows("| h1 | h2 |\n|---|---|"), ["h1 │ h2", "───┼───"]);
  assert.deepEqual(plain(md("| h1 | h2 |\n|---|---|\n| x", 40, true)).split("\n"), ["h1 │ h2", "───┼───", "x  │"]);
  // A pipe line with no delimiter row is a paragraph.
  assert.deepEqual(rows("a | b\nc | d"), ["a | b c | d"]);
});

test("thousands of columns fall back quickly and fit", () => {
  const n = 5000;
  const src = `|${"h|".repeat(n)}\n|${"-|".repeat(n)}\n|${"1|".repeat(n)}`;
  const t = performance.now();
  const lines = md(src, 80);
  assert.ok(performance.now() - t < 1000);
  assert.ok(lines.length > 0);
});
