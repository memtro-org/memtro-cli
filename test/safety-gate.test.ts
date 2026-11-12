import assert from "node:assert/strict";
import { test } from "node:test";
import type { Decision, ForcedCall, GateContext, Mode, PendingCall, Risk, SessionRule } from "../src/agent/types.js";
import { createGate, type GateOptions } from "../src/safety/index.js";

const HOME = "/home/ada";
const WS = "/home/ada/work/proj";
const CONFIG = `${HOME}/.config/memtro`;

let ids = 0;
function call(risk: Risk, summary: Partial<PendingCall["summary"]> = {}, tool = toolFor(risk)): PendingCall {
  return { id: `c${++ids}`, tool, args: {}, risk, summary: { title: `${tool} call`, ...summary } };
}
function toolFor(risk: Risk): string {
  return { read: "read", write: "edit", execute: "bash", "remote-read": "memtro_search", "remote-act": "github" }[risk];
}
const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  userMessages: ["please fix the failing test"],
  earlierCalls: [],
  cwd: WS,
  workspaceRoot: WS,
  signal: new AbortController().signal,
  ...over,
});

/** A classifier that answers `decision` and counts how often it was asked. */
function fakeClassifier(answer: Record<string, unknown> | null | "reject" = { decision: "allow", reason: "It is what was asked." }) {
  const seen: Parameters<ForcedCall>[0][] = [];
  const forced: ForcedCall = async (request) => {
    seen.push(request);
    if (answer === "reject") throw new Error("network down");
    return answer;
  };
  return { seen, classifier: { call: forced, model: "m", timeoutMs: 1000 } };
}

function gate(mode: Mode, over: Partial<GateOptions> = {}) {
  const fake = fakeClassifier();
  const g = createGate({ mode, classifier: fake.classifier, home: HOME, platform: "linux", configDir: CONFIG, ...over });
  return { g, seen: fake.seen };
}

// ---------------------------------------------------------------------------------------------------------------
// The decision table: one row per step of the order, for each risk
// ---------------------------------------------------------------------------------------------------------------

const CALLS: Record<string, () => PendingCall> = {
  "read inside": () => call("read", { paths: [`${WS}/src/a.ts`] }),
  "read outside": () => call("read", { paths: ["/etc/hosts"] }),
  "read no paths": () => call("read", {}),
  "read via symlink out": () => call("read", { paths: ["/etc/hosts", `${WS}/link`] }),
  "write via symlink out": () => call("write", { paths: ["/tmp/x", `${WS}/link`] }),
  "write inside": () => call("write", { paths: [`${WS}/src/a.ts`], diff: "+x" }),
  "write outside": () => call("write", { paths: ["/tmp/x"] }),
  "execute read-only": () => call("execute", { command: "git status" }),
  "execute other": () => call("execute", { command: "npm test" }),
  "remote-read": () => call("remote-read"),
  "remote-act": () => call("remote-act"),
  "always-ask read": () => call("read", { paths: [`${HOME}/.ssh/id_rsa`] }),
  "always-ask write": () => call("write", { paths: [`${WS}/.git/hooks/pre-commit`] }),
  "always-ask execute": () => call("execute", { command: "sudo ls" }),
  "always-ask remote-act": () => call("remote-act", { paths: [`${HOME}/.aws/credentials`] }),
};

type Row = [verdict: Decision["verdict"], source: Decision["source"]];
const ALLOW_RULE: Row = ["allow", "rule"];
const ASK_RULE: Row = ["ask", "rule"];
const ASK_MODE: Row = ["ask", "mode"];
const CLASSIFIER_ALLOW: Row = ["allow", "classifier"];

