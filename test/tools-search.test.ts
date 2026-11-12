import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Tool, ToolContext } from "../src/agent/types.js";
import { globMatcher, globToRegExp, ignored, listFiles, parseGitignore } from "../src/tools/files.js";
import { createLocalTools } from "../src/tools/index.js";
import { treeEntries } from "../src/tools/list.js";
import { findExecutable } from "../src/tools/process.js";

const posix = process.platform !== "win32";
const realGit = findExecutable("git");
const realRg = findExecutable("rg");

/** A small project: sources, tests, ignored build output and logs, node_modules and .git. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "memtro-search-"));
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put(".gitignore", "dist/\n*.log\n!keep.log\n");
  put("src/a.ts", "const greeting = 'hello';\nexport default greeting;\n");
  put("src/deep/b.test.ts", "line one\nHello again\nline three\nline four\nhello last\n");
  put("README.md", "# hello readme\n");
  put("dist/out.js", "hello from the build\n");
  put("debug.log", "hello log\n");
  put("keep.log", "hello kept\n");
  put("node_modules/pkg/index.js", "hello dependency\n");
  put("img.bin", "hello\u0000binary");
  return dir;
}

/** PATH holding only the named programs (symlinked), so `rg` and `git` presence is decided by the test. */
function pathWith(programs: Record<string, string | null>): string {
  const bin = mkdtempSync(join(tmpdir(), "memtro-bin-"));
  for (const [name, target] of Object.entries(programs)) if (target) symlinkSync(target, join(bin, name));
  return bin;
}

async function withPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

function tools(dir: string) {
  const all = new Map(createLocalTools().map((t) => [t.spec.name, t as Tool]));
  const ctx: ToolContext = { cwd: dir, workspaceRoot: dir, signal: new AbortController().signal };
  return async (name: string, raw: Record<string, unknown>) => {
    const t = all.get(name)!;
    const v = t.validate(raw);
    if (!v.ok) return { content: `invalid: ${v.error}`, isError: true };
    return t.run(v.args, ctx);
  };
}

const lines = (s: string) => s.split("\n").filter(Boolean);

for (const backend of ["walk", "git"] as const) {
  test(`glob, grep and list without rg (${backend})`, { skip: !posix || (backend === "git" && !realGit) }, async () => {
    const dir = project();
    if (backend === "git") execFileSync(realGit!, ["init", "-q"], { cwd: dir });
    const bin = pathWith(backend === "git" ? { git: realGit } : {});
    await withPath(bin, async () => {
      assert.equal((await listFiles(dir)).source, backend);
      const call = tools(dir);

      const ts = await call("glob", { pattern: "*.ts" });
      assert.deepEqual(lines(ts.content).sort(), ["src/a.ts", "src/deep/b.test.ts"]);
      assert.deepEqual(lines((await call("glob", { pattern: "src/*.ts" })).content), ["src/a.ts"]);
      assert.deepEqual(lines((await call("glob", { pattern: "**/*.{js,log}" })).content), ["keep.log"]);
      assert.match((await call("glob", { pattern: "*.py" })).content, /^No files under \. match \*\.py/);

      const g = await call("grep", { pattern: "hello" });
      assert.deepEqual(lines(g.content).sort(), ["README.md:1:# hello readme", "keep.log:1:hello kept", "src/a.ts:1:const greeting = 'hello';", "src/deep/b.test.ts:5:hello last"]);
      const ci = await call("grep", { pattern: "hello", ignore_case: true, glob: "*.test.ts", context: 1 });
      assert.equal(ci.content, ["src/deep/b.test.ts-1-line one", "src/deep/b.test.ts:2:Hello again", "src/deep/b.test.ts-3-line three", "src/deep/b.test.ts-4-line four", "src/deep/b.test.ts:5:hello last"].join("\n"));
      assert.equal((await call("grep", { pattern: "nothing-matches-this" })).content, "No matches.");
      const apart = await call("grep", { pattern: "^(greeting|export)", path: "src/a.ts", context: 0 });
      assert.equal(apart.content, "src/a.ts:2:export default greeting;");
      const sep = await call("grep", { pattern: "one|last", path: "src/deep/b.test.ts", context: 1 });
      assert.equal(sep.content, ["src/deep/b.test.ts:1:line one", "src/deep/b.test.ts-2-Hello again", "--", "src/deep/b.test.ts-4-line four", "src/deep/b.test.ts:5:hello last"].join("\n"));
      const inFile = await call("grep", { pattern: "export", path: "src/a.ts" });
      assert.equal(inFile.content, "src/a.ts:2:export default greeting;");

      const l = await call("list", { depth: 1 });
      assert.deepEqual(lines(l.content), ["./", ".gitignore", "README.md", "img.bin", "keep.log", "src/ (2 files)"]);
      const l2 = await call("list", { path: "src", depth: 1 });
      assert.deepEqual(lines(l2.content), ["src/", "a.ts", "deep/ (1 file)"]);
    });
  });
}

