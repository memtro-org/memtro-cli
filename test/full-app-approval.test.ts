import assert from "node:assert/strict";
import { test } from "node:test";
import type { Decision, PendingCall, SessionRule } from "../src/agent/types.js";
import { BURST_MS, SETTLE_MS } from "../src/tui/approval.js";
import { approvalGeometry, ApprovalPanel, drawApproval, HOLD_MS, TYPING_GAP_MS, type ApprovalOutcome } from "../src/tui/full/app/approval.js";
import { createFrame } from "../src/tui/full/screen/frame.js";
import type { Input } from "../src/tui/full/types.js";

const ESC = "\u001b";

function call(over: Partial<PendingCall> = {}): PendingCall {
  return { id: "c1", tool: "bash", args: { command: "npm test" }, risk: "execute", summary: { title: "Run `npm test`", command: "npm test" }, ...over };
}
const ask: Decision = { verdict: "ask", reason: "Runs the test suite.", source: "classifier" };
const rule: SessionRule = { kind: "command-prefix", words: ["npm", "test"] };

const k = (name: string, m: { ctrl?: boolean; alt?: boolean; text?: string } = {}): Input => ({
  type: "key",
  name,
  ctrl: Boolean(m.ctrl),
  alt: Boolean(m.alt),
  shift: false,
  ...(m.text !== undefined ? { text: m.text } : name.length === 1 && !m.ctrl && !m.alt ? { text: name } : {}),
});

/** A panel drawn at t0, and a helper that feeds an input at a time with a gap, then commits any held answer. */
function panel(suggested: SessionRule | null = rule, t0 = 1000) {
  const p = new ApprovalPanel(call(), ask, suggested, true);
  p.drawn(t0);
  const at = (input: Input, t: number, gap: number): ApprovalOutcome => {
    const out = p.input(input, t, gap, 10, 10);
    if (out.kind === "answer") return out;
    return p.commit(t + HOLD_MS);
  };
  return { p, at, t0 };
}

test("approval panel: one deliberate key answers; Enter, a paste, a burst, type-ahead and two quick keys do not", () => {
  const { p, at, t0 } = panel();
  assert.equal(at(k("y"), t0 + 20, 500).kind, "none", "typed before the panel could be read (within the settle time)");
  assert.equal(at(k("enter"), t0 + 400, 400).kind, "none", "Enter is not yes");
  assert.equal(at({ type: "paste", text: "y" }, t0 + 800, 400).kind, "none", "a paste");
  assert.equal(at(k("y"), t0 + 1200, 0).kind, "none", "one of several keys in one chunk");
  assert.equal(at(k("y"), t0 + 1210, 10).kind, "none", "part of a burst");
  // Two quick keys: the first is held, the second (inside the burst interval) cancels it and is itself ignored.
  assert.equal(p.input(k("y"), t0 + 2000, 800, 10, 10).kind, "none");
  assert.equal(p.holding, true);
  assert.equal(p.input(k("y"), t0 + 2010, 10, 10, 10).kind, "none");
  assert.equal(p.commit(t0 + 2100).kind, "none", "the held answer was cancelled");
  assert.equal(at({ type: "wheel", direction: "down", x: 1, y: 1 }, t0 + 2600, 500).kind, "none", "mouse input never answers");
  assert.equal(at({ type: "focus", focused: true }, t0 + 2700, 100).kind, "none");
  assert.equal(at({ type: "resize", width: 80, height: 24 }, t0 + 2800, 100).kind, "none");
  const yes = at(k("y"), t0 + 3500, 700);
  assert.deepEqual(yes, { kind: "answer", answer: { kind: "once" }, interrupt: false });
});

