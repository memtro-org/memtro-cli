import assert from "node:assert/strict";
import { test } from "node:test";
import type { Input } from "../src/tui/full/types.js";
import { InputDecoder, PASTE_CUT_NOTE, PASTE_MAX_BYTES, type Reply } from "../src/tui/full/screen/input.js";

type K = { name: string; ctrl?: boolean; alt?: boolean; shift?: boolean; text?: string };
const k = (name: string, m: Partial<K> = {}): Input => {
  const out: Input = { type: "key", name, ctrl: m.ctrl ?? false, alt: m.alt ?? false, shift: m.shift ?? false };
  if (m.text !== undefined) out.text = m.text;
  return out;
};
const C = { ctrl: true };
const A = { alt: true };
const S = { shift: true };

function decode(bytes: string | Buffer, replies?: Reply[]): Input[] {
  const d = new InputDecoder((r) => replies?.push(r));
  return [...d.feed(typeof bytes === "string" ? Buffer.from(bytes, "latin1") : bytes), ...d.flush()];
}

/** Every vector split at every byte offset (and fed one byte at a time) decodes the same. */
function decodeSplit(bytes: Buffer): Input[][] {
  const results: Input[][] = [];
  for (let cut = 1; cut < bytes.length; cut++) {
    const d = new InputDecoder();
    results.push([...d.feed(bytes.subarray(0, cut)), ...d.feed(bytes.subarray(cut)), ...d.flush()]);
  }
  const d = new InputDecoder();
  const one: Input[] = [];
  for (let i = 0; i < bytes.length; i++) one.push(...d.feed(bytes.subarray(i, i + 1)));
  one.push(...d.flush());
  results.push(one);
  return results;
}

