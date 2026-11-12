/**
 * Links: the text, then the real destination in full; shown once when the text is the address; only http(s) and
 * mailto become openable; addresses are cleaned and can never hide part of themselves.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Line } from "../src/tui/full/types.js";
import { address, textIsAddress, trimBareUrl } from "../src/tui/md/links.js";
import { md, plain } from "./fixtures/md/helpers.js";

/** Text of a rendering with each linked span marked `{→address}`. */
function marked(lines: Line[]): string {
  return lines.map((l) => l.map((s) => s.text + (s.style?.link ? `{→${s.style.link}}` : "")).join("")).join("\n");
}
const show = (src: string): string => marked(md(src, 200));

test("a link shows its text, then the address in full in muted text", () => {
  const lines = md("Read [the docs](https://example.com/a?b=1#c) now.", 200);
  assert.equal(plain(lines), "Read the docs (https://example.com/a?b=1#c) now.");
  const addr = lines[0]!.find((s) => s.text.startsWith("(https:"))!;
  assert.equal(addr.style?.fg, "muted");
  assert.equal(addr.style?.link, "https://example.com/a?b=1#c");
  const text = lines[0]!.find((s) => s.text === "the docs")!;
  // Only the address opens anything: what a terminal opens is exactly what is shown.
  assert.equal(text.style?.link, undefined);
  assert.equal(text.style?.underline, true);
});

test("when the text is the address it is shown once", () => {
  assert.equal(show("[https://same.example/x](https://same.example/x)"), "https://same.example/x{→https://same.example/x}");
  // Shown once, as the destination (not the text) when the two differ only in form.
  assert.equal(show("[https://same.example](https://same.example/)"), "https://same.example/{→https://same.example/}");
  assert.equal(show("<https://auto.example/x>."), "https://auto.example/x{→https://auto.example/x}.");
  assert.equal(show("Mail <me@example.com>."), "Mail me@example.com{→mailto:me@example.com}.");
  assert.equal(show("[me@example.com](mailto:me@example.com)"), "me@example.com{→mailto:me@example.com}");
});

test("deceptive text: a link whose text looks like another address shows both, so the mismatch is visible", () => {
  assert.equal(
    show("[https://good.example](https://evil.example)"),
    "https://good.example (https://evil.example){→https://evil.example/}",
  );
  assert.equal(show("[good.example](https://evil.example/login)"), "good.example (https://evil.example/login){→https://evil.example/login}");
  // Userinfo tricks keep the real host visible.
  assert.match(plain(md("[x](https://good.example@evil.example/)", 200)), /\(https:\/\/good\.example@evil\.example\/\)/);
  // A look-alike host is shown as the punycode a browser would contact.
  assert.match(plain(md("[x](https://exаmple.com/)", 200)), /\(https:\/\/xn--exmple-4nf\.com\/\)/);
});

test("only http, https and mailto get a link; everything else is shown as text", () => {
  for (const dest of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html;base64,AAAA", "file:///etc/passwd", "//evil.example/x", "/relative/path", "vbscript:x", "ftp://files.example/a"]) {
    const lines = md(`[click](${dest})`, 200);
    assert.ok(lines.flat().every((s) => !s.style?.link), `${dest} is not linked`);
    assert.equal(plain(lines), `click (${dest})`, `${dest} is shown in full`);
  }
  assert.equal(show("<javascript:alert(1)>"), "javascript:alert(1)");
  assert.equal(show("[x](mailto:a@b.example)"), "x (mailto:a@b.example){→mailto:a@b.example}");
});

test("addresses with spaces, parentheses, angle brackets, titles and references", () => {
  assert.equal(show("[x](<https://a.example/a b>)"), "x (https://a.example/a%20b){→https://a.example/a%20b}");
  assert.equal(show("[x](https://a.example/a_(b))"), "x (https://a.example/a_(b)){→https://a.example/a_(b)}");
  assert.equal(show("[x](https://a.example 'title')"), "x (https://a.example){→https://a.example/}");
  // An angle bracket cannot open inside an angle-bracketed address: not a link, shown as written.
  assert.equal(show("[x](<https://a.example/<b>>)"), "[x](<https://a.example/<b>>)");
  // Reference links (full, collapsed, shortcut), case-insensitive labels, first definition wins.
  const refs = "[full][R] [r][] [r]\n\n[r]: <https://r.example/a b>\n[r]: https://second.example";
  assert.equal(plain(md(refs, 200)), "full (https://r.example/a%20b) r (https://r.example/a%20b) r (https://r.example/a%20b)");
  // An undefined reference is the text it is.
  assert.equal(plain(md("[nothing][here]", 200)), "[nothing][here]");
});