const TABLE: Record<string, Record<string, Row>> = {
  unchecked: Object.fromEntries(Object.keys(CALLS).map((k) => [k, ["allow", "mode"] as Row])),
  ask: {
    "read inside": ALLOW_RULE,
    "read outside": ASK_MODE,
    "read no paths": ASK_MODE,
    "read via symlink out": ASK_MODE,
    "write via symlink out": ASK_MODE,
    "write inside": ASK_MODE,
    "write outside": ASK_MODE,
    "execute read-only": ASK_MODE,
    "execute other": ASK_MODE,
    "remote-read": ALLOW_RULE,
    "remote-act": ASK_MODE,
    "always-ask read": ASK_RULE,
    "always-ask write": ASK_RULE,
    "always-ask execute": ASK_RULE,
    "always-ask remote-act": ASK_RULE,
  },
  auto: {
    "read inside": ALLOW_RULE,
    "read outside": CLASSIFIER_ALLOW,
    "read no paths": CLASSIFIER_ALLOW,
    "read via symlink out": CLASSIFIER_ALLOW,
    "write via symlink out": CLASSIFIER_ALLOW,
    "write inside": ALLOW_RULE,
    "write outside": CLASSIFIER_ALLOW,
    "execute read-only": ALLOW_RULE,
    "execute other": CLASSIFIER_ALLOW,
    "remote-read": ALLOW_RULE,
    "remote-act": CLASSIFIER_ALLOW,
    "always-ask read": ASK_RULE,
    "always-ask write": ASK_RULE,
    "always-ask execute": ASK_RULE,
    "always-ask remote-act": ASK_RULE,
  },
};

for (const [mode, rows] of Object.entries(TABLE)) {
  test(`gate table: mode ${mode}`, async () => {
    for (const [name, [verdict, source]] of Object.entries(rows)) {
      const { g, seen } = gate(mode as Mode);
      const d = await g.check(CALLS[name]!(), ctx());
      assert.deepEqual([d.verdict, d.source], [verdict, source], `${mode} / ${name}: ${d.reason}`);
      assert.equal(seen.length, source === "classifier" ? 1 : 0, `${mode} / ${name}: classifier consulted ${seen.length}`);
      assert.ok(d.reason.length > 0);
    }
  });
}

test("gate table: auto with no classifier behaves exactly as ask", async () => {
  for (const [name, row] of Object.entries(TABLE.ask!)) {
    const g = createGate({ mode: "auto", classifier: null, home: HOME, platform: "linux", configDir: CONFIG });
    const d = await g.check(CALLS[name]!(), ctx());
    assert.deepEqual([d.verdict, d.source], row, name);
    if (row[1] === "mode") assert.match(d.reason, /no classifier/);
  }
});

test("gate table: auto, the classifier's three answers and its failures", async () => {
  const cases: [Record<string, unknown> | null | "reject", Row][] = [
    [{ decision: "allow", reason: "Fine." }, ["allow", "classifier"]],
    [{ decision: "ask", reason: "Unsure." }, ["ask", "classifier"]],
    [{ decision: "block", reason: "Deletes the home directory." }, ["deny", "classifier"]],
    [null, ["ask", "fallback"]],
    ["reject", ["ask", "fallback"]],
    [{ decision: "maybe", reason: "x" }, ["ask", "fallback"]],
  ];
  for (const [answer, row] of cases) {
    for (const name of ["read outside", "write outside", "execute other", "remote-act"]) {
      const fake = fakeClassifier(answer);
      const g = createGate({ mode: "auto", classifier: fake.classifier, home: HOME, platform: "linux", configDir: CONFIG });
      const d = await g.check(CALLS[name]!(), ctx());
      assert.deepEqual([d.verdict, d.source], row, `${JSON.stringify(answer)} / ${name}`);
      if (row[1] === "classifier") assert.match(d.reason, /^Classifier: /);
    }
  }
});