// [terminal, bytes (latin1 escapes), expected]
const VECTORS: Array<[string, string, Input[]]> = [
  // arrows: normal and application cursor mode
  ["xterm", "\x1b[A", [k("up")]],
  ["xterm", "\x1b[B", [k("down")]],
  ["xterm", "\x1b[C", [k("right")]],
  ["xterm", "\x1b[D", [k("left")]],
  ["xterm app mode / tmux", "\x1bOA", [k("up")]],
  ["xterm app mode", "\x1bOD", [k("left")]],
  // Home/End
  ["xterm", "\x1b[H", [k("home")]],
  ["xterm", "\x1b[F", [k("end")]],
  ["xterm app mode", "\x1bOH", [k("home")]],
  ["Linux console / tmux", "\x1b[1~", [k("home")]],
  ["Linux console / tmux", "\x1b[4~", [k("end")]],
  ["rxvt", "\x1b[7~", [k("home")]],
  ["rxvt", "\x1b[8~", [k("end")]],
  // Page, insert, delete
  ["xterm", "\x1b[5~", [k("pageup")]],
  ["xterm", "\x1b[6~", [k("pagedown")]],
  ["xterm", "\x1b[2~", [k("insert")]],
  ["xterm", "\x1b[3~", [k("delete")]],
  ["xterm shift-delete", "\x1b[3;2~", [k("delete", S)]],
  ["xterm ctrl-pageup", "\x1b[5;5~", [k("pageup", C)]],
  // Function keys
  ["xterm", "\x1bOP", [k("f1")]],
  ["xterm", "\x1bOS", [k("f4")]],
  ["xterm", "\x1b[15~", [k("f5")]],
  ["xterm", "\x1b[24~", [k("f12")]],
  ["xterm shift-F1", "\x1b[1;2P", [k("f1", S)]],
  ["xterm ctrl-F3 (not a cursor report)", "\x1b[1;5R", [k("f3", C)]],
  ["Linux console", "\x1b[[A", [k("f1")]],
  ["Linux console", "\x1b[[E", [k("f5")]],
  ["Terminal.app shift-F5", "\x1b[25~", [k("f13")]],
  // Shift-Tab
  ["xterm", "\x1b[Z", [k("tab", S)]],
  // Modified arrows
  ["xterm ctrl-left", "\x1b[1;5D", [k("left", C)]],
  ["xterm alt-right", "\x1b[1;3C", [k("right", A)]],
  ["xterm shift-up", "\x1b[1;2A", [k("up", S)]],
  ["xterm ctrl-shift-end", "\x1b[1;6F", [k("end", { ctrl: true, shift: true })]],
  ["iTerm2 meta (as alt)", "\x1b[1;9D", [k("left", A)]],
  ["rxvt ctrl-up", "\x1bOa", [k("up", C)]],
  ["rxvt shift-up", "\x1b[a", [k("up", S)]],
  ["iTerm2/xterm alt-arrow as ESC prefix", "\x1b\x1b[D", [k("left", A)]],
  ["Terminal.app option-left (meta)", "\x1bb", [k("b", A)]],
  ["Terminal.app option-right (meta)", "\x1bf", [k("f", A)]],
  // Control keys
  ["any: Enter", "\r", [k("enter")]],
  ["any: Ctrl-J", "\n", [k("j", C)]],
  ["any: Tab", "\t", [k("tab")]],
  ["xterm/iTerm2: Backspace", "\x7f", [k("backspace")]],
  ["some configs: Backspace as BS", "\x08", [k("backspace")]],
  ["any: Ctrl-A", "\x01", [k("a", C)]],
  ["any: Ctrl-W", "\x17", [k("w", C)]],
  ["any: Ctrl-C", "\x03", [k("c", C)]],
  ["any: Ctrl-Space", "\x00", [k("space", C)]],
  ["any: Ctrl-_", "\x1f", [k("/", C)]],
  // Alt combinations
  ["xterm: Alt-Enter", "\x1b\r", [k("enter", A)]],
  ["xterm: Alt-Backspace", "\x1b\x7f", [k("backspace", A)]],
  ["xterm: Alt-x", "\x1bx", [k("x", A)]],
  ["xterm: Alt-X", "\x1bX", [k("x", { alt: true, shift: true })]],
  ["xterm: Ctrl-Alt-a", "\x1b\x01", [k("a", { ctrl: true, alt: true })]],
  ["xterm: Alt-] is not an OSC", "\x1b]", [k("]", A)]],
  ["xterm: Alt-P is not a DCS", "\x1bP", [k("p", { alt: true, shift: true })]],
  ["xterm: Alt-_ is not an APC", "\x1b_", [k("_", A)]],
  // Printable
  ["any: letters", "ab", [k("a", { text: "a" }), k("b", { text: "b" })]],
  ["any: capital", "Q", [k("q", { text: "Q", shift: true })]],
  ["any: space", " ", [k("space", { text: " " })]],
  ["any: punctuation", "/", [k("/", { text: "/" })]],
  // CSI-u (kitty keyboard, fixterms) and modifyOtherKeys
  ["kitty: Shift-Enter", "\x1b[13;2u", [k("enter", S)]],
  ["kitty: Escape", "\x1b[27u", [k("escape")]],
  ["kitty: Ctrl-a", "\x1b[97;5u", [k("a", C)]],
  ["kitty: Alt-Enter", "\x1b[13;3u", [k("enter", A)]],
  ["kitty: Ctrl-Backspace", "\x1b[127;5u", [k("backspace", C)]],
  ["kitty: shifted key with alternate", "\x1b[97:65;2u", [k("a", { shift: true, text: "A" })]],
  ["kitty: key release is ignored", "\x1b[97;1:3u", []],
  ["kitty: keypad enter", "\x1b[57414u", [k("enter")]],
  ["kitty: lone modifier key is ignored", "\x1b[57441;2u", []],
  ["xterm modifyOtherKeys: Shift-Enter", "\x1b[27;2;13~", [k("enter", S)]],
  ["xterm modifyOtherKeys: Ctrl-i", "\x1b[27;5;105~", [k("i", C)]],
  ["tmux extended keys: Ctrl-Shift-Enter", "\x1b[27;6;13~", [k("enter", { ctrl: true, shift: true })]],
  // Focus
  ["xterm: focus in", "\x1b[I", [{ type: "focus", focused: true }]],
  ["xterm: focus out", "\x1b[O", [{ type: "focus", focused: false }]],
  // Mouse: wheel surfaced, the rest dropped
  ["SGR wheel up", "\x1b[<64;10;5M", [{ type: "wheel", direction: "up", x: 9, y: 4 }]],
  ["SGR wheel down", "\x1b[<65;1;1M", [{ type: "wheel", direction: "down", x: 0, y: 0 }]],
  ["SGR wheel with ctrl", "\x1b[<80;3;3M", [{ type: "wheel", direction: "up", x: 2, y: 2 }]],
  ["SGR click dropped", "\x1b[<0;10;5M\x1b[<0;10;5m", []],
  ["SGR motion dropped", "\x1b[<35;10;5M", []],
  ["SGR horizontal wheel dropped", "\x1b[<66;10;5M", []],
  ["X10 mouse dropped", "\x1b[M !!", []],
  // Unknown sequences dropped whole
  ["unknown CSI", "\x1b[99;99X", []],
  ["unknown CSI then a key", "\x1b[?1;2;3zq", [k("q", { text: "q" })]],
  ["OSC 52 from a hostile source is not typed", "\x1b]52;c;aGVsbG8=\x07", []],
];

for (const [term, bytes, expected] of VECTORS) {
  test(`input: ${term} ${JSON.stringify(bytes)}`, () => {
    const buf = Buffer.from(bytes, "latin1");
    assert.deepEqual(decode(buf), expected);
    for (const r of decodeSplit(buf)) assert.deepEqual(r, expected, "split at a byte boundary");
  });
}

test("input: UTF-8 split across chunks", () => {
  const bytes = Buffer.from("é日😀", "utf8");
  for (const r of decodeSplit(bytes)) {
    assert.deepEqual(
      r.map((i) => (i.type === "key" ? i.text : null)),
      ["é", "日", "😀"],
    );
  }
});

