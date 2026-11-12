import assert from "node:assert/strict";
import { test } from "node:test";
import type { Line } from "../src/tui/full/types.js";
import { displayWidth, expandTabs, graphemes, lineWidth, TAB_WIDTH, truncate, wrapLine } from "../src/tui/full/screen/width.js";

test("width: ASCII, wide, fullwidth and emoji", () => {
  assert.equal(displayWidth("hello"), 5);
  assert.equal(displayWidth("日本語"), 6);
  assert.equal(displayWidth("ＡＢ"), 4, "fullwidth Latin");
  assert.equal(displayWidth("한국"), 4, "Hangul syllables");
  assert.equal(displayWidth("😀"), 2);
  assert.equal(displayWidth("🚀x"), 3);
  assert.equal(displayWidth("€½é"), 3, "narrow and ambiguous are one cell");
  assert.equal(displayWidth(""), 0);
});

test("width: combining marks, joiners, variation selectors, flags, keycaps", () => {
  assert.equal(displayWidth("é"), 1, "e + combining acute");
  assert.equal(displayWidth("ạ̈"), 1, "stacked marks");
  assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2, "ZWJ family");
  assert.equal(displayWidth("🏳️‍🌈"), 2, "rainbow flag");
  assert.equal(displayWidth("👍🏽"), 2, "skin tone modifier");
  assert.equal(displayWidth("🇬🇧🇫🇷"), 4, "two flags");
  assert.equal(displayWidth("❤️"), 2, "heart with VS16 is emoji presentation");
  assert.equal(displayWidth("❤"), 1, "text presentation");
  assert.equal(displayWidth("1️⃣"), 2, "keycap");
  assert.equal(displayWidth("☺︎"), 1, "VS15 text presentation stays narrow");
  assert.equal(displayWidth("​"), 0, "zero width space");
  assert.equal(displayWidth("́"), 0, "a lone mark takes nothing");
  assert.equal(displayWidth("각"), 2);
  assert.equal(displayWidth("각"), 2, "conjoining jamo form one syllable");
});

test("width: control characters take nothing and tabs expand to stops", () => {
  assert.equal(displayWidth("a\u001bb\u0007c\u009b"), 3);
  assert.equal(displayWidth("\t"), TAB_WIDTH);
  assert.equal(displayWidth("ab\tc"), TAB_WIDTH + 1);
  assert.equal(expandTabs("ab\tc"), `ab${" ".repeat(TAB_WIDTH - 2)}c`);
  assert.equal(lineWidth([{ text: "ab" }, { text: "\tc" }]), TAB_WIDTH + 1, "tab stops run across spans");
});

test("graphemes: never split a cluster", () => {
  assert.deepEqual(graphemes("éx"), ["é", "x"]);
  assert.deepEqual(graphemes("👨‍👩‍👧x"), ["👨‍👩‍👧", "x"]);
  assert.deepEqual(graphemes("🇬🇧🇫🇷"), ["🇬🇧", "🇫🇷"]);
});

test("truncate: cuts to the width, never half a wide character; ellipsis fits", () => {
  const line: Line = [{ text: "日本語テキスト", style: { fg: "accent" } }];
  assert.equal(lineWidth(truncate(line, 5)), 4);
  assert.equal(lineWidth(truncate(line, 5, true)), 5);
  assert.equal(truncate(line, 5, true).map((s) => s.text).join(""), "日本…");
  assert.deepEqual(truncate([{ text: "short" }], 10), [{ text: "short" }]);
  assert.deepEqual(truncate([{ text: "abc" }], 0), []);
  assert.equal(truncate([{ text: "a\u001bb" }], 10).map((s) => s.text).join(""), "ab", "a stray control is dropped");
  assert.equal(truncate([{ text: "\tx" }], 10).map((s) => s.text).join(""), `${" ".repeat(TAB_WIDTH)}x`, "no tab survives");
});