test("approval panel: typing is not a decision: a word typed at a person's speed, ending in y or a, answers nothing", () => {
  const { p, t0 } = panel();
  // Typing that carries on from before the panel appeared, a key every 100 ms, well after the settle time.
  let t = t0 + SETTLE_MS + 200;
  for (const ch of "today, say yea") {
    const out = p.input(ch === " " ? k("space", { text: " " }) : k(ch), t, 100, 10, 10);
    assert.equal(out.kind, "none", `"${ch}" while typing`);
    t += 100;
  }
  assert.equal(p.commit(t + 1000).kind, "none", "nothing was held from the typing");
  assert.equal(p.state.note, null, "e inside the typing did not open the note either");
  // A key that follows other input by less than the typing gap does not answer even after a pause after it.
  assert.equal(p.input(k("y"), t + 2000, TYPING_GAP_MS - 1, 10, 10).kind, "none");
  assert.equal(p.commit(t + 3000).kind, "none");
  // A key held, then another key inside the hold: neither answers.
  assert.equal(p.input(k("y"), t + 4000, 1000, 10, 10).kind, "none");
  assert.equal(p.holding, true);
  assert.equal(p.commit(t + 4000 + HOLD_MS - 1).kind, "none", "not before the hold is over");
  assert.equal(p.input(k("x"), t + 4000 + HOLD_MS - 1, HOLD_MS - 1, 10, 10).kind, "none");
  assert.equal(p.commit(t + 5000).kind, "none", "the next key cancelled it");
  // After a pause, one key on its own answers once the hold is over.
  assert.equal(p.input(k("y"), t + 6000, 1000, 10, 10).kind, "none");
  assert.deepEqual(p.commit(t + 6000 + HOLD_MS), { kind: "answer", answer: { kind: "once" }, interrupt: false });
});

test("approval panel: a key before the panel was drawn is ignored; Escape and Ctrl-C always refuse", () => {
  const p = new ApprovalPanel(call(), ask, rule, true);
  assert.equal(p.input(k("y"), 5000, 5000, 10, 10).kind, "none", "not drawn yet");
  assert.equal(p.commit(6000).kind, "none");
  assert.deepEqual(p.input(k("escape"), 5001, 1, 10, 10), { kind: "answer", answer: { kind: "deny" }, interrupt: false });
  const q = new ApprovalPanel(call(), ask, rule, true);
  q.drawn(1000);
  assert.deepEqual(q.input(k("c", { ctrl: true }), 1001, 0, 10, 10), { kind: "answer", answer: { kind: "deny", note: "The person interrupted instead of answering." }, interrupt: true });
});

test("approval panel: a, n and e; a only when a rule is offered", () => {
  const t = 1000 + SETTLE_MS + 100;
  assert.deepEqual(panel().at(k("A", { text: "A" }), t, 500), { kind: "answer", answer: { kind: "session", rule }, interrupt: false });
  assert.equal(panel(null).at(k("a"), t, 500).kind, "none", "no session answer when none was offered");
  assert.deepEqual(panel().at(k("n"), t, 500), { kind: "answer", answer: { kind: "deny" }, interrupt: false });
  // e opens a one-line note; Escape goes back to the choices without approving; Enter sends the denial with the note.
  const { p, at } = panel();
  assert.equal(at(k("e"), t, 500).kind, "none");
  assert.equal(p.state.note, "");
  for (const ch of "use pnpm") p.input(ch === " " ? k("space", { text: " " }) : k(ch), t + 10, 300, 10, 10);
  p.input({ type: "paste", text: ", not npm" }, t + 20, 300, 10, 10);
  assert.equal(p.state.note, "use pnpm, not npm");
  assert.equal(p.input(k("escape"), t + 30, 300, 10, 10).kind, "none", "Escape leaves the note, it does not approve");
  assert.equal(p.state.note, null);
  assert.equal(at(k("e"), t + 600, 500).kind, "none");
  for (const ch of "no") p.input(k(ch), t + 700, 300, 10, 10);
  assert.deepEqual(p.input(k("enter"), t + 800, 300, 10, 10), { kind: "answer", answer: { kind: "deny", note: "The person's note: no" }, interrupt: false });
});

test("approval panel: an interrupted turn closes it as a refusal", () => {
  const { p } = panel();
  assert.deepEqual(p.aborted(), { kind: "answer", answer: { kind: "deny", note: "The person interrupted the turn." }, interrupt: false });
});

test("approval panel: scrolling keys scroll and never answer", () => {
  const { p, at, t0 } = panel();
  for (const name of ["down", "pagedown", "up", "pageup", "end", "home"]) assert.equal(at(k(name), t0 + 1000, 500).kind, "none", name);
  assert.equal(p.holding, false);
});

