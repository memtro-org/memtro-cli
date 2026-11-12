/** Blocks and inlines: headings, paragraphs and wrapping, lists, quotes, rules, breaks, emphasis, images. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../src/tui/md/index.js";
import { graphemes } from "../src/tui/full/screen/width.js";
import { md, plain, standIn, stylesOf, width } from "./fixtures/md/helpers.js";

const rows = (src: string, w = 60, streaming = false): string[] => plain(md(src, w, streaming)).split("\n");

test("headings: levels are styled apart, level 1 and 2 carry a rule as wide as the text area", () => {
  const lines = md("# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six", 30);
  const text = rows("# One\n\n## Two\n\n### Three", 30);
  assert.deepEqual(text, ["One", "━".repeat(30), "", "Two", "─".repeat(30), "", "Three"]);
  const style = (needle: string) => stylesOf(lines, needle)[0];
  assert.deepEqual(style("One"), { fg: "heading", bold: true });
  assert.equal(style("━")?.fg, "heading");
  assert.equal(style("─")?.fg, "rule");
  assert.equal(style("Four")?.bold, true);
  assert.equal(style("Four")?.fg, undefined);
  assert.equal(style("Five")?.fg, "muted");
  assert.equal(style("Six")?.italic, true);
  // Setext headings and closing hashes.
  assert.deepEqual(rows("Title\n=====\n\n### Sub ##\n", 10), ["Title", "━".repeat(10), "", "Sub"]);
});

test("paragraphs wrap on word boundaries; soft breaks join, hard breaks break", () => {
  assert.deepEqual(rows("one two three four five six seven", 14), ["one two three", "four five six", "seven"]);
  assert.deepEqual(rows("first line\nsecond line  \nthird\\\nfourth", 40), ["first line second line", "third", "fourth"]);
  // A word longer than the line is broken, never overflowing.
  for (const l of rows("x".repeat(95), 20)) assert.ok(l.length <= 20);
});

test("wide characters and emoji are measured by display width and a grapheme is never split", () => {
  const src = "日本語のテキストも折り返されるべきです。 👩‍👩‍👧 family 🇬🇧 flag é accent";
  for (const w of [5, 7, 10, 13, 20]) {
    const lines = md(src, w);
    const all = lines.flatMap((l) => l.map((s) => s.text)).join("");
    // Every grapheme of the source survives whole (spaces aside).
    for (const g of graphemes(src.replace(/ /g, ""))) assert.ok(all.includes(g), `w${w}: ${g} kept whole`);
    for (const l of lines) assert.ok(width(l) <= w);
  }
  assert.deepEqual(rows("日本語日本語", 6), ["日本語", "日本語"]);
});

test("lists: bullets by depth, ordered numbers right-aligned, hanging indents, tasks, loose items spaced", () => {
  assert.deepEqual(rows("- a\n- b\n  - c\n    - d\n      - e", 40), ["• a", "• b", "  ◦ c", "    ▪ d", "      • e"]);
  assert.deepEqual(rows("- a long item that wraps around the width\n- b", 24), ["• a long item that wraps", "  around the width", "• b"]);
  assert.deepEqual(rows("9. nine\n10. ten wraps around\n", 16), [" 9. nine", "10. ten wraps", "    around"]);
  assert.deepEqual(rows("3) three\n4) four"), ["3) three", "4) four"]);
  assert.deepEqual(rows("- [x] done\n- [ ] open"), ["[✓] done", "[ ] open"]);
  assert.equal(stylesOf(md("- [x] done"), "[✓]")[0]?.fg, "success");
  assert.deepEqual(rows("- a\n\n- b"), ["• a", "", "• b"]);
  assert.deepEqual(rows("- a\n\n  second para\n- b"), ["• a", "", "  second para", "", "• b"]);
  // Code inside a tight item follows its text directly, indented under it.
  assert.deepEqual(rows("1. step\n   ```sh\n   ls\n   ```", 30).map((l) => l.trimEnd()), ["1. step", "     sh", "     ls", ""]);
});

test("block quotes have a muted bar and nest; a blank line inside keeps the bar alone", () => {
  assert.deepEqual(rows("> one\n> > two\n>\n> three"), ["│ one", "│", "│ │ two", "│", "│ three"]);
  assert.equal(stylesOf(md("> one"), "│")[0]?.fg, "muted");
  // Lazy continuation.
  assert.deepEqual(rows("> one\ncontinued"), ["│ one continued"]);
});

test("horizontal rules span the width; front matter is dropped", () => {
  assert.deepEqual(rows("a\n\n***\n\nb", 12), ["a", "", "─".repeat(12), "", "b"]);
  assert.deepEqual(rows("---\ntitle: x\n---\n\nBody", 20), ["Body"]);
});

test("inlines: emphasis, strong, strikethrough, code, escapes, entities", () => {
  const lines = md("*em* **strong** ***both*** ~~gone~~ `co de` \\*lit\\* &amp; &copy; &#65;");
  assert.equal(plain(lines), "em strong both gone co de *lit* & © A");
  assert.deepEqual(stylesOf(lines, "em")[0], { italic: true });
  assert.deepEqual(stylesOf(lines, "strong")[0], { bold: true });
  assert.deepEqual(stylesOf(lines, "both")[0], { italic: true, bold: true });
  assert.deepEqual(stylesOf(lines, "gone")[0], { strike: true });
  assert.equal(stylesOf(lines, "co de")[0]?.fg, "synString");
  // Unmatched markers are text.
  assert.equal(plain(md("a * b ** c _d")), "a * b ** c _d");
  assert.equal(plain(md("snake_case_name and 2 * 3 * 4")), "snake_case_name and 2 * 3 * 4");
  // An entity cannot smuggle in a control or a direction override.
  assert.equal(plain(md("&#27;[31m &#x202e;x &#0;")), "�[31m �x �");
});

test("images render as [image: alt] and the address", () => {
  assert.equal(plain(md("![A cat](https://img.example/cat.png)")), "[image: A cat] https://img.example/cat.png");
  assert.equal(plain(md("![](https://img.example/cat.png)")), "[image] https://img.example/cat.png");
  const lines = md("![A cat](https://img.example/cat.png)");
  assert.equal(stylesOf(lines, "[image: A cat]")[0]?.italic, true);
  assert.equal(stylesOf(lines, "https://img.example")[0]?.link, "https://img.example/cat.png");
});

test("every line fits at every width, down to a single cell, and nothing throws", () => {
  const src = "# A heading that is long\n\n- item one with words\n  - nested 日本語\n\n> quote **bold** `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n[link](https://example.com/a/b/c)";
  for (let w = 1; w <= 50; w++) {
    for (const streaming of [false, true]) md(src, w, streaming);
  }
  assert.deepEqual(renderMarkdown("x", { width: 0, streaming: false }), []);
  assert.deepEqual(renderMarkdown("x", { width: Number.NaN, streaming: false }), []);
  assert.deepEqual(md("", 20), []);
  assert.deepEqual(md("\n\n   \n", 20), []);
});

test("the measure is injectable: a stand-in that counts code points changes the layout as told", () => {
  // The stand-in counts 表 as two cells, like the real one, but does not segment graphemes.
  const lines = renderMarkdown("表表表 表表表", { width: 6, streaming: false, measure: standIn });
  assert.deepEqual(lines.map((l) => l.map((s) => s.text).join("")), ["表表表", "表表表"]);
});
