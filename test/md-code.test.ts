/** Code: the highlighter's per-language tables, and code blocks in Markdown (background, label, wrapping). */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Line, Role } from "../src/tui/full/types.js";
import { highlightCode } from "../src/tui/md/index.js";
import { findLanguage, parseInfo } from "../src/tui/md/languages.js";
import { md, plain, width } from "./fixtures/md/helpers.js";

/** The role given to the first span whose text is exactly `token`. */
function roleOf(lines: Line[], token: string): Role | undefined | "missing" {
  for (const l of lines) for (const s of l) if (s.text === token) return s.style?.fg;
  return "missing";
}

const hl = (code: string, lang: string): Line[] => highlightCode(code, lang);

test("one line per source line, tabs expanded, text unchanged", () => {
  const code = "a\n\tb\n\n  c\td";
  const lines = hl(code, "ts");
  assert.equal(lines.length, 4);
  assert.deepEqual(plain(lines).split("\n"), ["a", "    b", "", "  c d"]);
  assert.equal(hl("x\ny", "nothing-known").length, 2);
  assert.deepEqual(hl("", "ts"), [[]]);
});

test("unknown and missing languages render plain", () => {
  for (const lang of [undefined, "", "brainfuck", "x-y"]) {
    const lines = highlightCode("const x = 1; // c", lang);
    assert.deepEqual(lines, [[{ text: "const x = 1; // c" }]]);
  }
});

test("TypeScript / JavaScript / JSX / TSX: keywords, types, strings, numbers, comments, functions, decorators", () => {
  const lines = hl('import { x } from "y";\nconst n: number = 0x1F + 2.5e3; /* a\n b */ foo(`t ${n}`);\n@Dec class Alpha {}', "ts");
  assert.equal(roleOf(lines, "import"), "synKeyword");
  assert.equal(roleOf(lines, '"y"'), "synString");
  assert.equal(roleOf(lines, "number"), "synType");
  assert.equal(roleOf(lines, "0x1F"), "synNumber");
  assert.equal(roleOf(lines, "2.5e3"), "synNumber");
  assert.equal(roleOf(lines, "/* a"), "synComment");
  assert.equal(roleOf(lines, " b */"), "synComment", "a block comment spans lines");
  assert.equal(roleOf(lines, "foo"), "synFunction");
  assert.equal(roleOf(lines, "`t ${n}`"), "synString");
  assert.equal(roleOf(lines, "@Dec"), "synFunction");
  assert.equal(roleOf(lines, "Alpha"), "synType");
  assert.equal(roleOf(lines, ";"), "synPunct");
  for (const alias of ["js", "javascript", "jsx", "tsx", "mjs", "typescript"]) assert.equal(findLanguage(alias)?.name, "typescript", alias);
  const multi = hl("const s = `one\ntwo` + 1;", "js");
  assert.equal(roleOf(multi, "two`"), "synString", "a template literal spans lines");
  assert.equal(roleOf(hl('const el = <div className="a">{x}</div>;', "tsx"), '"a"'), "synString");
});

test("JSON: keys, strings, numbers, constants", () => {
  const lines = hl('{"key": "v", "n": -1.5, "b": true, "z": null}', "jsonc");
  assert.equal(roleOf(lines, '"key"'), "synKeyword");
  assert.equal(roleOf(lines, '"v"'), "synString");
  assert.equal(roleOf(lines, "1.5"), "synNumber");
  assert.equal(roleOf(lines, "true"), "synNumber");
  assert.equal(roleOf(lines, "null"), "synNumber");
});

test("Python: triple-quoted strings across lines, decorators, comments, constants", () => {
  const lines = hl('@dec\ndef f(a: int) -> str:\n    """doc\n    more"""\n    return \'x\'  # c\nNone', "py");
  assert.equal(roleOf(lines, "@dec"), "synFunction");
  assert.equal(roleOf(lines, "def"), "synKeyword");
  assert.equal(roleOf(lines, "f"), "synFunction");
  assert.equal(roleOf(lines, "int"), "synType");
  assert.equal(roleOf(lines, '"""doc'), "synString");
  assert.equal(roleOf(lines, '    more"""'), "synString");
  assert.equal(roleOf(lines, "# c"), "synComment");
  assert.equal(roleOf(lines, "None"), "synNumber");
});

