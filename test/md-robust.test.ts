/**
 * Robustness: hostile and pathological input returns lines quickly and never throws, every line fits, and no
 * control character or escape sequence reaches a span from any position in the document.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { highlightCode, MAX_SOURCE, renderDiff, renderMarkdown, renderMarkdownGroups } from "../src/tui/md/index.js";
import { assertFits, cpuMs, md, plain } from "./fixtures/md/helpers.js";

/** Anything a terminal would act on: C0, DEL, C1, and the bidi controls that reorder text. */
const ACTIVE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/**
 * Each pathological input as a function of a size factor: `k = 1` is the size the absolute checks use, and the
 * scaling check renders `k = 1` and `k = 4` and compares. Where an input is about depth rather than length (a
 * 500-level quote), the factor leaves it as it is and the scaling check skips it.
 */
const GROWS: Record<string, (k: number) => string> = {
  "100k words": (k) => "word ".repeat(20_000 * k),
  "100k chars, no space": (k) => "x".repeat(100_000 * k),
  "100k stars": (k) => "*".repeat(100_000 * k),
  "alternating emphasis": (k) => "*a ".repeat(30_000 * k),
  "underscores": (k) => "_a".repeat(50_000 * k),
  "brackets": (k) => "[".repeat(50_000 * k) + "]".repeat(50_000 * k),
  "unclosed link tails": (k) => "[a](".repeat(25_000 * k),
  "backtick runs": (k) => "`a``".repeat(25_000 * k),
  "angles": (k) => "<a ".repeat(30_000 * k),
  "unclosed block tags": (k) => "<Foo>\n".repeat(20_000 * k),
  "unclosed inline tags": (k) => "x <b>".repeat(20_000 * k),
  "open braces": (k) => "{".repeat(50_000 * k),
  "brace words": (k) => "{a ".repeat(30_000 * k),
  "500 quote lines": (k) => Array.from({ length: 500 * k }, (_, i) => ">".repeat((i % 500) + 1) + " x").join("\n"),
  "500 markers on a line": (k) => ("- ".repeat(500) + "x\n").repeat(k),
  "5000 columns": (k) => `|${"a|".repeat(5000 * k)}\n|${"-|".repeat(5000 * k)}\n|${"1|".repeat(5000 * k)}`,
  "binary junk": (k) => Array.from({ length: 100_000 * k }, (_, i) => String.fromCharCode((i * 7919) % 65536)).join(""),
  "unterminated fence": (k) => "```ts\n" + "const a = `x${".repeat(20_000 * k),
  "entities": (k) => "&#x1;&#0;&amp;&#x202e;".repeat(20_000 * k),
  "unclosed comments": (k) => "<!--".repeat(30_000 * k),
  "emphasis soup": (k) => "**a *b ".repeat(20_000 * k),
  "reference soup": (k) => "[a][b] ".repeat(20_000 * k),
  "table soup": (k) => "| a | b |\n|---|---|\n".repeat(5000 * k),
  "unclosed admonitions": (k) => ":::note\n".repeat(10_000 * k),
  "unclosed details": (k) => "<Details>\n".repeat(5000 * k),
  "20k attributes": (k) => `<Foo ${'a="1" '.repeat(20_000 * k)}>x</Foo>`,
  "unterminated JSX tag": (k) => `<Callout title="${"x".repeat(50_000 * k)}`,
  "nested brackets in a link": (k) => `[${"[".repeat(10_000 * k)}](${"(".repeat(10_000 * k)}`,
};

const PATHOLOGICAL: Record<string, string> = {
  ...Object.fromEntries(Object.entries(GROWS).map(([name, grow]) => [name, grow(1)])),
  "500-level quote": ">".repeat(500) + " deep",
  "500-level list": Array.from({ length: 500 }, (_, i) => " ".repeat(i * 2) + "- item").join("\n"),
  "500-level components": "<Note>".repeat(500) + "x" + "</Note>".repeat(500),
};

/** The cheapest of `runs` renders, in milliseconds of CPU (see `cpuMs`): the least disturbed by a busy machine. */
function fastest(src: string, streaming: boolean, runs: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) best = Math.min(best, cpuMs(() => renderMarkdown(src, { width: 80, streaming })));
  return best;
}