test("escape sequences, controls, bidi and invisible characters never reach an address", () => {
  const cases = [
    "[x](https://a.example/\u001b[31mred)",
    "[x](https://a.example/\u001b]8;;https://evil.example\u0007)",
    "[x](https://a.example/‮gnp.exe)",
    "[x](https://a.example/a​b)",
    "[x](https://a.example/\u0007bell)",
    "[x](https://a.example/⁦x⁩)",
    "[x](<https://a.example/ nbsp>)",
    "<https://a.example/\u009b31m>",
  ];
  for (const c of cases) {
    const lines = md(c, 200);
    for (const s of lines.flat()) {
      assert.ok(!/[\u0000-\u001f\u007f- ​-‏‪-‮⁦-⁩]/.test(s.text), `${JSON.stringify(c)}: clean text ${JSON.stringify(s.text)}`);
      if (s.style?.link) assert.ok(!/[\u0000- \u007f- ​-‏‪-‮⁦-⁩]/.test(s.style.link), `${JSON.stringify(c)}: clean link`);
    }
    // What is shown in brackets is exactly what the link opens.
    const shown = /\((https:[^)]*)\)/.exec(plain(lines))?.[1];
    const link = lines.flat().find((s) => s.style?.link)?.style?.link;
    if (shown && link) assert.equal(new URL(shown).href, link, `${JSON.stringify(c)}: shown is the destination`);
  }
  // address() itself, on raw text that never passed sanitise.
  assert.equal(address("https://a.example/‮x").shown, "https://a.example/%E2%80%AEx");
  assert.equal(address("javascript:\u0000alert(1)").shown, "javascript:%00alert(1)");
  assert.equal(address("javascript:alert(1)").link, undefined);
  assert.equal(address("x".repeat(5000)).shown.length, 2001);
});

test("an image inside a link shows the image and the link's address", () => {
  const out = show("[![logo](https://img.example/l.png)](https://site.example)");
  assert.equal(out, "[image: logo] https://img.example/l.png{→https://img.example/l.png} (https://site.example){→https://site.example/}");
});

test("bare addresses become links without their trailing punctuation", () => {
  assert.equal(
    show("see https://bare.example/x. and (https://bare.example/y) and https://bare.example/z), www.example.com!"),
    "see https://bare.example/x{→https://bare.example/x}. and (https://bare.example/y{→https://bare.example/y}) and https://bare.example/z{→https://bare.example/z}), http://www.example.com{→http://www.example.com/}!",
  );
  assert.equal(trimBareUrl("https://a.example/wiki/Foo_(bar))."), "https://a.example/wiki/Foo_(bar)");
  assert.equal(trimBareUrl("https://a.example/?q=1&amp;"), "https://a.example/?q=1");
  // A non-ASCII look-alike host is not turned into a link from prose.
  assert.equal(show("go to https://exаmple.com now"), "go to https://exаmple.com now");
  // Not inside a word, and not inside code.
  assert.equal(show("xhttps://a.example `https://b.example`"), "xhttps://a.example https://b.example");
});

test("textIsAddress compares parsed addresses, not just strings", () => {
  const a = address("https://example.com/");
  assert.ok(textIsAddress("https://example.com", "https://example.com/", a));
  assert.ok(!textIsAddress("https://example.org", "https://example.com/", a));
  assert.ok(textIsAddress("", "https://example.com/", a));
});

test("a long address wraps across lines without overflowing and keeps its link on every piece", () => {
  const url = `https://example.com/${"segment/".repeat(20)}end`;
  const lines = md(`See [docs](${url}) please.`, 30);
  const linked = lines.flat().filter((s) => s.style?.link);
  assert.ok(linked.length >= 3);
  assert.ok(linked.every((s) => s.style?.link === url));
  assert.ok(plain(lines).replace(/\n/g, "").includes(url));
});
