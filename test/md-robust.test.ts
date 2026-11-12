/**
 * Robustness: hostile and pathological input returns lines quickly and never throws, every line fits, and no
 * control character or escape sequence reaches a span from any position in the document.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightCode, MAX_SOURCE, renderDiff, renderMarkdown, renderMarkdownGroups } from "../src/tui/md/index.js";
import { assertFits, md, plain } from "./fixtures/md/helpers.js";

/** Anything a terminal would act on: C0, DEL, C1, and the bidi controls that reorder text. */
const ACTIVE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

const PATHOLOGICAL: Record<string, string> = {
  "100k words": "word ".repeat(20_000),
  "100k chars, no space": "x".repeat(100_000),
  "100k stars": "*".repeat(100_000),
  "alternating emphasis": "*a ".repeat(30_000),
  "underscores": "_a".repeat(50_000),
  "brackets": "[".repeat(50_000) + "]".repeat(50_000),
  "unclosed link tails": "[a](".repeat(25_000),
  "backtick runs": "`a``".repeat(25_000),
  "angles": "<a ".repeat(30_000),
  "unclosed block tags": "<Foo>\n".repeat(20_000),
  "unclosed inline tags": "x <b>".repeat(20_000),
  "open braces": "{".repeat(50_000),
  "brace words": "{a ".repeat(30_000),
  "500-level quote": ">".repeat(500) + " deep",
  "500 quote lines": Array.from({ length: 500 }, (_, i) => ">".repeat(i + 1) + " x").join("\n"),
  "500-level list": Array.from({ length: 500 }, (_, i) => " ".repeat(i * 2) + "- item").join("\n"),
  "500 markers on a line": "- ".repeat(500) + "x",
  "500-level components": "<Note>".repeat(500) + "x" + "</Note>".repeat(500),
  "5000 columns": `|${"a|".repeat(5000)}\n|${"-|".repeat(5000)}\n|${"1|".repeat(5000)}`,
  "binary junk": Array.from({ length: 100_000 }, (_, i) => String.fromCharCode((i * 7919) % 65536)).join(""),
  "unterminated fence": "```ts\n" + "const a = `x${".repeat(20_000),
  "entities": "&#x1;&#0;&amp;&#x202e;".repeat(20_000),
  "unclosed comments": "<!--".repeat(30_000),
  "emphasis soup": "**a *b ".repeat(20_000),
  "reference soup": "[a][b] ".repeat(20_000),
  "table soup": "| a | b |\n|---|---|\n".repeat(5000),
  "unclosed admonitions": ":::note\n".repeat(10_000),
  "unclosed details": "<Details>\n".repeat(5000),
  "20k attributes": `<Foo ${'a="1" '.repeat(20_000)}>x</Foo>`,
  "unterminated JSX tag": `<Callout title="${"x".repeat(50_000)}`,
  "nested brackets in a link": `[${"[".repeat(10_000)}](${"(".repeat(10_000)}`,
};

test("pathological inputs finish in a fraction of a second, never throw, and fit", () => {
  const timings: string[] = [];
  for (const [name, src] of Object.entries(PATHOLOGICAL)) {
    for (const streaming of [false, true]) {
      const t = performance.now();
      const lines = renderMarkdown(src, { width: 80, streaming });
      const ms = performance.now() - t;
      timings.push(`${name}${streaming ? " (streaming)" : ""}: ${ms.toFixed(0)} ms`);
      assert.ok(ms < 750, `${name}${streaming ? " (streaming)" : ""} took ${ms.toFixed(0)} ms`);
      assertFits(lines, 80, name);
    }
  }
  if (process.env.MD_TIMINGS) console.log(timings.join("\n"));
});

test("deep nesting degrades to plain text instead of recursing without end", () => {
  const quote = plain(md(">".repeat(500) + " deep", 80));
  assert.match(quote, /deep/);
  const list = plain(md(Array.from({ length: 200 }, (_, i) => " ".repeat(i * 2) + "- item" + i).join("\n"), 80));
  assert.match(list, /item199/);
  const comps = plain(md("<Note>".repeat(300) + "inside" + "</Note>".repeat(300), 80));
  assert.match(comps.replace(/\n[┃ ]*/g, ""), /inside/, "beyond the depth cap the rest is shown as its text");
});

