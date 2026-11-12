import assert from "node:assert/strict";
import { test } from "node:test";
import { helpDialog, modelDialog, paletteDialog, sessionsDialog, toolsDialog } from "../src/tui/full/app/commands.js";
import { dialogInput, visibleRows } from "../src/tui/full/app/dialog.js";
import { syncMenu } from "../src/tui/full/app/keys.js";
import { menuFor, type MenuContext } from "../src/tui/full/app/menu.js";
import { createState, type AppState } from "../src/tui/full/app/state.js";
import { addUser, applyEvent } from "../src/tui/full/app/transcript.js";
import { draw, geometry } from "../src/tui/full/app/views.js";
import { WORDMARK_WIDTH } from "../src/tui/full/app/wordmark.js";
import { Editor } from "../src/tui/full/editor.js";
import { createFrame } from "../src/tui/full/screen/frame.js";
import type { Tool } from "../src/agent/types.js";

const ctx: MenuContext = {
  host: {
    model: () => "auto",
    models: () => [
      { id: "auto", context: 200_000, output: null },
      { id: "anthropic/claude-sonnet-5", context: 1_000_000, output: null },
    ],
    mode: () => "auto",
    sessions: () => [{ id: "cli-1", cwd: "/r", started: new Date(Date.now() - 7_200_000).toISOString(), model: "auto", title: "fix the build" }],
    actions: () => false,
    now: () => new Date(),
    theme: () => "auto",
  },
  files: ["src/cli.ts", "src/main.ts", "README.md"],
};

function state(width = 120, height = 36, over: Partial<AppState> = {}): AppState {
  const s = createState({
    editor: new Editor(),
    width,
    height,
    status: { model: "auto", mode: "auto", organisation: "Analytical Engines", tokens: null, contextUsed: null, contextLimit: 200_000 },
    version: "0.2.1",
    cwd: "/Users/ada/code/engine",
    home: "/Users/ada",
  });
  return { ...s, ...over };
}

function paint(s: AppState) {
  const f = createFrame(s.width, s.height);
  draw(s, f);
  return f;
}

const findRow = (rows: string[], text: string) => rows.findIndex((r) => r.includes(text));

test("start screen: the wordmark centred, the input panel with its bar, the status line, hints and the version", () => {
  const s = state();
  const f = paint(s);
  const rows = f.rows();
  const g = geometry(s);
  // The wordmark is centred.
  const markRow = rows.findIndex((r) => r.includes("█"));
  assert.ok(markRow >= 0 && markRow < s.height / 2, "the wordmark is in the upper half");
  const left = Math.min(...rows.slice(markRow, markRow + 4).map((r) => r.search(/\S/)).filter((x) => x >= 0));
  assert.ok(Math.abs(left - Math.floor((s.width - WORDMARK_WIDTH) / 2)) <= 1);
  // The input panel: the accent bar, panel background, the placeholder, the half-block edge.
  assert.equal(f.cell(g.input.x, g.input.y + 1)!.ch, "┃");
  assert.equal(f.cell(g.input.x, g.input.y + 1)!.fg, "accent");
  assert.equal(f.cell(g.input.x + 5, g.input.y + 1)!.bg, "panel");
  assert.match(rows[g.input.y + 1]!, /Ask anything/);
  assert.equal(f.cell(g.input.x, g.input.y + g.input.height - 1)!.ch, "╹");
  assert.equal(f.cell(g.input.x + 3, g.input.y + g.input.height - 1)!.ch, "▀");
  assert.match(rows[g.input.y + g.input.height - 2]!, /auto · auto Analytical Engines · 0% context|auto · auto Analytical Engines/);
  // Hints under the panel; the version bottom right.
  assert.match(rows[g.hintY]!, /~\/code\/engine.*ctrl\+p commands {2}\/ menu/);
  assert.match(rows[s.height - 1]!, /v0\.2\.1 {2}$/);
  // The cursor is in the panel.
  assert.deepEqual(f.cursor, { x: g.input.x + 3, y: g.input.y + 1 });
});

