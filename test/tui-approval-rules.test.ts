import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import type { Answer, Decision, PendingCall, SessionRule } from "../src/agent/types.js";
import { ApprovalKeys, createTtyApprover, formatApproval, HOLD_MS, SETTLE_MS, TYPING_GAP_MS } from "../src/tui/approval.js";
import { approvalBody, ApprovalPanel } from "../src/tui/full/app/approval.js";
import { KeyRouter } from "../src/tui/keys.js";
import { whyText } from "../src/tui/render.js";
import { style } from "../src/tui/style.js";

/**
 * The approval rules both interfaces share: the typing gap and the hold (`ApprovalKeys`), the inline prompt using
 * them, and the "why" line saying who and why once.
 */

const plain = style(false);
const rule: SessionRule = { kind: "command-prefix", words: ["npm", "test"] };

function call(over: Partial<PendingCall> = {}): PendingCall {
  return { id: "c1", tool: "bash", args: { command: "npm test" }, risk: "execute", summary: { title: "Run `npm test`", command: "npm test" }, ...over };
}

test("approval keys: typing is not a decision: a word typed at a person's speed, ending in y or a, answers nothing", () => {
  const t0 = 1000;
  // The person was typing before the prompt appeared, and carries on: a key every 100 ms.
  const keys = new ApprovalKeys(t0, true, t0 - 50);
  let t = t0 + SETTLE_MS + 200;
  for (const ch of "today, say yea") {
    assert.equal(keys.feed(ch, t).kind, "none", `"${ch}" while typing`);
    t += 100;
  }
  assert.equal(keys.commit(t + 1000), null, "nothing was held from the typing");
  // A key less than the typing gap after the last one does not answer, however long it is left alone after.
  t += TYPING_GAP_MS - 101;
  assert.equal(keys.feed("y", t).kind, "none");
  assert.equal(keys.commit(t + 5000), null);
  // A key on its own is held; another key inside the hold cancels it and is itself typing.
  t += 1000;
  assert.equal(keys.feed("y", t).kind, "held");
  assert.equal(keys.commit(t + HOLD_MS - 1), null, "not before the hold is over");
  assert.equal(keys.feed("x", t + HOLD_MS - 1).kind, "none");
  assert.equal(keys.commit(t + 5000), null, "the next key cancelled it");
  // Other input (a paste, the wheel, a resize, focus) cancels a held answer and restarts the gap.
  t += 2000;
  assert.equal(keys.feed("y", t).kind, "held");
  keys.other(t + 10);
  assert.equal(keys.commit(t + 1000), null, "other input cancelled it");
  assert.equal(keys.feed("y", t + 10 + TYPING_GAP_MS - 1).kind, "none", "the gap runs from the other input");
  // After a pause, one key answers once the hold is over.
  t += 5000;
  assert.equal(keys.feed("y", t).kind, "held");
  assert.equal(keys.commit(t + HOLD_MS), "once");
});

test("approval keys: the gate's rules still hold underneath, and refusing is immediate", () => {
  const t0 = 1000;
  const keys = new ApprovalKeys(t0, false);
  assert.equal(keys.feed("y", t0 + SETTLE_MS - 1).kind, "none", "within the settle time");
  assert.equal(keys.feed("a", t0 + 2000).kind, "none", "no session answer when none was offered");
  assert.equal(keys.feed("yes", t0 + 4000).kind, "none", "more than one key at once");
  assert.equal(keys.feed("\r", t0 + 6000).kind, "none", "Enter is not yes");
  assert.equal(keys.feed("\u001b[200~y\u001b[201~", t0 + 8000).kind, "none", "a paste");
  assert.deepEqual(keys.feed("\u0003", t0 + 8001), { kind: "now", choice: "interrupt" }, "Ctrl-C refuses even mid-burst");
  assert.deepEqual(new ApprovalKeys(t0, true).feed("\u001b", t0 + 1), { kind: "now", choice: "deny" }, "Escape refuses at once");
  // A caller's own measure of the quiet (the full screen's, 0 inside a chunk of several) counts when shorter.
  const k2 = new ApprovalKeys(t0, true);
  assert.equal(k2.feed("y", t0 + 5000, 0).kind, "none");
  assert.equal(k2.feed("n", t0 + 9000, TYPING_GAP_MS).kind, "held");
  assert.equal(k2.commit(t0 + 9000 + HOLD_MS), "deny");
});

/**
 * A terminal's input with a clock and timers the test moves: nothing here waits on a real timer, so a loaded machine
 * (a shared CI runner) cannot fire the hold early or late relative to the keys. As before the timers were faked, the
 * clock the keys are stamped with (`key`) and the time the hold's timer runs on (`wait`) are moved separately.
 */
