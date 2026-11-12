import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, fuzzyMatch } from "../src/tui/full/fuzzy.js";

interface Cmd {
  name: string;
  description: string;
}
const COMMANDS: Cmd[] = [
  { name: "model", description: "Choose the model" },
  { name: "mode", description: "Ask before acting, or act" },
  { name: "help", description: "Show the commands" },
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Resume an earlier session" },
  { name: "logout", description: "Sign out of memtro" },
  { name: "update", description: "Install the newest memtro" },
  { name: "tools", description: "List the tools the agent may use" },
  { name: "theme", description: "Dark, light or follow the terminal" },
];
const keys = (c: Cmd) => ({ primary: c.name, secondary: c.description });
const names = (q: string) => fuzzyFilter(COMMANDS, q, keys).map((r) => r.item.name);

test("fuzzy: an empty query returns everything in order", () => {
  assert.deepEqual(names(""), COMMANDS.map((c) => c.name));
  assert.deepEqual(names("   "), COMMANDS.map((c) => c.name));
});

test("fuzzy: subsequence, case-insensitive", () => {
  assert.deepEqual(names("MDL"), ["model"]);
  assert.ok(names("xyzq").length === 0);
  assert.ok(fuzzyMatch("model", "mdl"));
  assert.equal(fuzzyMatch("model", "lm"), null);
});

test("fuzzy: name matches rank before description matches", () => {
  const r = names("se");
  // "resume" matches on its name; "new" and "logout" only on descriptions ("session", "Sign out")
  assert.equal(r[0], "resume");
  const tiers = fuzzyFilter(COMMANDS, "se", keys).map((x) => x.on);
  const firstSecondary = tiers.indexOf("secondary");
  assert.ok(firstSecondary > 0 && tiers.slice(firstSecondary).every((t) => t === "secondary"));
});

test("fuzzy: prefers the start, word boundaries and contiguous runs", () => {
  assert.deepEqual(names("mo").slice(0, 2), ["mode", "model"], "equal scores: alphabetical");
  const items = ["src/tui/full/screen.ts", "scripts/screenshot.ts", "test/sc_reen.ts"];
  const r = fuzzyFilter(items, "screen", (s) => ({ primary: s }));
  assert.equal(r.length, 3);
  assert.notEqual(r[0]!.item, "test/sc_reen.ts", "a contiguous run beats a broken one");
  const b = fuzzyFilter(["abc_def", "xabcdef"], "ad", (s) => ({ primary: s }));
  assert.equal(b[0]!.item, "abc_def", "start and boundary beat the middle");
  const camel = fuzzyFilter(["getUserName", "gusername"], "gun", (s) => ({ primary: s }));
  assert.equal(camel[0]!.item, "getUserName");
});

test("fuzzy: positions point at the matched characters", () => {
  const [r] = fuzzyFilter(["src/tui/full/fuzzy.ts"], "fuzzy", (s) => ({ primary: s }));
  assert.deepEqual(r!.positions, [13, 14, 15, 16, 17]);
  const [d] = fuzzyFilter(COMMANDS, "newest", keys);
  assert.equal(d!.on, "secondary");
  assert.equal(COMMANDS.find((c) => c === d!.item)!.description.slice(d!.positions[0], d!.positions[0]! + 6).toLowerCase(), "newest");
});

test("fuzzy: ties are alphabetical, then stable", () => {
  const items = ["xb", "xa", "xa", "xc"];
  const r = fuzzyFilter(items.map((name, i) => ({ name, i })), "x", (x) => ({ primary: x.name }));
  assert.deepEqual(r.map((x) => `${x.item.name}${x.item.i}`), ["xa1", "xa2", "xb0", "xc3"]);
});

test("fuzzy: large inputs stay fast", () => {
  const items = Array.from({ length: 20_000 }, (_, i) => `src/module${i}/deep/path/file${i % 97}.ts`);
  const t = Date.now();
  const r = fuzzyFilter(items, "mod/file42", (s) => ({ primary: s }));
  assert.ok(r.length > 0);
  assert.ok(Date.now() - t < 3000, `${Date.now() - t}ms`);
  const long = "a".repeat(100_000) + "needle";
  const t2 = Date.now();
  assert.ok(fuzzyMatch(long, "needle"));
  assert.ok(Date.now() - t2 < 1000);
});