test("wrapLine: words, long words, indent, hard breaks, styles kept", () => {
  const rows = wrapLine([{ text: "the quick brown fox jumps" }], 10).map((l) => l.map((s) => s.text).join(""));
  assert.deepEqual(rows, ["the quick", "brown fox", "jumps"]);
  const long = wrapLine([{ text: "abcdefghijklmnop" }], 5).map((l) => l.map((s) => s.text).join(""));
  assert.deepEqual(long, ["abcde", "fghij", "klmno", "p"]);
  const ind = wrapLine([{ text: "aaa bbb ccc" }], 6, { indent: 2 }).map((l) => l.map((s) => s.text).join(""));
  assert.deepEqual(ind, ["aaa", "  bbb", "  ccc"]);
  const hard = wrapLine([{ text: "a  b  c  d" }], 4, { hardBreak: true }).map((l) => l.map((s) => s.text).join(""));
  assert.deepEqual(hard, ["a  b", "  c ", " d"]);
  assert.deepEqual(wrapLine([], 10), [[]]);
  const styled = wrapLine([{ text: "bold ", style: { bold: true } }, { text: "plain words" }], 8);
  assert.equal(styled[0]![0]!.style?.bold, true);
  const wide = wrapLine([{ text: "日本語日本語" }], 5).map((l) => l.map((s) => s.text).join(""));
  assert.deepEqual(wide, ["日本", "語日", "本語"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------------------------

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const ALPHABET = ["a", "b", "word", " ", " ", "  ", "日", "本", "😀", "👨‍👩‍👧", "🇬🇧", "é", "❤️", "\t", "-", "x", "Ａ", "1️⃣", "​", "longerword"];

function randomLine(r: () => number): Line {
  const spans: Line = [];
  const n = 1 + Math.floor(r() * 4);
  for (let s = 0; s < n; s++) {
    let text = "";
    const k = Math.floor(r() * 12);
    for (let i = 0; i < k; i++) text += ALPHABET[Math.floor(r() * ALPHABET.length)];
    spans.push({ text, style: r() < 0.5 ? { bold: true } : { fg: "accent" } });
  }
  return spans;
}

const flat = (l: Line) => l.map((s) => s.text).join("");
const noSpace = (s: string) => expandTabs(s).replace(/[\s​]/g, "");

test("property: truncate always fits", () => {
  const r = rng(7);
  for (let i = 0; i < 1500; i++) {
    const line = randomLine(r);
    const w = Math.floor(r() * 30);
    assert.ok(lineWidth(truncate(line, w)) <= w, JSON.stringify(line));
    assert.ok(lineWidth(truncate(line, w, true)) <= w, JSON.stringify(line));
  }
});

test("property: wrapping fits, never splits a grapheme, and keeps the text", () => {
  const r = rng(42);
  for (let i = 0; i < 1500; i++) {
    const line = randomLine(r);
    const w = 2 + Math.floor(r() * 25);
    const indent = r() < 0.3 ? Math.floor(r() * 3) : 0;
    const rows = wrapLine(line, w, { indent });
    const source = graphemes(flat(line).replace(/\t/g, ""));
    for (const row of rows) {
      assert.ok(lineWidth(row) <= w, `row too wide at ${w}: ${JSON.stringify(row)}`);
      for (const g of graphemes(flat(row))) {
        if (g === " " || g === "​") continue;
        assert.ok(source.includes(g), `grapheme split: ${JSON.stringify(g)} from ${JSON.stringify(flat(line))}`);
      }
    }
    assert.equal(noSpace(rows.map(flat).join("")), noSpace(flat(line)), JSON.stringify(line));
    const hard = wrapLine(line, w, { hardBreak: true });
    for (const row of hard) assert.ok(lineWidth(row) <= w);
    assert.equal(noSpace(hard.map(flat).join("")), noSpace(flat(line)));
  }
});

test("width: a long line is measured quickly", () => {
  const s = "日本語 emoji 😀 and text ".repeat(5000);
  const t = Date.now();
  displayWidth(s);
  wrapLine([{ text: s }], 80);
  assert.ok(Date.now() - t < 2000);
});