function rig(suggested: SessionRule | null = rule) {
  let clock = 10_000;
  let timerNow = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const t = { at: timerNow + ms, fn };
    timers.push(t);
    return () => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    };
  };
  const elapse = (ms: number) => {
    timerNow += ms;
    for (let due = timers.findIndex((t) => t.at <= timerNow); due >= 0; due = timers.findIndex((t) => t.at <= timerNow)) timers.splice(due, 1)[0]!.fn();
  };
  /** Lets the stream deliver what was written (no time passes). */
  const settle = () => new Promise<void>((r) => setImmediate(r));
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  let text = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  const router = new KeyRouter(input, () => clock);
  const approver = createTtyApprover({ output, router, style: plain, classifierOn: () => true, readNote: async () => "", now: () => clock, setTimer });
  const pending = approver.ask(call(), { verdict: "ask", reason: "Runs the test suite.", source: "classifier" }, suggested);
  let settled: Answer | null = null;
  void pending.then((a) => (settled = a));
  return {
    router,
    /** `s` arrives, stamped `ms` after the key before it. */
    key: (s: string, ms: number) => {
      clock += ms;
      input.write(s);
    },
    /** What was written is delivered, then `ms` pass for the hold's timer (any timer due fires). */
    wait: async (ms: number) => {
      await settle();
      elapse(ms);
      await settle();
    },
    answer: () => settled as Answer | null,
    pending,
    text: () => text,
  };
}

test("inline approval: typing is not a decision: a word typed at a person's speed, ending in y, answers nothing", async () => {
  const r = rig();
  await r.wait(5);
  for (const ch of "today say yea") {
    r.key(ch, 100); // a person's speed, well after the settle time
    await r.wait(5);
  }
  await r.wait(HOLD_MS + 60);
  assert.equal(r.answer(), null, "the typing answered nothing");
  r.key("y", TYPING_GAP_MS - 1); // still too close to the last key
  await r.wait(HOLD_MS + 60);
  assert.equal(r.answer(), null);
  r.key("y", 1500); // a key on its own, after a pause
  await r.wait(HOLD_MS + 60);
  assert.deepEqual(r.answer(), { kind: "once" });
  assert.match(r.text(), /\n {2}yes\n$/);
  r.router.detach();
});

test("inline approval: an answering key followed by another inside the hold answers nothing", async () => {
  const r = rig();
  r.key("y", 2000);
  await r.wait(10);
  r.key("y", 10); // the second key of a burst the terminal delivered as two chunks
  await r.wait(HOLD_MS + 60);
  assert.equal(r.answer(), null, "the held key was cancelled");
  r.key("a", 2000);
  await r.wait(HOLD_MS + 60);
  assert.deepEqual(r.answer(), { kind: "session", rule });
  r.router.detach();
});

test("inline approval: typing carried over from before the prompt counts, and Escape refuses at once", async () => {
  let clock = 50_000;
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new Writable({ write: (_c, _e, cb) => cb() });
  const router = new KeyRouter(input, () => clock);
  router.attach();
  const pop = router.push(() => {}); // the running turn hears the typing
  input.write("t");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(router.lastInputAt, 50_000);
  const approver = createTtyApprover({ output, router, style: plain, classifierOn: () => true, readNote: async () => "", now: () => clock });
  clock += 100; // the prompt appears; the next key lands after the settle time but within the typing gap of the last
  const pending = approver.ask(call(), { verdict: "ask", reason: "x", source: "classifier" }, null);
  let settled: Answer | null = null;
  void pending.then((a) => (settled = a));
  clock += SETTLE_MS + 10;
  input.write("y");
  await new Promise((r) => setTimeout(r, HOLD_MS + 60));
  assert.equal(settled, null, "the y finishing a word begun before the prompt answered nothing");
  clock += 1;
  input.write("\u001b");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(settled, { kind: "deny" });
  pop();
  router.detach();
});

test("full-screen panel uses the same rules: a key within the typing gap of a resize or focus report answers nothing", () => {
  const p = new ApprovalPanel(call(), { verdict: "ask", reason: "x", source: "classifier" }, rule, true);
  p.drawn(0);
  p.input({ type: "resize", width: 80, height: 24 }, 1000, 1000, 10, 10);
  assert.equal(p.input({ type: "key", name: "y", text: "y", ctrl: false, alt: false, shift: false }, 1000 + TYPING_GAP_MS - 1, 10_000, 10, 10).kind, "none");
  assert.equal(p.holding, false);
  p.input({ type: "focus", focused: true }, 5000, 5000, 10, 10);
  assert.equal(p.input({ type: "key", name: "y", text: "y", ctrl: false, alt: false, shift: false }, 5100, 10_000, 10, 10).kind, "none");
  assert.equal(p.input({ type: "key", name: "y", text: "y", ctrl: false, alt: false, shift: false }, 9000, 10_000, 10, 10).kind, "none");
  assert.equal(p.holding, true);
  assert.equal(p.commit(9000 + HOLD_MS).kind, "answer");
});