test("start screen: a notice line, with /update in the accent", () => {
  const s = state(120, 36, { startNotices: ["memtro 9.1.0 is available (you have 0.2.1). Type /update."] });
  const f = paint(s);
  const rows = f.rows();
  const y = findRow(rows, "Type /update.");
  assert.ok(y >= 0);
  const x = rows[y]!.indexOf("/update");
  assert.equal(f.cell(x, y)!.fg, "accent");
  assert.equal(f.cell(x - 2, y)!.fg, "muted");
});

test("start screen fits 80x24 and 50x12", () => {
  for (const [w, h] of [
    [80, 24],
    [50, 12],
  ] as const) {
    const f = paint(state(w, h));
    const rows = f.rows();
    assert.ok(rows.some((r) => r.includes("Ask anything")), `${w}x${h} shows the input`);
    assert.ok(rows.some((r) => r.includes("ctrl+p")), `${w}x${h} shows the hints`);
  }
});

test("slash menu: opens on /, anchored above the input at its left edge and width, first row selected in the accent", () => {
  const s0 = state();
  s0.editor.setText("/");
  const s = syncMenu(s0, ctx).state;
  assert.equal(s.overlay.kind, "menu");
  const f = paint(s);
  const g = geometry(s);
  const rows = f.rows();
  // Ten rows, the last just above the input panel.
  const top = g.input.y - 10;
  assert.match(rows[top]!, /\/actions on\|off +Let Memtro's tools/);
  assert.equal(f.cell(g.input.x + 4, top)!.bg, "accent", "the selected row is an accent bar");
  assert.equal(f.cell(g.input.x + 4, top)!.fg, "onAccent");
  assert.equal(f.cell(g.input.x + 4, top + 1)!.bg, "panel", "the others are the panel");
  assert.match(rows[top + 1]!, /\/compact/);
  assert.equal(f.cell(g.input.x + 4, top + 1)!.fg, "text");
  // Descriptions are muted and cut at the edge, never past the panel.
  const descX = rows[top + 1]!.indexOf("Summarise");
  assert.equal(f.cell(descX, top + 1)!.fg, "muted");
  assert.ok(rows[top + 1]!.length <= s.width);
});

test("slash menu: /mo ranks name matches first, then description matches; no match says so", () => {
  const m = menuFor("/mo", ctx)!;
  const names = m.items.map((i) => i.label);
  assert.deepEqual(names.slice(0, 2), ["/mode", "/model"]);
  const firstDescriptionOnly = names.findIndex((n) => !/m.*o/.test(n.slice(1)));
  assert.ok(firstDescriptionOnly === -1 || names.slice(firstDescriptionOnly).every((n) => !/m.*o/.test(n.slice(1))), "name matches all come before description matches");
  assert.deepEqual(menuFor("/zzzq", ctx)!.items.map((i) => i.label), ["No matching commands"]);
  // An argument hint shows in the row.
  assert.equal(m.items.find((i) => i.label === "/model")!.hint, "[id]");
});

test("slash menu: argument choices once the name and a space are typed", () => {
  assert.deepEqual(menuFor("/mode ", ctx)!.items.map((i) => i.label), ["ask", "auto"]);
  assert.equal(menuFor("/mode ", ctx)!.items.find((i) => i.label === "auto")!.current, true);
  assert.deepEqual(menuFor("/model so", ctx)!.items.map((i) => i.label), ["anthropic/claude-sonnet-5"]);
  assert.deepEqual(menuFor("/actions ", ctx)!.items.map((i) => i.label), ["on", "off"]);
  assert.deepEqual(menuFor("/resume ", ctx)!.items.map((i) => i.label), ["cli-1"]);
  assert.equal(menuFor("/help ", ctx), null, "no choices, no menu");
  assert.equal(menuFor("hello /mo", ctx), null, "only as the first character");
});

test("@ menu: workspace files, fuzzy on the path", () => {
  const m = menuFor("look at @cl", ctx)!;
  assert.equal(m.kind, "file");
  assert.equal(m.items[0]!.label, "src/cli.ts");
  assert.equal(menuFor("look at @", { ...ctx, files: null })!.loading, true);
});

test("no colour: the selected row is marked, not only coloured", () => {
  const s0 = state(80, 24, { noColour: true });
  s0.editor.setText("/");
  const s = syncMenu(s0, ctx).state;
  const rows = paint(s).rows();
  assert.ok(rows.some((r) => r.includes("> /actions")));
});

test("palette: grouped sections, search filters at once, the selection in the accent; the rest is dimmed", () => {
  const d = paletteDialog();
  const sections = [...new Set(d.rows.map((r) => r.section))];
  assert.deepEqual(sections, ["Session", "Model", "Safety", "Account", "App"]);
  assert.ok(d.rows.some((r) => r.id === "/model") && d.rows.some((r) => r.id === "key:repaint"));
  const s = { ...state(), overlay: { kind: "dialog" as const, dialog: d } };
  const f = paint(s);
  const rows = f.rows();
  const titleY = findRow(rows, "Commands");
  assert.ok(titleY > 0 && titleY <= s.height / 4 + 2, "a quarter of the way down");
  assert.match(rows[titleY]!, /Commands +esc/);
  assert.match(rows[titleY + 2]!, /Search/);
  const headY = findRow(rows, "Session");
  const hx = rows[headY]!.indexOf("Session");
  assert.equal(f.cell(hx, headY)!.fg, "heading");
  const selY = headY + 1;
  assert.equal(f.cell(rows[selY]!.indexOf("New session"), selY)!.bg, "accent");
  assert.equal(f.cell(0, 0)!.dimmed, true, "behind the dialog is dimmed");
  const typed = dialogInput(dialogInput(d, { type: "key", name: "m", text: "m", ctrl: false, alt: false, shift: false }, 10).dialog, { type: "key", name: "o", text: "o", ctrl: false, alt: false, shift: false }, 10).dialog;
  assert.equal(typed.query, "mo");
  assert.ok(visibleRows(typed).length < d.rows.length);
  assert.equal(visibleRows(typed)[typed.selected]!.label.toLowerCase().includes("mo") || /m.*o/i.test(visibleRows(typed)[0]!.label), true);
});

test("model picker: the current model marked; the routing lock said", () => {
  const routed = modelDialog([{ id: "auto", context: 200_000, output: null }, { id: "memtro", context: null, output: null }], "auto");
  assert.match(routed.note!, /routes every request/);
  assert.equal(routed.rows.find((r) => r.current)!.id, "auto");
  const s = { ...state(), overlay: { kind: "dialog" as const, dialog: routed } };
  const rows = paint(s).rows();
  assert.ok(rows.some((r) => /● auto +200k context/.test(r)));
  const open = modelDialog([{ id: "auto", context: null, output: null }, { id: "anthropic/claude-sonnet-5:chat", context: null, output: null }], "anthropic/claude-sonnet-5");
  assert.equal(open.note, undefined);
  assert.equal(open.selected, 1, "opens on the current one");
  assert.match(modelDialog(null, "auto").note!, /could not be loaded/);
});

test("sessions, help and tools dialogs", () => {
  const sd = sessionsDialog([{ id: "cli-1", cwd: "/r", started: new Date(Date.now() - 7_200_000).toISOString(), model: "auto", title: "fix\u001b[2J the build" }], new Date());
  assert.equal(sd.rows[0]!.label, "fix␛[2J the build");
  assert.equal(sd.rows[0]!.detail, "2 h ago · auto");
  const wide = paint({ ...state(140, 40), overlay: { kind: "dialog", dialog: helpDialog() } }).rows();
  assert.ok(wide.some((r) => /enter .*send.*shift\+enter/.test(r)), "two columns when wide");
  const narrow = paint({ ...state(80, 40), overlay: { kind: "dialog", dialog: helpDialog() } }).rows();
  assert.ok(!narrow.some((r) => /enter .*send.*shift\+enter/.test(r)), "one column when not");
  const tool = (name: string, description: string): Tool => ({ spec: { name, description, parameters: {} }, validate: () => ({ ok: true, args: {} }), risk: () => "read", summarise: () => ({ title: name }), run: async () => ({ content: "" }) });
  const td = toolsDialog([tool("read", "Read a file"), tool("bash", "Run a command"), tool("github", "GitHub\n- create_issue: ACTION: open an issue"), tool("memtro_search", "Search memory")], false);
  assert.deepEqual([...new Set(td.rows.map((r) => r.section))], ["On this computer", "Memtro"]);
  assert.equal(td.rows.find((r) => r.id === "github")!.flag, "acts");
  assert.equal(td.rows.find((r) => r.id === "memtro_search")!.flag, undefined);
  assert.equal(td.rows.find((r) => r.id === "bash")!.flag, "changes files or runs");
});

test("conversation: header with title and context, the person's message in a user-barred panel, the footer", () => {
  let s = addUser(state(), "Find the homepage button and make it blue");
  s = applyEvent(s, { type: "turn-start", session: "x", model: "auto" });
  s = applyEvent(s, { type: "routing", model: "anthropic/claude-sonnet-5", detail: null });
  s = applyEvent(s, { type: "usage", step: { input: 1000, output: 200 }, session: { input: 1000, output: 200 }, contextUsed: 40_000, contextLimit: 200_000 });
  s = applyEvent(s, { type: "turn-end", reason: "stop" });
  const f = paint(s);
  const rows = f.rows();
  const g = geometry(s);
  assert.match(rows[g.header!.y + 1]!, /Find the homepage button and make it blue +1\.2k tokens {2}20% context/);
  const uy = findRow(rows, "Find the homepage button and make it blue");
  const ux = uy > g.header!.y + 2 ? uy : findRow(rows.slice(g.header!.y + 3), "Find the homepage") + g.header!.y + 3;
  assert.equal(f.cell(g.transcript!.x, ux)!.ch, "┃");
  assert.equal(f.cell(g.transcript!.x, ux)!.fg, "user");
  assert.equal(f.cell(g.transcript!.x + 3, ux)!.bg, "panel");
  assert.ok(rows.some((r) => /▣ anthropic\/claude-sonnet-5 · 1\.2k tokens/.test(r)));
  assert.match(rows[g.input.y + g.input.height - 2]!, /auto · anthropic\/claude-sonnet-5 Analytical Engines · 20% context/);
});

test("an answer is Markdown through the renderer: a table, a code block and a link with its address in full, also while it streams", () => {
  const md = "## Result\n\n| File | Lines |\n|:--|--:|\n| a.ts | 12 |\n\n```ts\nconst x = 1;\n```\n\nSee [the guide](https://example.com/guide/a?b=1#c) and <https://memtro.com/docs>.\n";
  let s = addUser(state(), "q");
  // Streaming, cut inside the table and then inside the fence: what has arrived renders, nothing raw leaks.
  s = applyEvent(s, { type: "text", delta: md.slice(0, md.indexOf("| a.ts") + 5) });
  let rows = paint(s).rows();
  assert.ok(rows.some((r) => /File +│ +Lines/.test(r)), "the table's header so far");
  assert.ok(!rows.some((r) => r.includes("|:--")), "no raw delimiter row");
  s = applyEvent(s, { type: "text", delta: md.slice(md.indexOf("| a.ts") + 5, md.indexOf("const x") + 5) });
  rows = paint(s).rows();
  assert.ok(rows.some((r) => r.includes("const")), "an unclosed fence shows its code so far");
  assert.ok(!rows.some((r) => r.includes("```")), "the fence itself is not shown");
  s = applyEvent(s, { type: "text", delta: md.slice(md.indexOf("const x") + 5) });
  s = applyEvent(s, { type: "turn-end", reason: "stop" });
  const f = paint(s);
  rows = f.rows();
  assert.ok(rows.some((r) => r.includes("Result")) && !rows.some((r) => r.includes("## ")), "the heading rendered");
  assert.ok(rows.some((r) => /a\.ts +│ +12/.test(r)), "the table");
  assert.ok(rows.some((r) => r.includes("const x = 1;")), "the code");
  const link = rows.findIndex((r) => r.includes("the guide (https://example.com/guide/a?b=1#c)"));
  assert.ok(link >= 0, "the link's text, then its address in full");
  assert.ok(rows[link]!.includes("and https://memtro.com/docs."), "an address that is its own text is shown once");
  const x = rows[link]!.indexOf("the guide");
  assert.equal(f.cell(x, link)!.link, undefined, "the text opens nothing: only the address shown does");
  assert.equal(f.cell(rows[link]!.indexOf("(https://example.com/guide") + 1, link)!.link, "https://example.com/guide/a?b=1#c", "the address is a link to itself");
});