test("gate table: a matching session rule allows, per risk, in ask and auto", async () => {
  const rows: [SessionRule, () => PendingCall][] = [
    [{ kind: "command", command: "npm test" }, () => call("execute", { command: "npm test" })],
    [{ kind: "command-prefix", words: ["npm", "test"] }, () => call("execute", { command: "npm test -- --watch" })],
    [{ kind: "write-under", dir: "/tmp/out" }, () => call("write", { paths: ["/tmp/out/a.txt"] })],
    [{ kind: "tool", tool: "github" }, () => call("remote-act")],
  ];
  for (const mode of ["ask", "auto"] as const) {
    for (const [rule, make] of rows) {
      const { g, seen } = gate(mode);
      g.remember(rule);
      const d = await g.check(make(), ctx());
      assert.deepEqual([d.verdict, d.source], ["allow", "session"], `${mode} ${JSON.stringify(rule)}`);
      assert.equal(seen.length, 0);
    }
  }
});

test("gate: check never throws; anything malformed is the fallback ask", async () => {
  const { g } = gate("auto");
  const bad: unknown[] = [null, {}, { id: "x", tool: "bash", risk: "execute", summary: { title: "Run" } }, { id: "x", tool: "bash", risk: "explode", summary: { title: "" } }, { id: "x", tool: "bash", risk: "execute" }];
  for (const c of bad) {
    const d = await g.check(c as PendingCall, ctx());
    assert.deepEqual([d.verdict, d.source], ["ask", "fallback"], JSON.stringify(c));
  }
  const d = await g.check(call("execute", { command: "npm test" }), null as unknown as GateContext);
  assert.deepEqual([d.verdict, d.source], ["ask", "fallback"]);
});

test("gate: setMode changes the mode and ignores nonsense", async () => {
  const { g } = gate("ask");
  g.setMode("auto");
  assert.equal(g.mode, "auto");
  g.setMode("yolo" as Mode);
  assert.equal(g.mode, "auto");
  g.setMode("unchecked");
  assert.equal((await g.check(call("execute", { command: "sudo rm -rf /" }), ctx())).verdict, "allow");
});

test("gate: the classifier's prompt never carries the call's arguments", async () => {
  const { g, seen } = gate("auto");
  const c = call("execute", { command: "npm test" });
  c.args = { command: "npm test", secret: "ARGUMENT-SENTINEL" };
  await g.check(c, ctx({ userMessages: ["run the tests"], earlierCalls: ["Read src/a.ts"] }));
  assert.equal(seen.length, 1);
  assert.ok(!seen[0]!.user.includes("ARGUMENT-SENTINEL"));
  assert.ok(!seen[0]!.system.includes("ARGUMENT-SENTINEL"));
});

// ---------------------------------------------------------------------------------------------------------------
// Session rules
// ---------------------------------------------------------------------------------------------------------------

test("session rules: exact command matches only itself", async () => {
  const { g } = gate("ask");
  g.remember({ kind: "command", command: "npm test" });
  assert.equal((await g.check(call("execute", { command: "npm test" }), ctx())).verdict, "allow");
  for (const command of ["npm test ", "npm test --x", "npm  test", "npm test; ls"]) {
    assert.equal((await g.check(call("execute", { command }), ctx())).verdict, "ask", command);
  }
});

test("session rules: a prefix matches only a single simple command", async () => {
  const { g } = gate("ask");
  g.remember({ kind: "command-prefix", words: ["npm", "test"] });
  for (const command of ["npm test", "npm test -- --watch", "npm 'test'", "  npm   test  "]) {
    assert.equal((await g.check(call("execute", { command }), ctx())).source, "session", command);
  }
  for (const command of [
    "npm test; rm -rf ~",
    "npm test; rm -rf x",
    "npm test && rm -rf x",
    "npm test | sh",
    "npm test > /etc/x",
    "npm test $(rm x)",
    "npm test `rm x`",
    "npm test\nrm x",
    "npm test &",
    "FOO=1 npm test",
    "npm testing",
    "npx test",
    "npm",
  ]) {
    assert.equal((await g.check(call("execute", { command }), ctx())).verdict, "ask", command);
  }
});

