/**
 * MDX: components by name (case-insensitively), ESM plumbing dropped at the top level, expressions shown as code,
 * HTML tags mapped, and nothing ever executed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { md, plain, stylesOf } from "./fixtures/md/helpers.js";

const rows = (src: string, w = 40, streaming = false): string[] => plain(md(src, w, streaming)).split("\n");

test("callouts by component name or kind attribute, case-insensitively, with a bar coloured by kind", () => {
  assert.deepEqual(rows('<TIP title="Hi">Body text</TIP>'), ["┃ Tip Hi", "┃ Body text"]);
  assert.deepEqual(rows('<callout kind="danger">Bad</callout>'), ["┃ Danger", "┃ Bad"]);
  assert.deepEqual(rows('<Callout type="warning" title="Before you start">\n  You need a **key**.\n</Callout>'), [
    "┃ Warning Before you start",
    "┃ You need a key.",
  ]);
  assert.deepEqual(rows("<Aside>Side</Aside>"), ["┃ Note", "┃ Side"]);
  assert.deepEqual(rows('<Admonition type="caution">Careful</Admonition>'), ["┃ Caution", "┃ Careful"]);
  for (const [name, tone] of [["Note", "info"], ["Info", "info"], ["Tip", "success"], ["Warning", "warning"], ["Danger", "danger"]] as const) {
    const lines = md(`<${name}>x</${name}>`);
    assert.equal(stylesOf(lines, "┃")[0]?.fg, tone, name);
    assert.equal(stylesOf(lines, name)[0]?.bold, true);
  }
});

test("Docusaurus :::note and GitHub > [!NOTE] map to the same callout form", () => {
  const jsx = rows("<Note>Same</Note>");
  assert.deepEqual(rows(":::note\nSame\n:::"), jsx);
  assert.deepEqual(rows("> [!NOTE]\n> Same"), jsx);
  assert.deepEqual(rows(":::warning[Careful now]\nBody\n:::"), ["┃ Warning Careful now", "┃ Body"]);
  assert.deepEqual(rows("> [!CAUTION] Heads up\n> Body"), ["┃ Caution Heads up", "┃ Body"]);
  assert.equal(stylesOf(md(":::danger\nx\n:::"), "┃")[0]?.fg, "danger");
  // Nested admonitions with more colons.
  assert.deepEqual(rows("::::note\nOuter\n:::tip\nInner\n:::\n::::"), ["┃ Note", "┃ Outer", "┃", "┃ ┃ Tip", "┃ ┃ Inner"]);
  // An unclosed admonition in a finished text is the text it is.
  assert.deepEqual(rows(":::note\nnever closed"), [":::note never closed"]);
});

test("tabs and code groups: each label as a small heading, then its content, in order", () => {
  assert.deepEqual(rows('<Tabs>\n<Tab title="One">\nFirst\n</Tab>\n<TabItem value="2" label="Two">\nSecond\n</TabItem>\n</Tabs>'), [
    "One",
    "",
    "First",
    "",
    "Two",
    "",
    "Second",
  ]);
  const lines = md('<Tabs><Tab title="One">First</Tab></Tabs>');
  assert.deepEqual(stylesOf(lines, "One")[0], { bold: true, fg: "heading" });
  const group = rows('<CodeGroup>\n```bash npm\nnpm i x\n```\n\n```bash pnpm\npnpm add x\n```\n</CodeGroup>', 30).map((l) => l.trimEnd());
  assert.deepEqual(group, ["  npm · bash", "  npm i x", "", "", "  pnpm · bash", "  pnpm add x", ""]);
});

test("details and accordions are titled blocks with their content shown", () => {
  assert.deepEqual(rows("<details>\n<summary>Click me</summary>\n\nHidden **text**\n</details>"), ["▸ Click me", "  Hidden text"]);
  assert.deepEqual(rows('<Accordion title="Troubleshooting">\n- one\n- two\n</Accordion>'), ["▸ Troubleshooting", "  • one", "  • two"]);
  assert.deepEqual(rows('<Details summary="More">x</Details>'), ["▸ More", "  x"]);
  assert.deepEqual(rows("<Expandable>x</Expandable>"), ["▸ Details", "  x"]);
});

test("steps become a numbered list; cards show their title in bold then content", () => {
  assert.deepEqual(rows('<Steps>\n<Step title="Install">\nRun it.\n</Step>\n<Step title="Use">\nCall it.\n</Step>\n</Steps>'), [
    "1. Install",
    "",
    "   Run it.",
    "",
    "2. Use",
    "",
    "   Call it.",
  ]);
  const cards = md('<CardGroup cols={2}>\n<Card title="API" href="https://docs.example/api">Every endpoint.</Card>\n<Card title="B">bb</Card>\n</CardGroup>');
  assert.deepEqual(plain(cards).split("\n"), ["API (https://docs.example/api)", "Every endpoint.", "", "B", "bb"]);
  assert.equal(stylesOf(cards, "API")[0]?.bold, true);
  assert.equal(stylesOf(cards, "(https://docs.example/api)")[0]?.link, "https://docs.example/api");
  // A card pointing somewhere unsafe shows the address with no link.
  const bad = md('<Card title="A" href="javascript:alert(1)">aa</Card>');
  assert.match(plain(bad), /A \(javascript:alert\(1\)\)/);
  assert.ok(bad.flat().every((s) => !s.style?.link));
});

test("frames, figures and img become the image form; kbd a bracketed key; br a break", () => {
  assert.deepEqual(rows('<Frame caption="The dashboard">\n<img src="https://img.example/d.png" alt="Dashboard" />\n</Frame>', 60), [
    "[image: Dashboard] https://img.example/d.png",
    "",
    "The dashboard",
  ]);
  assert.deepEqual(rows('<img src="https://img.example/x.png" alt="X">', 60), ["[image: X] https://img.example/x.png"]);
  assert.deepEqual(rows("Press <kbd>Ctrl</kbd> + <KBD>C</KBD>."), ["Press [Ctrl] + [C]."]);
  assert.deepEqual(rows("one<br/>two<br>three"), ["one", "two", "three"]);
});

test("inline HTML maps to its Markdown equivalent", () => {
  const lines = md('<b>b</b> <i>i</i> <em>em</em> <strong>st</strong> <code>x < y</code> <a href="https://a.example">a</a> <sup>2</sup> <sub>n</sub> <s>gone</s>', 80);
  assert.equal(plain(lines), "b i em st x < y a (https://a.example) 2 n gone");
  assert.equal(stylesOf(lines, "b")[0]?.bold, true);
  assert.equal(stylesOf(lines, "i")[0]?.italic, true);
  assert.equal(stylesOf(lines, "st")[0]?.bold, true);
  assert.equal(stylesOf(lines, "x < y")[0]?.fg, "synString");
  assert.equal(stylesOf(lines, "gone")[0]?.strike, true);
  assert.equal(stylesOf(lines, "a")[0]?.link, "https://a.example/", "the text of a link opens the address shown after it");
  assert.equal(stylesOf(lines, "(https://a.example)")[0]?.link, "https://a.example/");
});

test("unknown components show their children with no tag noise; self-closing unknowns render nothing", () => {
  assert.deepEqual(rows("<Unknown foo={bar} baz='q'>\nInside **unknown**.\n</Unknown>"), ["Inside unknown."]);
  assert.deepEqual(rows("Before\n\n<Empty />\n\n<Spacer size={4}/>\n\nAfter"), ["Before", "", "After"]);
  assert.deepEqual(rows("a <Foo bar=\"1\"/>b <Unknown>kids</Unknown> c <span>s</span>"), ["a b kids c s"]);
});

test("components nest, and work inside lists and quotes", () => {
  assert.deepEqual(rows("<Note>\n  <Warning>\n    Nested\n  </Warning>\n</Note>"), ["┃ Note", "┃ ┃ Warning", "┃ ┃ Nested"]);
  assert.deepEqual(rows("- item\n\n  <Note>In a list</Note>\n\n> <Warning>In a quote</Warning>"), [
    "• item",
    "",
    "  ┃ Note",
    "  ┃ In a list",
    "",
    "│ ┃ Warning",
    "│ ┃ In a quote",
  ]);
});

test("import and export lines at the top level are dropped; elsewhere they are text", () => {
  const src = 'import { Tabs } from "@site/components";\nimport Callout from "../Callout";\nexport const meta = {\n  sidebar: "guides",\n};\n\n# Title\n\nexport default function Layout({ children }) { return children }\n\nBody.';
  assert.deepEqual(rows(src), ["Title", "━".repeat(40), "", "Body."]);
  // Inside code, a list or a paragraph they are content.
  assert.match(plain(md("```js\nimport x from 'y';\n```")), /import x from 'y';/);
  assert.deepEqual(rows("- import x from 'y'"), ["• import x from 'y'"]);
  assert.deepEqual(rows("Some text\nimport x from 'y'"), ["Some text import x from 'y'"]);
  // Prose that merely starts with the word stays.
  assert.deepEqual(rows("Import the module first."), ["Import the module first."]);
  assert.deepEqual(rows("export is a keyword."), ["export is a keyword."]);
});

test("expressions are shown as inline code; MDX comments and HTML comments are dropped", () => {
  const lines = md("Text {1 + 2} and {props.value}{/* gone */}.\n\n<!-- hidden -->\n\nAfter <!-- inline --> this.");
  assert.deepEqual(plain(lines).split("\n"), ["Text {1 + 2} and {props.value}.", "", "After  this."]);
  assert.equal(stylesOf(lines, "{1 + 2}")[0]?.fg, "synString");
  assert.equal(stylesOf(lines, "{props.value}")[0]?.fg, "synString");
  // Multi-line HTML comment at the block level.
  assert.deepEqual(rows("a\n\n<!--\nnothing\nhere\n-->\n\nb"), ["a", "", "b"]);
});

