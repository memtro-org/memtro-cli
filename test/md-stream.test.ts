/**
 * The streaming property: re-rendering a prefix plus more text never changes the shape of a block that was already
 * complete in the prefix. Only the last, still-open block may change.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Line } from "../src/tui/full/types.js";
import { assertFits, groups, md, plain } from "./fixtures/md/helpers.js";

const dir = join(import.meta.dirname, "fixtures", "md", "corpus");
const corpus = readdirSync(dir)
  .filter((f) => /\.mdx?$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));

/** A small deterministic generator, so a failure names a split that can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const key = (lines: Line[]): string => JSON.stringify(lines);

function settled(prefix: string, w: number): Line[] {
  return groups(prefix, w, true).slice(0, -1).flat();
}

function checkStable(prefix: string, longer: string, w: number, label: string): void {
  const before = settled(prefix, w);
  const after = groups(longer, w, true).flat();
  assertFits(after, w, label);
  const head = after.slice(0, before.length);
  if (key(head) !== key(before)) {
    assert.equal(plain(head), plain(before), `${label}: complete blocks changed (prefix ends ${JSON.stringify(prefix.slice(-40))})`);
    assert.deepEqual(head, before, `${label}: complete blocks changed style (prefix ends ${JSON.stringify(prefix.slice(-40))})`);
  }
}

test("corpus documents render and fit", () => {
  assert.ok(corpus.length >= 4, "the corpus is there");
  for (const { name, text } of corpus) {
    for (const w of [100, 60, 33, 20]) {
      const lines = md(text, w, false);
      assert.ok(lines.length > 5, `${name} renders`);
      const streamed = md(text, w, true);
      assert.ok(streamed.length > 5, `${name} renders streaming`);
    }
  }
});

test("streaming: complete blocks never change as text arrives (every split of short documents)", () => {
  for (const { name, text } of corpus) {
    if (text.length > 2500) continue;
    for (const w of [60, 33]) {
      for (let a = 0; a <= text.length; a++) {
        checkStable(text.slice(0, a), text, w, `${name}@${a} w${w} vs whole`);
      }
    }
  }
});

test("streaming: complete blocks never change, random splits and random amounts of more text", () => {
  const next = rng(20261112);
  for (const { name, text } of corpus) {
    for (const w of [72, 41]) {
      for (let k = 0; k < 250; k++) {
        const a = Math.floor(next() * (text.length + 1));
        const b = Math.min(text.length, a + 1 + Math.floor(next() * 80));
        checkStable(text.slice(0, a), text.slice(0, b), w, `${name}@${a}..${b} w${w}`);
      }
    }
  }
});

test("streaming: a long document split at random offsets", () => {
  const long = corpus.map((c) => c.text).join("\n\n").repeat(3);
  const next = rng(7);
  for (let k = 0; k < 120; k++) {
    const a = Math.floor(next() * long.length);
    const b = Math.min(long.length, a + Math.floor(next() * 2000));
    checkStable(long.slice(0, a), long.slice(0, b), 64, `long@${a}..${b}`);
  }
});

test("streaming: an unclosed fence is a code block so far; a dangling ** or backtick is literal", () => {
  const fence = md("Intro\n\n```ts\nconst a = 1;\nconst b", 40, true);
  assert.match(plain(fence), /const a = 1; *\n *const b/);
  assert.equal(fence.at(-1)![0]!.style?.bg, "codeBg", "drawn as a code block");
  const strong = plain(md("Some **bold text", 40, true));
  assert.match(strong, /Some \*\*bold text/);
  const tick = plain(md("Run `npm te", 40, true));
  assert.match(tick, /Run `npm te/);
  const table = plain(md("| a | b |\n|---|---|\n| 1 | 2 |\n| 3", 40, true));
  assert.match(table, /1 │ 2/);
  assert.match(table, /3/);
});

test("streaming: a reference defined later resolves only when the text is complete", () => {
  const src = "See [the guide][g].\n\n[g]: https://example.com/guide";
  assert.match(plain(md(src, 60, false)), /the guide \(https:\/\/example\.com\/guide\)/);
  assert.match(plain(md(src, 60, true)), /\[the guide\]\[g\]/);
  const before = "[g]: https://example.com/guide\n\nSee [the guide][g].";
  assert.match(plain(md(before, 60, true)), /the guide \(https:\/\/example\.com\/guide\)/);
});
