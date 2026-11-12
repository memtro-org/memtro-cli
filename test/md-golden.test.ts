/**
 * Golden renderings: small documents under test/fixtures/md/golden and the plain text they render to, so a change
 * in layout shows as a readable diff. `UPDATE_GOLDEN=1` rewrites the expected files (then read them before keeping
 * them). Styles are spot-checked below, since plain text cannot show them.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Line } from "../src/tui/full/types.js";
import { renderDiff } from "../src/tui/md/index.js";
import { assertFits, md, plain, stylesOf } from "./fixtures/md/helpers.js";

const dir = join(import.meta.dirname, "fixtures", "md", "golden");
const corpus = join(import.meta.dirname, "fixtures", "md", "corpus");

/** Plain text with each line's end marked, so trailing spaces (a code block's padding) are visible in the file. */
const text = (lines: Line[]): string => `${plain(lines).split("\n").map((l) => `${l}|`).join("\n")}\n`;

function golden(name: string, lines: Line[]): void {
  const file = join(dir, `${name}.txt`);
  const actual = text(lines);
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) writeFileSync(file, actual);
  assert.equal(actual, readFileSync(file, "utf8"), `${name} changed; if intended, rerun with UPDATE_GOLDEN=1 and review the diff`);
}

const inputs = readdirSync(dir).filter((f) => /\.(mdx?|diff)$/.test(f));

for (const f of inputs) {
  test(`golden: ${f}`, () => {
    const src = readFileSync(join(dir, f), "utf8");
    for (const w of [60, 36]) {
      const lines = f.endsWith(".diff") ? renderDiff(src, { width: w }) : md(src, w);
      assertFits(lines, w, f);
      golden(`${f}.w${w}`, lines);
    }
  });
}

test("golden: the MDX docs page at width 72", () => {
  const lines = md(readFileSync(join(corpus, "docs.mdx"), "utf8"), 72);
  golden("docs.mdx.w72", lines);
});

test("golden styles: headings, emphasis, tasks, quote bar, links, code roles, diff backgrounds", () => {
  const blocks = md(readFileSync(join(dir, "blocks.md"), "utf8"), 60);
  assert.deepEqual(stylesOf(blocks, "Release notes")[0], { fg: "heading", bold: true });
  assert.equal(stylesOf(blocks, "2.1")[0]?.bold, true);
  assert.equal(stylesOf(blocks, "faster")[0]?.italic, true);
  assert.equal(stylesOf(blocks, "fewer")[0]?.strike, true);
  assert.equal(stylesOf(blocks, "--dry-run")[0]?.fg, "synString");
  assert.equal(stylesOf(blocks, "[✓]")[0]?.fg, "success");
  assert.equal(stylesOf(blocks, "│")[0]?.fg, "muted");

  const links = md(readFileSync(join(dir, "links.md"), "utf8"), 60);
  // A link's text carries no address: only the address shown after it opens, so what opens is what is shown.
  assert.equal(stylesOf(links, "the guide")[0]?.link, undefined);
  assert.equal(stylesOf(links, "the guide")[0]?.underline, true);
  assert.equal(stylesOf(links, "(https://docs.example/guide)")[0]?.link, "https://docs.example/guide");
  assert.equal(stylesOf(links, "run me")[0]?.link, undefined);
  assert.equal(stylesOf(links, "https://bank.example/login")[0]?.link, undefined, "text that looks like another address opens nothing");
  assert.equal(stylesOf(links, "(https://evil.example/login)")[0]?.link, "https://evil.example/login");

  const code = md(readFileSync(join(dir, "code.md"), "utf8"), 60);
  assert.equal(stylesOf(code, "def")[0]?.fg, "synKeyword");
  assert.equal(stylesOf(code, "# a greeting")[0]?.fg, "synComment");
  assert.equal(stylesOf(code, "$ ")[0]?.dim, true);
  assert.ok(code.slice(2).every((l) => l.length === 0 || l.every((s) => s.style?.bg === "codeBg")));

  const diff = renderDiff(readFileSync(join(dir, "change.diff"), "utf8"), { width: 60 });
  assert.ok(diff.some((l) => l.every((s) => s.style?.bg === "addedBg" || s.style?.bg === "added")));
  assert.ok(diff.some((l) => l.every((s) => s.style?.bg === "removedBg" || s.style?.bg === "removed")));
});
