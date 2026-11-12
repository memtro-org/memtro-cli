import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, PendingCall } from "../src/agent/types.js";
import { approvalGeometry, ApprovalPanel } from "../src/tui/full/app/approval.js";
import { modelDialog, sessionsDialog } from "../src/tui/full/app/commands.js";
import { createState, type AppState } from "../src/tui/full/app/state.js";
import { addNotice, addUser, applyEvent, buildLayout, markAsking } from "../src/tui/full/app/transcript.js";
import { draw } from "../src/tui/full/app/views.js";
import { Editor } from "../src/tui/full/editor.js";
import { createFrame } from "../src/tui/full/screen/frame.js";
import type { Line } from "../src/tui/full/types.js";

/** Escape sequences, a bidi override and an OSC 52 clipboard write: what a hostile file or model could send. */
const NASTY = "a\u001b[2J\u001b]0;title\u0007b‮evil‬\u001b]52;c;cHduZWQ=\u0007c\u009b31m\rd\te\u0000";
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

function state(): AppState {
  return createState({
    editor: new Editor(),
    width: 100,
    height: 40,
    status: { model: NASTY, mode: "auto", organisation: NASTY, tokens: 10, contextUsed: 1, contextLimit: 10 },
    version: "0.2.1",
    cwd: `/w/${NASTY}`,
    startNotices: [NASTY],
  });
}

function assertClean(lines: Line[], where: string) {
  for (const l of lines) for (const s of l) assert.ok(!CONTROL.test(s.text), `${where}: ${JSON.stringify(s.text)}`);
}

test("outside text never reaches a span with a control character, in every transcript item and around them", () => {
  const call: PendingCall = { id: "t1", tool: NASTY, args: { x: NASTY }, risk: "execute", summary: { title: NASTY, command: NASTY, diff: `--- a/${NASTY}\n+++ b/x\n@@ -1 +1 @@\n-${NASTY}\n+${NASTY}\n`, paths: [NASTY, `/b/${NASTY}`] } };
  const events: AgentEvent[] = [
    { type: "turn-start", session: NASTY, model: NASTY },
    { type: "routing", model: NASTY, detail: NASTY },
    { type: "thinking", delta: NASTY },
    { type: "text", delta: `# ${NASTY}\n\n${NASTY} [link](javascript:${NASTY}) \`${NASTY}\`\n\n\`\`\`${NASTY}\n${NASTY}\n\`\`\`\n` },
    { type: "tool-call", call },
    { type: "tool-progress", id: "t1", text: NASTY },
    { type: "tool-decision", id: "t1", decision: { verdict: "deny", reason: NASTY, source: "classifier" } },
    { type: "tool-result", id: "t1", tool: NASTY, result: { content: NASTY, isError: true, display: { kind: "command", command: NASTY, exitCode: 2, output: `${NASTY}\n${NASTY}` } } },
    { type: "tool-call", call: { ...call, id: "t2", tool: "edit", risk: "write" } },
    { type: "tool-result", id: "t2", tool: "edit", result: { content: NASTY, display: { kind: "diff", path: NASTY, diff: call.summary.diff! } } },
    { type: "tool-call", call: { ...call, id: "t3", tool: "read", risk: "read" } },
    { type: "tool-decision", id: "t3", decision: { verdict: "ask", reason: NASTY, source: "rule" }, answer: { kind: "deny", note: NASTY } },
    { type: "tool-result", id: "t3", tool: "read", result: { content: NASTY, isError: true, display: { kind: "text", text: NASTY } } },
    { type: "tool-result", id: "t4", tool: NASTY, result: { content: NASTY } },
    { type: "usage", step: { input: 1, output: 1 }, session: { input: 1, output: 1 }, contextUsed: 1, contextLimit: 2 },
    { type: "compacted", before: 10, after: 5 },
    { type: "notice", text: NASTY },
    { type: "error", message: NASTY, retryable: true },
    { type: "turn-end", reason: "interrupted" },
  ];
  let s = addNotice(addUser(state(), NASTY), NASTY, "plain");
  for (const e of events) s = applyEvent(s, e);
  const kinds = new Set(s.items.map((i) => i.kind));
  for (const k of ["user", "assistant", "thinking", "tool", "notice", "error", "compaction", "footer"]) assert.ok(kinds.has(k as never), `has a ${k} item`);
  for (const verbose of [false, true]) {
    const layout = buildLayout(s.items, 80, verbose);
    for (let i = 0; i < s.items.length; i++) assertClean(layout.lines(i), `${s.items[i]!.kind} (verbose ${verbose})`);
  }
  // Asking, too: the line says it waits.
  const asking = markAsking(s, "t1");
  assertClean(buildLayout(asking.items, 80, false).lines(asking.items.findIndex((i) => i.kind === "tool")), "asking");

  // The whole screen: the start screen's notice, the header, the status line, the hints.
  const f = createFrame(100, 40);
  draw(s, f);
  const shown = f.rows().join("\n");
  assert.ok(shown.includes("␛"), "control characters are shown as their pictures");
  for (const st of [state(), s]) {
    const g = createFrame(100, 40);
    draw(st, g);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 100; x++) assert.ok(!CONTROL.test(g.cell(x, y)!.ch), `cell ${x},${y}`);
  }

  // The approval panel and the dialogs.
  const p = new ApprovalPanel(call, { verdict: "ask", reason: NASTY, source: "classifier" }, { kind: "command", command: NASTY }, true);
  const ag = approvalGeometry(p.state, 0, 90, 39, 38);
  assertClean([...ag.body, ...ag.choices], "approval");
  for (const d of [modelDialog([{ id: NASTY, context: null, output: null }], NASTY), sessionsDialog([{ id: NASTY, cwd: "/", started: "x", model: NASTY, title: NASTY }], new Date())]) {
    for (const r of d.rows) for (const t of [r.label, r.detail ?? ""]) assert.ok(!CONTROL.test(t), `dialog: ${JSON.stringify(t)}`);
  }
});