test("approval panel: a 5,000-character command and a 3,000-line diff are reachable to their last line; the end says more above", () => {
  const long = `echo ${"x".repeat(4990)} END-OF-COMMAND`;
  const diff = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,3000 +1,3000 @@", ...Array.from({ length: 3000 }, (_, i) => `+line ${i}${i === 2999 ? " LAST-DIFF-LINE" : ""}`)].join("\n");
  const p = new ApprovalPanel(call({ summary: { title: "Run a long one", command: `${long}\u001b[2K\rsneaky`, diff } }), { verdict: "ask", reason: "x", source: "rule" }, null, true);
  p.drawn(0);
  const W = 100;
  const H = 30;
  const geo = () => approvalGeometry(p.state, 2, W - 4, H - 6, 20);
  const g = geo();
  // The command is wrapped, never cut: every character of it is in the body.
  const bodyText = g.body.map((l) => l.map((s) => s.text).join("")).join("");
  assert.ok(bodyText.includes("END-OF-COMMAND"));
  assert.ok(bodyText.includes("␛[2K␍sneaky"), "control characters are shown, not obeyed");
  assert.ok(g.body.length > 3000);
  const show = () => {
    const f = createFrame(W, H);
    drawApproval(p.state, f, geo());
    return f.rows();
  };
  let rows = show();
  assert.ok(rows.some((r) => r.includes("more below")) && !rows.some((r) => r.includes("more above")));
  assert.ok(rows.some((r) => r.includes("Allow this?")));
  assert.ok(rows.some((r) => /y allow once {3}n deny {3}e deny with a note/.test(r)), "the choices stay on screen");
  // Scroll to the end with PageDown alone.
  for (let i = 0; i < 400; i++) p.input(k("pagedown"), 1000 + i * 100, 100, g.bodyHeight, g.body.length);
  rows = show();
  assert.ok(rows.some((r) => r.includes("LAST-DIFF-LINE")), "the last line of the diff is reachable");
  assert.ok(rows.some((r) => r.includes("more above")) && !rows.some((r) => r.includes("more below")));
  // What is shown is the last screenful.
  const lastShown = g.body.slice(-g.bodyHeight).map((l) => l.map((s) => s.text).join("").trimEnd());
  for (const l of lastShown) assert.ok(rows.some((r) => r.includes(l.slice(0, 40))), `shows: ${l.slice(0, 40)}`);
  // And back to the top with Home: the end of the command is reachable by Down from there.
  p.input(k("home"), 50_000, 100, g.bodyHeight, g.body.length);
  let seenEnd = false;
  for (let i = 0; i < 200 && !seenEnd; i++) {
    seenEnd = show().some((r) => r.includes("END-OF-COMMAND"));
    p.input(k("down"), 60_000 + i * 100, 100, g.bodyHeight, g.body.length);
  }
  assert.ok(seenEnd, "the end of the command is reachable");
  assert.ok(!show().join("").includes(ESC));
});

test("approval panel: a linked path says where it really goes; the session rule is spelt out in full", () => {
  const p = new ApprovalPanel(call({ tool: "write", risk: "write", summary: { title: "Write notes.txt", paths: ["/home/a/.ssh/config", "/repo/notes.txt"] } }), ask, { kind: "write-under", dir: "/repo" }, true);
  const g = approvalGeometry(p.state, 0, 70, 40, 30);
  const text = [...g.body, ...g.choices].map((l) => l.map((s) => s.text).join("")).join("\n");
  assert.match(text, /path \/repo\/notes\.txt \(really \/home\/a\/\.ssh\/config\)/);
  assert.match(text.replace(/\s+/g, " "), /a allow any file created, written or edited under \/repo for this session/);
  assert.match(text, /why the safety check was unsure: Runs the test suite\./);
});

test("approval panel: allowing a long command for the session points at the command shown above instead of repeating it", () => {
  const command = Array.from({ length: 30 }, (_, i) => `echo "step ${i + 1}"`).join(" && \\\n  ");
  const exact: SessionRule = { kind: "command", command };
  const p = new ApprovalPanel(call({ summary: { title: "Run it", command } }), ask, exact, true);
  const g = approvalGeometry(p.state, 2, 76, 22, 18);
  const choices = g.choices.map((l) => l.map((s) => s.text).join("")).join("\n");
  assert.match(choices.replace(/\s+/g, " "), /a allow exactly the command above, for this session/);
  assert.ok(g.choices.length <= 3, "the choices stay short");
  assert.ok(g.bodyHeight >= 10, "the command keeps the room");
  assert.ok(g.rect.y + g.rect.height <= 22 && g.rect.height <= 18, "the panel fits where it was given");
  // A short one is still spelt out.
  const q = new ApprovalPanel(call(), ask, { kind: "command", command: "npm test" }, true);
  const qc = approvalGeometry(q.state, 2, 76, 22, 18).choices.map((l) => l.map((s) => s.text).join("")).join(" ");
  assert.match(qc, /a allow exactly `npm test` for this session/);
});
