import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Editor } from "../src/tui/full/editor.js";
import type { Input } from "../src/tui/full/types.js";
import { historyFile } from "../src/tui/input.js";

const key = (name: string, m: { ctrl?: boolean; alt?: boolean; shift?: boolean; text?: string } = {}): Input => {
  const k: Input = { type: "key", name, ctrl: m.ctrl ?? false, alt: m.alt ?? false, shift: m.shift ?? false };
  if (m.text !== undefined) k.text = m.text;
  return k;
};
const type = (e: Editor, s: string) => {
  for (const ch of s) e.handle(key(ch === " " ? "space" : ch.toLowerCase(), { text: ch }));
};
const ctrl = (n: string) => key(n, { ctrl: true });
const alt = (n: string) => key(n, { alt: true });

test("editor: typing, grapheme-aware cursor, backspace and delete", () => {
  const e = new Editor();
  type(e, "aé👨‍👩‍👧z");
  assert.equal(e.text, "aé👨‍👩‍👧z");
  e.handle(key("left"));
  e.handle(key("left"));
  e.handle(key("backspace"));
  assert.equal(e.text, "a👨‍👩‍👧z", "e + mark removed as one");
  e.handle(key("delete"));
  assert.equal(e.text, "az", "the family emoji deleted as one");
  e.handle(key("home"));
  e.handle(key("delete"));
  assert.equal(e.text, "z");
  assert.equal(e.handle(key("backspace")), "ignored");
});

test("editor: Enter submits; Shift/Alt-Enter, Ctrl-J and a trailing backslash make new lines", () => {
  const e = new Editor();
  type(e, "one");
  assert.equal(e.handle(key("enter")), "submit");
  assert.equal(e.handle(key("enter", { shift: true })), "changed");
  type(e, "two");
  e.handle(key("enter", { alt: true }));
  type(e, "three");
  e.handle(ctrl("j"));
  type(e, "four\\");
  assert.equal(e.handle(key("enter")), "changed");
  assert.equal(e.text, "one\ntwo\nthree\nfour\n");
});

test("editor: word motions and kills, yank", () => {
  const e = new Editor();
  type(e, "git commit --amend now");
  e.handle(ctrl("w"));
  assert.equal(e.text, "git commit --amend ");
  e.handle(alt("backspace"));
  assert.equal(e.text, "git commit --");
  e.handle(ctrl("y"));
  assert.equal(e.text, "git commit --amend ");
  e.handle(alt("b"));
  assert.equal(e.cursor, "git commit --".length);
  e.handle(key("left", { ctrl: true }));
  assert.equal(e.cursor, "git ".length);
  e.handle(alt("f"));
  assert.equal(e.cursor, "git commit".length);
  e.handle(key("right", { alt: true }));
  assert.equal(e.cursor, "git commit --amend".length);
  e.handle(ctrl("a"));
  e.handle(ctrl("k"));
  assert.equal(e.text, "");
  e.handle(ctrl("y"));
  assert.equal(e.text, "git commit --amend ");
  e.handle(ctrl("e"));
  e.handle(ctrl("u"));
  assert.equal(e.text, "");
});

test("editor: Up and Down move between lines, then through history at the edges", () => {
  const e = new Editor({ history: ["first", "second"] });
  type(e, "draft");
  assert.equal(e.handle(key("up")), "changed");
  assert.equal(e.text, "second");
  e.handle(key("up"));
  assert.equal(e.text, "first");
  assert.equal(e.handle(key("up")), "ignored");
  e.handle(key("down"));
  e.handle(key("down"));
  assert.equal(e.text, "draft", "the draft comes back");
  e.setText("line one\nline two");
  e.lines(40);
  e.handle(key("up"));
  assert.equal(e.text, "line one\nline two", "Up on the second line moves, not history");
  assert.equal(e.cursor, "line one".length);
  e.handle(key("down"));
  assert.equal(e.cursor, "line one\nline two".length);
  assert.equal(e.handle(key("down")), "ignored");
});

test("editor: history uses the inline prompt's file and rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "memtro-ed-"));
  const file = historyFile(join(dir, "sessions"), "/work");
  const e = new Editor({ historyPath: file });
  for (const t of ["kept", " secret with a space", "has sk-memtro-abc123 key", "two\nlines"]) {
    e.setText(t);
    e.take();
  }
  assert.deepEqual(e.entries, ["kept"]);
  assert.equal(readFileSync(file, "utf8"), '"kept"\n');
  const again = new Editor({ historyPath: file });
  again.handle(key("up"));
  assert.equal(again.text, "kept");
});

test("editor: a large paste is one chip, deleted as a unit and expanded on take", () => {
  const e = new Editor();
  type(e, "see: ");
  const block = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  e.handle({ type: "paste", text: block.replace(/\n/g, "\r\n") });
  type(e, " ok");
  const view = e.lines(80);
  assert.equal(view.lines[0]!.map((s) => s.text).join(""), "see: [pasted 12 lines] ok");
  assert.equal(e.text, `see: ${block} ok`);
  e.handle(key("end"));
  e.handle(key("left"));
  e.handle(key("left"));
  e.handle(key("left"));
  e.handle(key("backspace"));
  assert.equal(e.text, "see:  ok", "the chip goes as one");
  e.handle({ type: "paste", text: "x".repeat(900) });
  assert.match(e.lines(80).lines[0]!.map((s) => s.text).join(""), /\[pasted 900 characters\]/);
  e.handle({ type: "paste", text: "small\npaste" });
  assert.ok(e.text.endsWith("small\npaste ok"));
  const sent = e.take();
  assert.ok(sent.includes("x".repeat(900)));
  assert.equal(e.text, "");
});

test("editor: a pasted stand-in character cannot fake a chip", () => {
  const e = new Editor();
  e.handle({ type: "paste", text: "a\u{F0000}b" });
  assert.equal(e.text, "ab");
});

test("editor: lines soft-wrap and report the cursor cell", () => {
  const e = new Editor();
  type(e, "hello world again");
  let v = e.lines(10);
  assert.deepEqual(v.lines.map((l) => l.map((s) => s.text).join("")), ["hello ", "world ", "again"]);
  assert.deepEqual(v.cursor, { x: 5, y: 2 });
  e.setText("abcdefghij");
  v = e.lines(10);
  assert.deepEqual(v.cursor, { x: 0, y: 1 }, "a full row puts the cursor on the next");
  e.setText("日本語");
  v = e.lines(4);
  assert.deepEqual(v.lines.map((l) => l.map((s) => s.text).join("")), ["日本", "語"]);
  assert.deepEqual(v.cursor, { x: 2, y: 1 });
  e.setText("a\tb\u001b");
  v = e.lines(20);
  assert.equal(v.lines[0]!.map((s) => s.text).join(""), "a   b␛", "tabs expand and controls are shown, not sent");
  e.setText("one\n\nthree", 4);
  v = e.lines(20);
  assert.deepEqual(v.cursor, { x: 0, y: 1 });
  assert.equal(v.lines.length, 3);
});

test("editor: Up and Down move by visual row when wrapped", () => {
  const e = new Editor();
  type(e, "aaaa bbbb cccc");
  e.lines(5);
  e.handle(key("up"));
  assert.equal(e.cursor, "aaaa ".length + 4);
});