/**
 * The backstop: generous enough that a slow shared runner (several times slower than a laptop, which renders the
 * slowest of these in well under 100 ms) never trips it, and still a failure for a real hang or a quadratic blow-up.
 * Whether the work grows the way it should is the scaling test's question, not this one's.
 */
const BACKSTOP_MS = 5000;

test("pathological inputs never throw, fit, and finish (a generous backstop against a hang)", () => {
  const timings: string[] = [];
  for (const [name, src] of Object.entries(PATHOLOGICAL)) {
    for (const streaming of [false, true]) {
      const t = performance.now();
      const lines = renderMarkdown(src, { width: 80, streaming });
      const ms = performance.now() - t;
      timings.push(`${name}${streaming ? " (streaming)" : ""}: ${ms.toFixed(0)} ms`);
      assert.ok(ms < BACKSTOP_MS, `${name}${streaming ? " (streaming)" : ""} took ${ms.toFixed(0)} ms`);
      assertFits(lines, 80, name);
    }
  }
  if (process.env.MD_TIMINGS) console.log(timings.join("\n"));
});

/**
 * Four times the input may take about four times as long, never sixteen. Each size is timed in CPU milliseconds
 * (`cpuMs`, not wall time, which a loaded machine inflates for the longer render) as the cheapest of two
 * renders, and the smaller time is floored so a render of a millisecond or two does not turn noise into a ratio.
 * A linear renderer measures 3 to 6 here (up to about 7 on a machine with every core busy); a quadratic one 16. The
 * bound, 11, sits between, and is the same on a fast machine and a slow one because both sizes run on the same
 * machine moments apart.
 */
const SCALE = 4;
const MAX_RATIO = 11;
const FLOOR_MS = 8;

test("pathological inputs scale linearly: four times the input, about four times the time", () => {
  const report: string[] = [];
  const slow: string[] = [];
  for (const [name, grow] of Object.entries(GROWS)) {
    const small = grow(1);
    const large = grow(SCALE);
    for (const streaming of [false, true]) {
      const a = fastest(small, streaming, 2);
      const b = fastest(large, streaming, 2);
      const ratio = b / Math.max(a, FLOOR_MS);
      const label = `${name}${streaming ? " (streaming)" : ""}`;
      report.push(`${label}: ${a.toFixed(1)} ms, x${SCALE} ${b.toFixed(1)} ms, ratio ${ratio.toFixed(1)}`);
      if (ratio > MAX_RATIO) {
        // One retry, five rounds with the two sizes interleaved: a collection or a busy moment during one run is the
        // usual cause of an outlier, and a lucky fast small run the other.
        let a2 = Number.POSITIVE_INFINITY;
        let b2 = Number.POSITIVE_INFINITY;
        for (let r = 0; r < 5; r++) {
          a2 = Math.min(a2, fastest(small, streaming, 1));
          b2 = Math.min(b2, fastest(large, streaming, 1));
        }
        const ratio2 = b2 / Math.max(a2, FLOOR_MS);
        if (ratio2 > MAX_RATIO) slow.push(`${label}: ${a2.toFixed(1)} ms then ${b2.toFixed(1)} ms at x${SCALE} (ratio ${ratio2.toFixed(1)})`);
      }
    }
  }
  if (process.env.MD_TIMINGS) console.log(report.join("\n"));
  assert.deepEqual(slow, [], "superlinear growth");
});

test("the scaling check is not blind: a quadratic renderer fails it", () => {
  // The same measurement over a deliberately quadratic stand-in, sized like the inputs above.
  const quadratic = (src: string) => {
    let n = 0;
    for (let i = 0; i < src.length; i += 8) for (let j = i; j < src.length; j += 8) n ^= src.charCodeAt(j);
    return n;
  };
  const time = (src: string) => {
    let best = Number.POSITIVE_INFINITY;
    for (let r = 0; r < 3; r++) best = Math.min(best, cpuMs(() => quadratic(src)));
    return best;
  };
  // Sized so the smaller run is clear of the floor (the floor makes a quadratic cost under a few milliseconds look
  // linear, which is why the inputs above are sized to take several milliseconds each).
  const a = time("x".repeat(40_000));
  const b = time("x".repeat(40_000 * SCALE));
  assert.ok(b / Math.max(a, FLOOR_MS) > MAX_RATIO, `quadratic measured ${a.toFixed(1)} ms then ${b.toFixed(1)} ms`);
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
