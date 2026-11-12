import assert from "node:assert/strict";
import { test } from "node:test";
import type { Role } from "../src/tui/full/types.js";
import { contrast, contrastReport, darkTheme, detectDepth, invisibleAt, isDarkBackground, lightTheme, parseOscColour, sgrParams, to256 } from "../src/tui/full/screen/colour.js";

const ROLES: Role[] = [
  "page", "panel", "dialog", "backdrop", "rule", "text", "muted", "faint", "onAccent", "accent", "user", "success",
  "warning", "danger", "info", "heading", "codeBg", "added", "addedBg", "removed", "removedBg", "synKeyword",
  "synString", "synNumber", "synComment", "synFunction", "synType", "synPunct",
];

test("colour: every role is defined in both themes, with Memtro's teal as the accent", () => {
  for (const t of [darkTheme, lightTheme]) {
    for (const r of ROLES) {
      const c = t.colours[r];
      assert.ok(c && [c.r, c.g, c.b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255), `${t.name}.${r}`);
    }
  }
  assert.deepEqual(darkTheme.colours.accent, { r: 0x6c, g: 0xc0, b: 0xb4 });
  assert.deepEqual(lightTheme.colours.accent, { r: 0x36, g: 0x70, b: 0x6a });
  assert.ok(darkTheme.dark && !lightTheme.dark);
});

test("colour: contrast holds in both themes", () => {
  const need: Array<[Role, Role, number]> = [
    ["text", "page", 7],
    ["text", "panel", 7],
    ["muted", "page", 4.5],
    ["muted", "panel", 4.5],
    ["onAccent", "accent", 4.5],
    ["added", "addedBg", 4.5],
    ["removed", "removedBg", 4.5],
  ];
  for (const t of [darkTheme, lightTheme]) {
    for (const [fg, bg, min] of need) {
      const ratio = contrast(t.colours[fg], t.colours[bg]);
      assert.ok(ratio >= min, `${t.name}: ${fg} on ${bg} is ${ratio.toFixed(2)}, needs ${min}`);
    }
    for (const row of contrastReport(t)) assert.ok(row.ok, `${t.name}: ${row.fg} on ${row.bg} ${row.ratio} < ${row.min}`);
  }
  assert.equal(Math.round(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })), 21);
});

test("colour: depth from the environment and the stream", () => {
  const tty = { isTTY: true };
  assert.equal(detectDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }, tty), "none");
  assert.equal(detectDepth({ NO_COLOR: "", COLORTERM: "truecolor" }, tty), "truecolor", "an empty NO_COLOR is unset");
  assert.equal(detectDepth({ TERM: "dumb" }, tty), "none");
  assert.equal(detectDepth({ TERM: "xterm-256color", COLORTERM: "truecolor" }, { isTTY: false }), "none");
  assert.equal(detectDepth({ FORCE_COLOR: "3" }, { isTTY: false }), "truecolor");
  assert.equal(detectDepth({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, tty), "none");
  assert.equal(detectDepth({ FORCE_COLOR: "1" }, tty), "16");
  assert.equal(detectDepth({ TERM: "xterm-256color", COLORTERM: "truecolor" }, tty), "truecolor");
  assert.equal(detectDepth({ TERM: "xterm-256color" }, tty), "256");
  assert.equal(detectDepth({ TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" }, tty), "256");
  assert.equal(detectDepth({ TERM: "xterm-kitty" }, tty), "truecolor");
  assert.equal(detectDepth({ TERM: "linux" }, tty), "16");
  assert.equal(detectDepth({ TERM: "screen" }, tty), "16");
});

test("colour: 256 picks the nearest cube or grey entry", () => {
  assert.equal(to256({ r: 0, g: 0, b: 0 }), 16);
  assert.equal(to256({ r: 255, g: 255, b: 255 }), 231);
  assert.equal(to256({ r: 0x80, g: 0x80, b: 0x80 }), 244);
  assert.equal(to256({ r: 0x12, g: 0x12, b: 0x12 }), 233);
  assert.equal(to256({ r: 255, g: 0, b: 0 }), 196);
  // the dark page and panel stay distinguishable
  assert.notEqual(to256(darkTheme.colours.page), to256(darkTheme.colours.panel));
  assert.notEqual(to256(darkTheme.colours.accent), to256(darkTheme.colours.page));
  // a coloured role keeps its hue rather than collapsing to a grey of the same lightness
  for (const t of [darkTheme, lightTheme]) {
    for (const r of ["accent", "user", "success", "warning", "danger", "heading"] as const) {
      const i = to256(t.colours[r]);
      assert.ok(i >= 16 && i < 232 && ![16, 59, 102, 145, 188, 231].includes(i), `${t.name}.${r} -> ${i} is grey`);
    }
  }
});

test("colour: SGR at each depth; the selection stays visible at 16 and none", () => {
  const sel = { fg: "onAccent" as const, bg: "accent" as const };
  assert.deepEqual(sgrParams(sel, darkTheme, "truecolor"), ["38;2;15;33;31", "48;2;108;192;180"]);
  assert.ok(sgrParams(sel, darkTheme, "256").every((p) => /^[34]8;5;\d+$/.test(p)));
  assert.deepEqual(sgrParams(sel, darkTheme, "16"), ["30", "46"]);
  assert.deepEqual(sgrParams(sel, darkTheme, "none"), ["7"]);
  assert.deepEqual(sgrParams({ fg: "muted", dimmed: true }, darkTheme, "none"), ["2"]);
  assert.deepEqual(sgrParams({ fg: "heading", bold: true }, darkTheme, "16"), ["1", "35"]);
  assert.ok(invisibleAt({ fg: "panel" }, "16") && invisibleAt({ fg: "panel" }, "none") && !invisibleAt({ fg: "panel" }, "256"));
  const dimmed = sgrParams({ fg: "text", bg: "page", dimmed: true }, darkTheme, "truecolor");
  assert.notDeepEqual(dimmed, sgrParams({ fg: "text", bg: "page" }, darkTheme, "truecolor"), "dim moves colours toward the backdrop");
});

test("colour: OSC 11 replies parsed strictly", () => {
  assert.deepEqual(parseOscColour("rgb:0000/0000/0000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(parseOscColour("rgb:ffff/ffff/ffff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseOscColour("rgb:ff/80/00"), { r: 255, g: 128, b: 0 });
  assert.deepEqual(parseOscColour("#1e1e1e"), { r: 30, g: 30, b: 30 });
  assert.equal(parseOscColour("rgb:00/00"), null);
  assert.equal(parseOscColour("rgb:0000/0000/0000\u001b[2J"), null);
  assert.equal(parseOscColour("?"), null);
  assert.equal(isDarkBackground({ r: 0, g: 0, b: 0 }), true);
  assert.equal(isDarkBackground({ r: 255, g: 255, b: 255 }), false);
  assert.equal(isDarkBackground({ r: 0x28, g: 0x2c, b: 0x34 }), true);
  assert.equal(isDarkBackground({ r: 0xfd, g: 0xf6, b: 0xe3 }), false);
});