test("an input past the size cap is shown as plain wrapped text", () => {
  const big = "# not a heading\n" + "y".repeat(MAX_SOURCE);
  const lines = renderMarkdown(big, { width: 100, streaming: false });
  assert.equal(plain([lines[0]!]), "# not a heading");
  assertFits(lines.slice(0, 50), 100);
});

test("odd arguments never throw", () => {
  for (const w of [0, -5, 0.5, 1, 1.9, Number.NaN, Number.POSITIVE_INFINITY]) {
    const lines = renderMarkdown("# hi\n\n- a\n\n```\ncode\n```", { width: w, streaming: false });
    assert.ok(Array.isArray(lines));
    renderDiff("+a\n-b", { width: w });
  }
  assert.ok(Array.isArray(renderMarkdown(undefined as unknown as string, { width: 20, streaming: false })));
});

test("control characters and escape sequences are cleaned in every position", () => {
  const E = "\u001b[31m";
  const O = "\u001b]8;;https://evil.example\u0007";
  const C1 = "\u009b2J";
  const BIDI = "‮⁦";
  const bad = `${E}${O}${C1}${BIDI}\u0000\u0008\u007f\r`;
  const doc = [
    `# Heading ${bad}`,
    "",
    `Paragraph ${bad} with **strong ${bad}** and \`code ${bad}\` and _em ${bad}_.`,
    "",
    `- item ${bad}`,
    `  - nested ${bad}`,
    `1. ordered ${bad}`,
    `- [x] task ${bad}`,
    "",
    `> quote ${bad}`,
    "",
    `| head ${bad} | b |`,
    "|---|---|",
    `| cell ${bad} | \`c ${bad}\` |`,
    "",
    `\`\`\`ts title="${bad}file.ts"`,
    `const s = "${bad}"; // ${bad}`,
    "```",
    "",
    `[link ${bad}](https://example.com/${bad}path "title ${bad}")`,
    `[ref ${bad}][r] <https://auto.example/${bad}> https://bare.example/${bad}x`,
    `![alt ${bad}](https://img.example/${bad}.png)`,
    "",
    `[r]: https://ref.example/${bad}`,
    "",
    `<Note title="${bad}">component ${bad}</Note>`,
    `<Card title="t" href="https://card.example/${bad}">c</Card>`,
    `<Tabs><Tab label="${bad}">tab</Tab></Tabs>`,
    `Expression {${bad}} and <kbd>${bad}</kbd> and <a href="https://a.example/${bad}">a</a>.`,
    "",
    `:::note ${bad}`,
    `admonition ${bad}`,
    ":::",
    "",
    `> [!WARNING] ${bad}`,
    `> alert ${bad}`,
    "",
    `Setext ${bad}`,
    "---",
    "",
    `    indented ${bad}`,
  ].join("\n");
  for (const streaming of [false, true]) {
    for (const w of [80, 30]) {
      const lines = renderMarkdown(doc, { width: w, streaming });
      assertFits(lines, w);
      for (const s of lines.flat()) {
        assert.ok(!ACTIVE.test(s.text), `text ${JSON.stringify(s.text)}`);
        if (s.style?.link) assert.ok(!/[\u0000- \u007f- ‪-‮⁦-⁩]/.test(s.style.link), `link ${JSON.stringify(s.style.link)}`);
      }
      // The escape sequences are shown (as visible symbols), not lost and not acted on.
      assert.match(plain(lines), /\[31m/);
    }
  }
  for (const s of highlightCode(`x ${bad}\ny`, "ts").flat()) assert.ok(!ACTIVE.test(s.text));
  for (const s of renderDiff(`+a ${bad}\n-b ${bad}`, { width: 40 }).flat()) assert.ok(!ACTIVE.test(s.text));
});

test("renderMarkdownGroups: one group per top-level block, the blank separator carried by each group after the first", () => {
  const groups = renderMarkdownGroups("# A\n\npara\n\n- x\n- y", { width: 20, streaming: false });
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[1]![0], []);
  assert.deepEqual(groups.flat(), renderMarkdown("# A\n\npara\n\n- x\n- y", { width: 20, streaming: false }));
  assert.deepEqual(renderMarkdownGroups("", { width: 20, streaming: true }), []);
});