test("nothing is ever executed: expressions, attributes and ESM are text or dropped", () => {
  const g = globalThis as Record<string, unknown>;
  const src = [
    'import "data:text/javascript,globalThis.__mdxImported=1";',
    "export const x = (globalThis.__mdxExport = 1);",
    "",
    "Value {(() => { globalThis.__mdxExpr = 1; return 2 })()} and {process.exit(3)}.",
    "",
    '<Note title={(globalThis.__mdxAttr = "t")} onClick={() => { globalThis.__mdxClick = 1 }} {...(globalThis.__mdxSpread = {})}>',
    "Body {globalThis.__mdxChild = 1}",
    "</Note>",
    "",
    "<script>globalThis.__mdxScript = 1</script>",
    '<img src="x" onerror="globalThis.__mdxErr = 1" />',
  ].join("\n");
  const lines = md(src, 120);
  for (const k of ["__mdxImported", "__mdxExport", "__mdxExpr", "__mdxAttr", "__mdxClick", "__mdxSpread", "__mdxChild", "__mdxScript", "__mdxErr"]) {
    assert.equal(g[k], undefined, `${k} was never set`);
  }
  const text = plain(lines);
  assert.match(text, /\{\(\(\) => \{ globalThis\.__mdxExpr = 1; return 2 \}\)\(\)\}/, "the expression is shown, as written");
  assert.match(text, /\{process\.exit\(3\)\}/);
  assert.match(text, /┃ Note\n┃ Body \{globalThis\.__mdxChild = 1\}/, "an expression attribute is not used as the title");
  assert.match(text, /globalThis\.__mdxScript = 1/, "a script element's text is shown, not run");
  // Every span is text: there are no other kinds of output.
  for (const s of lines.flat()) assert.equal(typeof s.text, "string");
});

test("what fails to parse as JSX is the literal text it is, cleaned", () => {
  assert.deepEqual(rows("<Note>unterminated"), ["<Note>unterminated"]);
  assert.deepEqual(rows("x <b>unclosed bold and <Weird attr={ broken", 60), ["x <b>unclosed bold and <Weird attr={ broken"]);
  assert.deepEqual(rows("<Broken attr=\"unterminated\n\nnext"), ['<Broken attr="unterminated', "", "next"]);
  assert.deepEqual(rows("a < b and c > d, 1<2"), ["a < b and c > d, 1<2"]);
  const dirty = rows("<Note title=\"\u001b[31mred\">x\u0007</Note>");
  for (const r of dirty) assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(r), JSON.stringify(r));
});

test("while streaming, an unfinished element renders what has arrived", () => {
  assert.deepEqual(rows("<Note>\nHalf a sentence", 40, true), ["┃ Note", "┃ Half a sentence"]);
  assert.deepEqual(rows("Intro\n\n<Callout type=\"warn", 40, true), ["Intro"]);
  assert.deepEqual(rows(":::tip\nArriving", 40, true), ["┃ Tip", "┃ Arriving"]);
});