test("session rules: write-under compares segments after resolving `..`", async () => {
  const { g } = gate("ask");
  g.remember({ kind: "write-under", dir: `${WS}/src` });
  const ok = [`${WS}/src/a.ts`, `${WS}/src/deep/b.ts`, `${WS}/src/x/../c.ts`];
  for (const p of ok) assert.equal((await g.check(call("write", { paths: [p] }), ctx())).source, "session", p);
  const no = [[`${WS}/srcx/a.ts`], [`${WS}/src/../secret.ts`], [`${WS}/src/a.ts`, `${WS}/b.ts`], [], ["src/a.ts"]];
  for (const p of no) assert.equal((await g.check(call("write", { paths: p }), ctx())).verdict, "ask", JSON.stringify(p));
});

test("session rules: each kind matches its own risk only", async () => {
  const { g } = gate("ask");
  g.remember({ kind: "tool", tool: "bash" });
  g.remember({ kind: "tool", tool: "edit" });
  g.remember({ kind: "write-under", dir: "/tmp/out" });
  g.remember({ kind: "command", command: "/tmp/out/a" });
  assert.equal((await g.check(call("execute", { command: "rm -rf x" }), ctx())).verdict, "ask");
  assert.equal((await g.check(call("write", { paths: [`${WS}/a`] }), ctx())).verdict, "ask");
  assert.equal((await g.check(call("execute", { command: "ls", paths: ["/tmp/out/a"] }), ctx())).verdict, "ask");
  assert.equal((await g.check(call("read", { paths: ["/tmp/out/a"] }), ctx())).verdict, "ask");
});

test("session rules: remember silently refuses rules always-ask covers, and nonsense", async () => {
  const refused: unknown[] = [
    { kind: "command", command: "sudo ls" },
    { kind: "command", command: "cat ~/.ssh/id_rsa" },
    { kind: "command", command: "  " },
    { kind: "command-prefix", words: ["sudo"] },
    { kind: "command-prefix", words: ["git", "push", "--force"] },
    { kind: "command-prefix", words: ["memtro", "token"] },
    { kind: "command-prefix", words: [] },
    { kind: "command-prefix", words: [""] },
    { kind: "command-prefix", words: "npm test" },
    { kind: "write-under", dir: "/" },
    { kind: "write-under", dir: HOME },
    { kind: "write-under", dir: "/home" },
    { kind: "write-under", dir: `${HOME}/.ssh` },
    { kind: "write-under", dir: `${WS}/.git` },
    { kind: "write-under", dir: `${WS}/.git/hooks` },
    { kind: "write-under", dir: CONFIG },
    { kind: "write-under", dir: "relative/dir" },
    { kind: "tool", tool: "" },
    { kind: "everything" },
    null,
    "allow all",
  ];
  const { g } = gate("ask");
  for (const rule of refused) g.remember(rule as SessionRule);
  const probes = [
    call("execute", { command: "sudo ls" }),
    call("execute", { command: "git push --force" }),
    call("write", { paths: [`${WS}/a.ts`] }),
    call("write", { paths: ["/home/other/a"] }),
    call("write", { paths: [`${WS}/.git/config`] }),
    call("remote-act", {}, ""),
  ];
  for (const p of probes) assert.notEqual((await g.check(p, ctx())).source, "session", JSON.stringify(p.summary));
});

test("session rules: headless allowances arrive as initial rules, through the same checks", async () => {
  const g = createGate({
    mode: "ask",
    classifier: null,
    home: HOME,
    platform: "linux",
    configDir: CONFIG,
    initialRules: [
      { kind: "write-under", dir: WS },
      { kind: "command-prefix", words: ["npm", "test"] },
      { kind: "command-prefix", words: ["sudo"] },
    ],
  });
  assert.equal((await g.check(call("write", { paths: [`${WS}/src/a.ts`] }), ctx())).source, "session");
  assert.equal((await g.check(call("write", { paths: [`${WS}/.git/config`] }), ctx())).source, "rule");
  assert.equal((await g.check(call("execute", { command: "npm test" }), ctx())).source, "session");
  assert.equal((await g.check(call("execute", { command: "sudo npm test" }), ctx())).source, "rule");
});