test("shells: variables, builtins, comments only after whitespace; console prompts dimmed", () => {
  const lines = hl('if [ -f "$HOME/x" ]; then echo ${VAR} a#b # c\nfi', "bash");
  assert.equal(roleOf(lines, "if"), "synKeyword");
  assert.equal(roleOf(lines, '"$HOME/x"'), "synString");
  assert.equal(roleOf(lines, "${VAR}"), "synType");
  assert.equal(roleOf(lines, "echo"), "synType");
  assert.equal(roleOf(lines, "# c"), "synComment");
  assert.ok(!plain(lines).includes("#b # c") || roleOf(lines, "#b # c") !== "synComment", "a # inside a word is not a comment");
  for (const alias of ["sh", "zsh", "shell"]) assert.equal(findLanguage(alias)?.name, "shell", alias);
  const con = hl("$ npm install\nadded 3 packages\nuser@host:~$ ls", "console");
  const prompt = con[0]![0]!;
  assert.equal(prompt.text, "$ ");
  assert.equal(prompt.style?.dim, true);
  assert.equal(roleOf(con, "npm"), "synType");
  assert.deepEqual(con[1], [{ text: "added 3 packages" }], "output lines are plain");
  assert.equal(con[2]![0]!.style?.dim, true);
});

test("Go, Rust, SQL", () => {
  const go = hl('package main\nfunc main() { fmt.Println("hi", 42) } // c\nvar x int = nil', "golang");
  assert.equal(roleOf(go, "func"), "synKeyword");
  assert.equal(roleOf(go, "Println"), "synFunction");
  assert.equal(roleOf(go, "int"), "synType");
  assert.equal(roleOf(go, "nil"), "synNumber");
  assert.equal(roleOf(go, "// c"), "synComment");
  const rs = hl("fn main() { let s: &'static str = \"x\"; println!(\"{}\", 'c'); }", "rs");
  assert.equal(roleOf(rs, "fn"), "synKeyword");
  assert.equal(roleOf(rs, "'static"), "synType", "a lifetime is not a string");
  assert.equal(roleOf(rs, "'c'"), "synString");
  assert.equal(roleOf(rs, "println!"), "synFunction");
  const sql = hl("select id FROM users WHERE name = 'x'; -- c", "sql");
  assert.equal(roleOf(sql, "select"), "synKeyword", "case-insensitive keywords");
  assert.equal(roleOf(sql, "'x'"), "synString");
  assert.equal(roleOf(sql, "-- c"), "synComment");
});

test("YAML, TOML, HTML/XML, CSS, Markdown, Dockerfile, diff", () => {
  const yaml = hl('key: value # c\nlist:\n  - "quoted"\n  - 42\nflag: true', "yml");
  assert.equal(roleOf(yaml, "key"), "synKeyword");
  assert.equal(roleOf(yaml, '"quoted"'), "synString");
  assert.equal(roleOf(yaml, "42"), "synNumber");
  assert.equal(roleOf(yaml, "# c"), "synComment");
  const toml = hl('[section]\nkey = "v" # c', "toml");
  assert.equal(roleOf(toml, "[section]"), "synType");
  assert.equal(roleOf(toml, "key"), "synKeyword");
  assert.equal(roleOf(toml, '"v"'), "synString");
  const html = hl('<!-- c -->\n<a href="x">text</a>', "xml");
  assert.equal(roleOf(html, "<!-- c -->"), "synComment");
  assert.equal(roleOf(html, "a"), "synKeyword");
  assert.equal(roleOf(html, "href"), "synType");
  assert.equal(roleOf(html, '"x"'), "synString");
  const css = hl(".cls { color: #fff; margin: 0 auto; } /* c */", "scss");
  assert.equal(roleOf(css, ".cls"), "synFunction");
  assert.equal(roleOf(css, "color"), "synKeyword");
  assert.equal(roleOf(css, "#fff"), "synNumber");
  assert.equal(roleOf(css, "/* c */"), "synComment");
  const mdx = hl("# Title\n- item `code`", "mdx");
  assert.equal(roleOf(mdx, "# Title"), "synKeyword");
  assert.equal(roleOf(mdx, "`code`"), "synString");
  const docker = hl("FROM node:24\nRUN npm ci # c\nENV A=$B", "dockerfile");
  assert.equal(roleOf(docker, "FROM"), "synKeyword");
  assert.equal(roleOf(docker, "$B"), "synType");
  assert.equal(roleOf(docker, "# c"), "synComment");
  const diff = hl("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n ctx", "patch");
  assert.equal(roleOf(diff, "-old"), "removed");
  assert.equal(roleOf(diff, "+new"), "added");
  assert.equal(roleOf(diff, "@@ -1 +1 @@"), "info");
});