test("grep's JavaScript fallback reports a bad pattern as an error", { skip: !posix }, async () => {
  const dir = project();
  await withPath(pathWith({}), async () => {
    const r = await tools(dir)("grep", { pattern: "(unclosed" });
    assert.equal(r.isError, true);
    assert.match(r.content, /not a valid regular expression/);
  });
});

test("grep passes its arguments to rg as an array and reads rg's output", { skip: !posix }, async () => {
  const dir = project();
  const bin = mkdtempSync(join(tmpdir(), "memtro-fake-rg-"));
  const argsFile = join(bin, "args.txt");
  writeFileSync(join(bin, "rg"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argsFile}'; done\nprintf 'src/a.ts:1:hello\\n'\n`);
  chmodSync(join(bin, "rg"), 0o755);
  await withPath(bin, async () => {
    const r = await tools(dir)("grep", { pattern: "$(touch pwned) 'quoted'", glob: "*.ts", ignore_case: true, context: 2, path: "src" });
    assert.equal(r.content, "src/a.ts:1:hello");
  });
  const argv = readFileSync(argsFile, "utf8").split("\n");
  assert.ok(argv.includes("$(touch pwned) 'quoted'"), "the pattern arrives as one argument, unparsed");
  assert.deepEqual(argv.slice(argv.indexOf("--regexp"), argv.indexOf("--regexp") + 4), ["--regexp", "$(touch pwned) 'quoted'", "--", "src"]);
  assert.ok(argv.includes("--ignore-case") && argv.includes("--context") && argv.includes("*.ts"));
});

test("grep and glob with the real rg", { skip: !posix || !realRg }, async () => {
  const dir = project();
  await withPath(pathWith({ rg: realRg }), async () => {
    const call = tools(dir);
    assert.deepEqual(lines((await call("glob", { pattern: "*.ts" })).content).sort(), ["src/a.ts", "src/deep/b.test.ts"]);
    assert.match((await call("grep", { pattern: "hello" })).content, /src\/a.ts:1:/);
  });
});

test("glob returns newest first and caps at 200 with a count of the rest", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "memtro-glob-"));
  for (let i = 0; i < 250; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
  utimesSync(join(dir, "f7.txt"), new Date(), new Date(Date.now() + 60_000));
  await withPath(pathWith({}), async () => {
    const r = await tools(dir)("glob", { pattern: "*.txt" });
    const out = lines(r.content);
    assert.equal(out[0], "f7.txt");
    assert.equal(out.length, 201);
    assert.equal(out[200], "[50 more files matched and are not shown. Narrow the pattern or the path.]");
  });
});

test("grep caps its output and says how much more there was", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "memtro-grepcap-"));
  writeFileSync(join(dir, "many.txt"), Array.from({ length: 3000 }, (_, i) => `match ${i}`).join("\n"));
  await withPath(pathWith({}), async () => {
    const r = await tools(dir)("grep", { pattern: "match" });
    const out = lines(r.content);
    assert.equal(out.length, 2001);
    assert.match(out[2000]!, /^\[1000 more lines \([\d.]+ KB\) not shown\. Narrow the pattern, path or glob\.\]$/);
  });
});

test("globs and .gitignore rules", () => {
  assert.ok(globToRegExp("**/*.ts").test("a/b/c.ts"));
  assert.ok(globToRegExp("**/*.ts").test("c.ts"));
  assert.ok(globToRegExp("src/**").test("src/x/y"));
  assert.ok(!globToRegExp("*.ts").test("a/b.ts"));
  assert.ok(globToRegExp("f[!0-4].txt").test("f7.txt"));
  assert.ok(!globToRegExp("f[!0-4].txt").test("f3.txt"));
  assert.ok(globToRegExp("a.{js,ts}").test("a.ts"));
  assert.ok(globToRegExp("a+b(1).txt").test("a+b(1).txt"));
  assert.ok(globMatcher("*.ts")("deep/dir/x.ts"));
  assert.ok(!globMatcher("src/*.ts")("lib/src/x.ts"));
  const rules = parseGitignore("# c\n\n/build\nlogs/\n*.tmp\n!important.tmp\ndocs/*.pdf\n", "");
  assert.ok(ignored(rules, "build", true));
  assert.ok(!ignored(rules, "src/build", true), "a leading / anchors to the .gitignore's directory");
  assert.ok(ignored(rules, "a/logs", true));
  assert.ok(!ignored(rules, "a/logs", false), "a trailing / matches directories only");
  assert.ok(ignored(rules, "x/y.tmp", false));
  assert.ok(!ignored(rules, "x/important.tmp", false));
  assert.ok(ignored(rules, "docs/a.pdf", false));
  const nested = parseGitignore("*.gen\n", "pkg");
  assert.ok(ignored(nested, "pkg/a.gen", false));
  assert.ok(!ignored(nested, "other/a.gen", false));
});

test("treeEntries shows directories at the depth boundary with their file counts", () => {
  assert.deepEqual(treeEntries(["a.txt", "src/x.ts", "src/y/z.ts", "src/y/w.ts"], 2), ["a.txt", "src/", "src/x.ts", "src/y/ (2 files)"]);
});