// ---------------------------------------------------------------------------------------------------------------
// suggestRule
// ---------------------------------------------------------------------------------------------------------------

test("suggestRule: never broader than the call", async () => {
  const { g } = gate("ask");
  const suggest = async (c: PendingCall) => {
    await g.check(c, ctx());
    return g.suggestRule(c);
  };
  const exec = (command: string) => suggest(call("execute", { command }));
  assert.deepEqual(await exec("npm test"), { kind: "command-prefix", words: ["npm", "test"] });
  assert.deepEqual(await exec("git commit -m 'x'"), { kind: "command-prefix", words: ["git", "commit"] });
  assert.deepEqual(await exec("npm run build"), { kind: "command-prefix", words: ["npm", "run", "build"] });
  assert.deepEqual(await exec("pnpm run test:unit"), { kind: "command-prefix", words: ["pnpm", "run", "test:unit"] });
  assert.deepEqual(await exec("make"), { kind: "command", command: "make" });
  for (const command of [
    "bash -c 'rm x'",
    "sh script.sh",
    "node build.js",
    "python script.py",
    "python3 -m pytest",
    "npx vitest",
    "env FOO=1 make",
    "xargs rm",
    "eval x",
    "ruby x.rb",
    "perl -e 1",
    "git push origin main",
    "git config --get user.name",
    "git rebase -i main",
    "npm install left-pad",
    "npm exec foo",
    "npm run ./x",
    "go run main.go",
    "./scripts/build.sh",
    "/usr/bin/git status",
    "git -C x status",
    "rm -rf build",
    "npm test; rm -rf x",
    "npm test && npm run lint",
  ]) {
    assert.deepEqual(await exec(command), { kind: "command", command }, command);
  }
  // Setting git configuration is always asked, so it is never offered for the session at all.
  assert.equal(await exec("git config user.name x"), null);
});

test("suggestRule: none for always-ask calls, reads, or a write it cannot place", async () => {
  const { g } = gate("ask");
  const checked = async (c: PendingCall) => {
    await g.check(c, ctx());
    return g.suggestRule(c);
  };
  assert.equal(await checked(call("execute", { command: "sudo ls" })), null);
  assert.equal(await checked(call("execute", { command: "cat ~/.ssh/id_rsa" })), null);
  assert.equal(await checked(call("execute", { command: "git push -f" })), null);
  assert.equal(await checked(call("execute", {})), null);
  assert.equal(await checked(call("read", { paths: ["/etc/hosts"] })), null);
  assert.equal(await checked(call("write", { paths: [`${WS}/.git/config`] })), null);
  assert.equal(await checked(call("write", { paths: ["/tmp/x"] })), null);
  assert.equal(await checked(call("write", { paths: ["/other/.env"] })), null);
  assert.equal(await checked(call("write", { paths: [`${WS}/a/x`, `${WS}/b/y`] })), null);
  // Not checked first: the workspace is unknown, so no write rule.
  assert.equal(g.suggestRule(call("write", { paths: [`${WS}/src/a.ts`] })), null);

  assert.deepEqual(await checked(call("write", { paths: [`${WS}/src/a.ts`] })), { kind: "write-under", dir: `${WS}/src` });
  assert.deepEqual(await checked(call("remote-act", {}, "linear")), { kind: "tool", tool: "linear" });
});

test("suggestRule: what it offers, once remembered, allows the call it was offered for", async () => {
  const { g } = gate("ask");
  for (const c of [
    call("execute", { command: "npm test" }),
    call("execute", { command: "ls -la | wc -l" }),
    call("write", { paths: [`${WS}/src/a.ts`] }),
    call("remote-act", {}, "linear"),
  ]) {
    assert.equal((await g.check(c, ctx())).verdict, "ask");
    const rule = g.suggestRule(c);
    assert.ok(rule);
    g.remember(rule);
    assert.equal((await g.check({ ...c, id: `${c.id}b` }, ctx())).source, "session");
  }
});