test("the highlighter cleans its input: escape sequences and controls are shown, never passed through", () => {
  const lines = hl('const s = "\u001b[2J\u001b]52;c;aGk=\u0007"; // \u009b31m ‮', "ts");
  for (const s of lines.flat()) assert.ok(!/[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮]/.test(s.text), JSON.stringify(s.text));
  assert.match(plain(lines), /\[2J/);
});

test("a long line takes linear time, whatever the language", () => {
  const nasty = ['"'.repeat(100_000), "/*".repeat(50_000), "${".repeat(50_000), "<".repeat(100_000), `${"a".repeat(99_000)} "x /* <a`];
  for (const lang of ["ts", "json", "python", "sh", "console", "go", "rust", "sql", "yaml", "toml", "html", "css", "md", "dockerfile", "diff"]) {
    for (const s of nasty) {
      const t = performance.now();
      const lines = highlightCode(s, lang);
      const ms = performance.now() - t;
      assert.equal(lines.length, 1);
      assert.ok(ms < 500, `${lang} took ${ms.toFixed(0)} ms`);
    }
  }
});

test("info strings: language aliases, titles, file names, line ranges", () => {
  assert.deepEqual(parseInfo('ts title="src/app.ts"'), { lang: "ts", title: "src/app.ts" });
  assert.deepEqual(parseInfo("bash npm"), { lang: "bash", title: "npm" });
  assert.deepEqual(parseInfo("ts:src/app.ts"), { lang: "ts", title: "src/app.ts" });
  assert.deepEqual(parseInfo("src/app.py"), { lang: "py", title: "src/app.py" });
  assert.deepEqual(parseInfo("js {1,3-4}"), { lang: "js", title: "" });
  assert.deepEqual(parseInfo("Dockerfile"), { lang: "Dockerfile", title: "" });
  assert.deepEqual(parseInfo(""), { lang: "", title: "" });
});

test("a code block is a clean codeBg rectangle with its label on top and long lines wrapped with ↪", () => {
  const w = 40;
  const lines = md('```ts title="src/app.ts"\nconst long = "a very long string that goes on and on and on past the edge";\nshort();\n```', w);
  assert.deepEqual(plain(lines).split("\n"), [
    "  src/app.ts · ts                       ",
    '  const long = "a very long string that ',
    '↪  goes on and on and on past the edge" ',
    "↪ ;                                     ",
    "  short();                              ",
    "                                        ",
  ]);
  for (const l of lines) {
    assert.equal(width(l), w, "every row is the full width");
    assert.ok(l.every((s) => s.style?.bg === "codeBg"), "every cell has the code background");
  }
  assert.equal(lines[0]!.find((s) => s.text.includes("src/app.ts"))?.style?.fg, "muted");
  assert.equal(lines.flat().find((s) => s.text === "const")?.style?.fg, "synKeyword");
  assert.equal(lines[2]![0]!.text.startsWith("↪"), true);
});

test("indented code, unlabelled fences, tildes, an unclosed fence and wide characters in code", () => {
  assert.deepEqual(plain(md("    indented\n\tline", 20)).split("\n").map((l) => l.trimEnd()), ["", "  indented", "  line", ""]);
  assert.deepEqual(plain(md("~~~\nplain\n~~~", 20)).split("\n").map((l) => l.trimEnd()), ["", "  plain", ""]);
  const open = md("```py\nprint(1)", 20, false);
  assert.match(plain(open), /print\(1\)/, "an unclosed fence at the end is code to the end");
  // A fence inside code is text; a longer fence closes only on its own length.
  assert.match(plain(md("````md\n```js\nx\n```\n````", 30)), /```js *\n *x *\n *```/);
  const cjk = md("```\n日本語日本語日本語日本語日本語日本語\n```", 20);
  for (const l of cjk) assert.equal(width(l), 20);
});

test("a fence containing JSX, Markdown or HTML is left verbatim", () => {
  const src = "```jsx\n<Callout type=\"warning\">**hi** {x}</Callout>\nimport y from 'y';\n```";
  assert.match(plain(md(src, 60)), /<Callout type="warning">\*\*hi\*\* \{x\}<\/Callout>/);
  assert.match(plain(md(src, 60)), /import y from 'y';/);
});