test("input: a lone Escape waits for flush; Escape then a key quickly is Alt", () => {
  const d = new InputDecoder();
  assert.deepEqual(d.feed(Buffer.from("\x1b")), []);
  assert.equal(d.pending, "escape");
  assert.deepEqual(d.flush(), [k("escape")]);
  assert.equal(d.pending, "none");
  assert.deepEqual(d.feed(Buffer.from("\x1bq")), [k("q", A)]);
  // ESC ESC then nothing: Alt-Escape
  assert.deepEqual(decode("\x1b\x1b"), [k("escape", A)]);
});

test("input: an incomplete sequence at a flush is dropped, not typed", () => {
  const d = new InputDecoder();
  assert.deepEqual(d.feed(Buffer.from("\x1b[1;5")), []);
  assert.deepEqual(d.flush(), []);
  assert.deepEqual(d.feed(Buffer.from("x")), [k("x", { text: "x" })]);
});

test("input: replies to the screen's queries are consumed, never keys", () => {
  const replies: Reply[] = [];
  const bytes =
    "\x1b[?62;4;22c" + // DA1
    "\x1b[>1;10;0c" + // DA2
    "\x1b]11;rgb:0000/0000/0000\x1b\\" + // OSC 11, ST
    "\x1b]10;rgb:d4d4/d4d4/d4d4\x07" + // OSC 10, BEL
    "\x1b[12;40R" + // cursor position
    "\x1b[?1u" + // kitty flags
    "\x1b[?2026;2$y" + // DECRPM
    "\x1bP>|xterm(388)\x1b\\" + // XTVERSION
    "\x1b[8;36;120t"; // window size
  for (const r of decodeSplit(Buffer.from(bytes, "latin1"))) assert.deepEqual(r, []);
  assert.deepEqual(decode(bytes, replies), []);
  assert.deepEqual(
    replies.map((r) => r.kind),
    ["da1", "da2", "osc", "osc", "cursor", "kitty-flags", "mode", "dcs", "window"],
  );
  assert.deepEqual(replies[2], { kind: "osc", code: 11, body: "rgb:0000/0000/0000" });
  assert.deepEqual(replies[5], { kind: "kitty-flags", flags: 1 });
  assert.deepEqual(replies[6], { kind: "mode", mode: 2026, value: 2 });
});

test("input: a broken OSC does not swallow the keys after it", () => {
  assert.deepEqual(decode("\x1b]11;rgb:00\x1b[A"), [k("up")]);
});

test("input: bracketed paste is one input, newlines kept, never keys", () => {
  const bytes = Buffer.from("\x1b[200~line one\r\nline two\x1b[A\x03y\x1b[201~z", "utf8");
  const expected: Input[] = [{ type: "paste", text: "line one\nline two\x1b[A\x03y" }, k("z", { text: "z" })];
  assert.deepEqual(decode(bytes), expected);
  for (const r of decodeSplit(bytes)) assert.deepEqual(r, expected);
});

test("input: nested start marks inside a paste are not content; a stray end mark is dropped", () => {
  assert.deepEqual(decode("\x1b[200~a\x1b[200~b\x1b[201~"), [{ type: "paste", text: "ab" }]);
  assert.deepEqual(decode("x\x1b[201~y"), [k("x", { text: "x" }), k("y", { text: "y" })]);
});

test("input: a paste waits for its end mark across chunks and flushes; endPaste ends a broken one", () => {
  const d = new InputDecoder();
  assert.deepEqual(d.feed(Buffer.from("\x1b[200~abc")), []);
  assert.deepEqual(d.flush(), [], "a pause mid-paste is not the end of it");
  assert.equal(d.pending, "paste");
  assert.deepEqual(d.feed(Buffer.from("\x1b[20")), []);
  assert.deepEqual(d.endPaste(), [{ type: "paste", text: "abc\x1b[20" }]);
  assert.equal(d.pending, "none");
});

test("input: a huge paste is cut with a note, not held whole", () => {
  const d = new InputDecoder();
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const out: Input[] = [];
  out.push(...d.feed(Buffer.from("\x1b[200~")));
  for (let i = 0; i < 6; i++) out.push(...d.feed(chunk));
  out.push(...d.feed(Buffer.from("\x1b[201~")));
  assert.equal(out.length, 1);
  const p = out[0]!;
  assert.equal(p.type, "paste");
  if (p.type === "paste") {
    assert.ok(p.text.endsWith(PASTE_CUT_NOTE));
    assert.equal(p.text.length, PASTE_MAX_BYTES + PASTE_CUT_NOTE.length);
  }
});

test("input: C1 controls and stray bytes never become keys", () => {
  assert.deepEqual(decode(Buffer.from([0xc2, 0x9b, 0x80, 0xff, 0x61])), [k("a", { text: "a" })]);
});

test("input: garbage is linear and terminates", () => {
  const d = new InputDecoder();
  const junk = Buffer.alloc(200_000);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) & 0xff;
  const t = Date.now();
  d.feed(junk);
  d.flush();
  assert.ok(Date.now() - t < 2000);
});
