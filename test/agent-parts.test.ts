import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PlatformError } from "../src/api/client.js";
import { estimateTokens, planCompaction, serialiseForSummary, shouldCompact, summaryMessage } from "../src/agent/compaction.js";
import { dirsFromRoot, findContextFiles } from "../src/agent/context-files.js";
import { backoffMs, retryable, sleep } from "../src/agent/retry.js";
import { buildSystemPrompt, parseGitStatus } from "../src/agent/system-prompt.js";
import type { Message } from "../src/agent/types.js";
import { CliError, UnavailableError } from "../src/errors.js";

const tmp = mkdtempSync(join(tmpdir(), "memtro-parts-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// ---- compaction ----

const turn = (q: string, withCall = false): Message[] =>
  withCall
    ? [
        { role: "user", content: q },
        { role: "assistant", content: null, tool_calls: [{ id: `${q}-c`, name: "read", arguments: "{}" }] },
        { role: "tool", tool_call_id: `${q}-c`, content: "x".repeat(400) },
        { role: "assistant", content: "done" },
      ]
    : [
        { role: "user", content: q },
        { role: "assistant", content: "answer" },
      ];

test("planCompaction: cuts only before something the person typed, keeping the newest turn whole", () => {
  const msgs = [...turn("one", true), ...turn("two", true), ...turn("three", true)];
  const cut = planCompaction(msgs, 1)!;
  assert.equal(cut, 8, "only the newest turn fits a tiny budget, and it is kept anyway");
  assert.equal(msgs[cut]!.role, "user");
  const roomy = planCompaction(msgs, estimateTokens(msgs.slice(4)))!;
  assert.equal(roomy, 4);
  for (let budget = 0; budget < 2000; budget += 37) {
    const c = planCompaction(msgs, budget);
    if (c !== null) assert.equal(msgs[c]!.role, "user", `budget ${budget}`);
  }
});

test("planCompaction: nothing to do with one turn, or only a summary before the newest", () => {
  assert.equal(planCompaction(turn("only", true)), null);
  assert.equal(planCompaction([summaryMessage("s"), ...turn("next")], 1), null);
  assert.equal(planCompaction([]), null);
  assert.equal(planCompaction([summaryMessage("s"), ...turn("a"), ...turn("b")], 1), 3);
});

test("shouldCompact: at 80% of a known limit only", () => {
  assert.equal(shouldCompact(800, 1000), true);
  assert.equal(shouldCompact(799, 1000), false);
  assert.equal(shouldCompact(10_000_000, null), false);
});

test("serialiseForSummary: labelled, tool results cut short, earlier summary marked", () => {
  const text = serialiseForSummary([summaryMessage("before"), { role: "user", content: "q" }, { role: "assistant", content: "a", tool_calls: [{ id: "1", name: "grep", arguments: '{"pattern":"x"}' }] }, { role: "tool", tool_call_id: "1", content: "y".repeat(5000) }]);
  assert.match(text, /^\[Earlier summary\]:\nbefore/);
  assert.match(text, /\[Assistant tool call\]: grep\(\{"pattern":"x"\}\)/);
  assert.match(text, /\[3000 more characters\]/);
});

// ---- context files and the system prompt ----

test("dirsFromRoot: root down to cwd; just cwd when outside", () => {
  assert.deepEqual(dirsFromRoot("/r", "/r/a/b"), ["/r", "/r/a", "/r/a/b"]);
  assert.deepEqual(dirsFromRoot("/r", "/r"), ["/r"]);
  assert.deepEqual(dirsFromRoot("/r", "/elsewhere"), ["/elsewhere"]);
});

test("findContextFiles: outermost first, both names, capped, empty skipped", () => {
  const root = join(tmp, "repo");
  mkdirSync(join(root, "pkg", "sub"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "root agents");
  writeFileSync(join(root, "pkg", "CLAUDE.md"), "z".repeat(100));
  writeFileSync(join(root, "pkg", "sub", "AGENTS.md"), "  \n");
  const files = findContextFiles(root, join(root, "pkg", "sub"), 10);
  assert.deepEqual(files.map((f) => [f.path.slice(root.length), f.content, f.truncated]), [
    ["/AGENTS.md", "root agent", true],
    ["/pkg/CLAUDE.md", "z".repeat(10), true],
  ]);
});

test("parseGitStatus: branch and changed paths", () => {
  assert.deepEqual(parseGitStatus("## main...origin/main [ahead 1]\n M src/a.ts\n?? new.txt\n"), { branch: "main", changed: ["src/a.ts", "new.txt"] });
  assert.deepEqual(parseGitStatus("## No commits yet on trunk\n"), { branch: "trunk", changed: [] });
  assert.deepEqual(parseGitStatus("## HEAD (no branch)\n"), { branch: null, changed: [] });
});

test("buildSystemPrompt: tools, environment and marked project instructions", () => {
  const prompt = buildSystemPrompt(
    { cwd: "/r/pkg", workspaceRoot: "/r", project: "acme/app", git: { branch: "main", changed: ["a.ts"] }, platform: "linux", date: "2026-11-12" },
    [
      { name: "read", description: "", parameters: {} },
      { name: "bash", description: "", parameters: {} },
      { name: "memtro_search", description: "", parameters: {} },
    ],
    [{ path: "/r/AGENTS.md", content: "Use pnpm.", truncated: true }],
  );
  assert.match(prompt, /Tools on this computer: read, bash\./);
  assert.match(prompt, /reach Memtro.*memtro_search/);
  assert.match(prompt, /Working directory: \/r\/pkg/);
  assert.match(prompt, /Repository root: \/r/);
  assert.match(prompt, /Git branch: main/);
  assert.match(prompt, /1 changed \(a\.ts\)/);
  assert.match(prompt, /Date: 2026-11-12/);
  assert.match(prompt, /<project-instructions path="\/r\/AGENTS.md">\nUse pnpm.\n\[cut short[^\]]*\]\n<\/project-instructions>/);
});

// ---- retry ----

test("retryable: network, 5xx and a plain rate limit; never a quota, a refusal or a mid-stream error", () => {
  assert.equal(retryable(new UnavailableError("down")), true);
  assert.equal(retryable(new PlatformError("rate", { status: 429, retryable: true })), true);
  assert.equal(retryable(new PlatformError("500", { status: 500, retryable: true })), true);
  assert.equal(retryable(new PlatformError("quota", { status: 429, code: "allowance_exhausted" })), false);
  assert.equal(retryable(new PlatformError("402", { status: 402 })), false);
  assert.equal(retryable(new CliError("Memtro stopped part-way through the answer: x")), false);
  assert.equal(retryable(new Error("other")), false);
});

test("backoffMs: grows, capped, honours Retry-After", () => {
  assert.equal(backoffMs(0, undefined, () => 0), 500);
  assert.equal(backoffMs(2, undefined, () => 1), 4000);
  assert.equal(backoffMs(20, undefined, () => 1), 30_000);
  assert.equal(backoffMs(0, new PlatformError("r", { status: 429, retryable: true, retryAfterMs: 7000 })), 7000);
  assert.equal(backoffMs(0, new PlatformError("r", { status: 429, retryable: true, retryAfterMs: 999_000 })), 30_000);
});

test("sleep: an abort ends the wait at once", async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = sleep(10_000, ac.signal);
  ac.abort();
  await assert.rejects(p, (e: unknown) => e instanceof Error && e.name === "AbortError");
  assert.ok(Date.now() - started < 1000);
});