// Every source and reason the gate can put to a person, with what the line must say and must not repeat.
const whyCases: { d: Decision; on?: boolean; is: string }[] = [
  { d: { verdict: "ask", source: "mode", reason: "Ask mode: this is put to you." }, is: "ask mode puts every write, command and remote action to you" },
  {
    d: { verdict: "ask", source: "mode", reason: "Auto mode has no classifier available, so it behaves as ask mode: this is put to you." },
    on: false,
    is: "Auto mode has no safety check available, so it behaves as ask mode: this is put to you.",
  },
  { d: { verdict: "allow", source: "mode", reason: "Unchecked mode: nothing is judged or asked." }, is: "Unchecked mode: nothing is judged or asked." },
  { d: { verdict: "ask", source: "rule", reason: "It pipes text into a shell, which is always put to you." }, is: "It pipes text into a shell, which is always put to you." },
  {
    d: { verdict: "ask", source: "rule", reason: "`notes.txt` leads through a symbolic link to /h/.ssh/id_rsa; it touches a private key or keychain, which is always put to you." },
    is: "`notes.txt` leads through a symbolic link to /h/.ssh/id_rsa; it touches a private key or keychain, which is always put to you.",
  },
  { d: { verdict: "ask", source: "rule", reason: "Pipes a download into a shell." }, is: "always asked: Pipes a download into a shell." },
  { d: { verdict: "ask", source: "rule", reason: "" }, is: "always asked" },
  { d: { verdict: "allow", source: "rule", reason: "It only reads inside the workspace." }, is: "a built-in rule: It only reads inside the workspace." },
  { d: { verdict: "allow", source: "session", reason: "You allowed `npm test` commands for the session." }, is: "You allowed `npm test` commands for the session." },
  { d: { verdict: "ask", source: "classifier", reason: "Classifier: Runs the test suite." }, is: "the safety check was unsure: Runs the test suite." },
  { d: { verdict: "deny", source: "classifier", reason: "Classifier: Deletes the home directory." }, is: "the safety check refused it: Deletes the home directory." },
  {
    d: { verdict: "ask", source: "classifier", reason: "Classifier would allow it, but part of the call was too long to show it, so this is put to you. (Classifier: Builds the project.)" },
    is: "the safety check would allow it, but part of the call was too long to show it, so this is put to you; its reason: Builds the project.",
  },
  { d: { verdict: "ask", source: "fallback", reason: "The classifier did not answer within 8 s, so this is put to you." }, is: "The safety check did not answer within 8 s, so this is put to you." },
  { d: { verdict: "ask", source: "fallback", reason: "The classifier could not be reached or failed, so this is put to you." }, is: "The safety check could not be reached or failed, so this is put to you." },
  { d: { verdict: "ask", source: "fallback", reason: "The classifier's answer could not be read, so this is put to you." }, is: "The safety check's answer could not be read, so this is put to you." },
  { d: { verdict: "ask", source: "fallback", reason: "Interrupted before the classifier answered, so this is put to you." }, is: "Interrupted before the safety check answered, so this is put to you." },
  { d: { verdict: "ask", source: "fallback", reason: "The gate could not judge this call, so it is put to you." }, is: "The gate could not judge this call, so it is put to you." },
  { d: { verdict: "ask", source: "fallback", reason: "timed out" }, is: "the safety check could not be reached: timed out" },
  { d: { verdict: "ask", source: "fallback", reason: "" }, on: false, is: "the safety check is off" },
];

test("why: every source and reason says who and why once, in both interfaces", () => {
  for (const c of whyCases) {
    const got = whyText(c.d, c.on ?? true);
    assert.equal(got, c.is, `${c.d.source}/${c.d.verdict}: ${c.d.reason}`);
    // Nothing said twice: no phrase of four words or more appears twice.
    const words = got.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    for (let i = 0; i + 4 <= words.length; i++) {
      const g = words.slice(i, i + 4).join(" ");
      assert.ok(!seen.has(g), `"${g}" said twice in: ${got}`);
      seen.add(g);
    }
    assert.doesNotMatch(got, /Classifier:/, "the gate's prefix never shows");
    if (c.d.verdict !== "ask") continue;
    // The inline prompt and the full-screen panel show the same line.
    const inline = formatApproval(call(), c.d, null, { style: plain, classifierOn: c.on ?? true });
    assert.ok(inline.includes(`why  ${got}`), inline);
    const panel = approvalBody({ call: call(), decision: c.d, suggested: null, classifierOn: c.on ?? true, scroll: 0, note: null }, 400)
      .map((l) => l.map((s) => s.text).join(""))
      .join("\n");
    assert.ok(panel.includes(`why ${got}`), panel);
  }
});
