import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { displayPath, expandHome, isWithin, realPath, resolvePath, summaryPaths, type PathFs } from "../src/tools/paths.js";

/** A workspace and a sibling directory outside it, in a fresh temp directory. */
function layout() {
  const base = mkdtempSync(join(tmpdir(), "memtro-paths-"));
  const ws = join(base, "ws");
  const out = join(base, "outside");
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(ws, "src", "a.ts"), "a\n");
  writeFileSync(join(out, "secret.txt"), "s\n");
  return { base, ws, out, realOut: realpathSync(out), realWs: realpathSync(ws) };
}

test("a relative path resolves against cwd and is inside", () => {
  const { ws, realWs } = layout();
  const r = resolvePath("a.ts", { cwd: join(ws, "src"), workspaceRoot: ws });
  assert.equal(r.absolute, join(ws, "src", "a.ts"));
  assert.equal(r.real, join(realWs, "src", "a.ts"));
  assert.equal(r.inside, true);
  assert.equal(r.display, "a.ts");
});

test(".. traversal out of the workspace is outside", () => {
  const { ws } = layout();
  const r = resolvePath("../../outside/secret.txt", { cwd: join(ws, "src"), workspaceRoot: ws });
  assert.equal(r.inside, false);
  assert.equal(resolvePath("src/../../ws/src/a.ts", { cwd: ws, workspaceRoot: ws }).inside, true);
});

test("~ expands to the home directory", () => {
  const { ws, base } = layout();
  const r = resolvePath("~/notes.txt", { cwd: ws, workspaceRoot: ws, home: base });
  assert.equal(r.absolute, join(base, "notes.txt"));
  assert.equal(r.inside, false);
  assert.equal(expandHome("~", "/home/x", "linux"), "/home/x");
  assert.equal(expandHome("~bob/x", "/home/x", "linux"), "~bob/x");
  assert.equal(expandHome("~\\x", "C:\\Users\\x", "win32"), "C:\\Users\\x\\x");
});

test("a symlink pointing out of the workspace is outside, and both spellings are in the summary", () => {
  const { ws, out, realOut } = layout();
  symlinkSync(join(out, "secret.txt"), join(ws, "link.txt"));
  const r = resolvePath("link.txt", { cwd: ws, workspaceRoot: ws });
  assert.equal(r.real, join(realOut, "secret.txt"));
  assert.equal(r.inside, false);
  assert.deepEqual(summaryPaths(r), [r.real, r.absolute]);
});

test("a symlinked parent directory is followed for a file that does not exist yet", () => {
  const { ws, out, realOut } = layout();
  symlinkSync(out, join(ws, "sub"));
  const r = resolvePath("sub/new/deeper.txt", { cwd: ws, workspaceRoot: ws });
  assert.equal(r.real, join(realOut, "new", "deeper.txt"));
  assert.equal(r.inside, false);
});

test("a dangling symlink is followed to where a write would land", () => {
  const { ws, out, realOut } = layout();
  symlinkSync(join(out, "not-yet.txt"), join(ws, "dangling"));
  const r = resolvePath("dangling", { cwd: ws, workspaceRoot: ws });
  assert.equal(r.real, join(realOut, "not-yet.txt"));
  assert.equal(r.inside, false);
  // and a relative dangling link that stays inside
  symlinkSync("src/later.ts", join(ws, "inner"));
  const inner = resolvePath("inner", { cwd: ws, workspaceRoot: ws });
  assert.equal(inner.inside, true);
  assert.ok(inner.real.endsWith(join("src", "later.ts")));
});

test("a symlink loop does not hang", () => {
  const { ws } = layout();
  symlinkSync(join(ws, "b"), join(ws, "a"));
  symlinkSync(join(ws, "a"), join(ws, "b"));
  const r = resolvePath("a/x", { cwd: ws, workspaceRoot: ws });
  assert.equal(typeof r.real, "string");
});

test("a workspace reached through a symlink still contains its files", () => {
  const { base, ws } = layout();
  symlinkSync(ws, join(base, "ws-link"));
  const r = resolvePath("src/a.ts", { cwd: join(base, "ws-link"), workspaceRoot: join(base, "ws-link") });
  assert.equal(r.inside, true);
});

test("macOS: a path typed in another case resolves to the on-disk spelling", { skip: process.platform !== "darwin" }, (t) => {
  const { ws, realWs } = layout();
  if (!existsSync(join(ws, "SRC"))) return t.skip("case-sensitive volume");
  const r = resolvePath("SRC/A.TS", { cwd: ws, workspaceRoot: ws });
  assert.equal(r.real, join(realWs, "src", "a.ts"));
  assert.equal(r.inside, true);
  const created = resolvePath("SRC/New.ts", { cwd: ws, workspaceRoot: ws.toUpperCase() });
  assert.equal(created.inside, true);
});

/** A Windows filesystem in memory: existing paths (case-insensitive, returned in their stored case) and links. */
function fakeWin(existing: string[], links: Record<string, string> = {}): PathFs {
  const byLower = new Map(existing.map((p) => [p.toLowerCase(), p]));
  const linkByLower = new Map(Object.entries(links).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    realpath: (p) => {
      if (linkByLower.has(p.toLowerCase())) return null;
      return byLower.get(p.toLowerCase()) ?? null;
    },
    readlink: (p) => linkByLower.get(p.toLowerCase()) ?? null,
  };
}

test("Windows: drive paths, other drives, case and .. are judged as Windows does", () => {
  const fs = fakeWin(["C:\\", "C:\\repo", "C:\\repo\\src", "C:\\other", "D:\\"], { "C:\\repo\\out": "C:\\other" });
  const env = { cwd: "C:\\repo", workspaceRoot: "C:\\repo", home: "C:\\Users\\me", platform: "win32" as const, fs };
  assert.equal(resolvePath("src\\x.ts", env).inside, true);
  assert.equal(resolvePath("c:\\REPO\\src\\x.ts", env).inside, true);
  assert.equal(resolvePath("c:\\REPO\\src\\x.ts", env).real, "C:\\repo\\src\\x.ts");
  assert.equal(resolvePath("..\\other\\x", env).inside, false);
  assert.equal(resolvePath("D:\\repo\\x", env).inside, false);
  assert.equal(resolvePath("C:src\\y.ts", env).inside, true);
  assert.equal(resolvePath("\\\\server\\share\\x", env).inside, false);
  const linked = resolvePath("out\\x.txt", env);
  assert.equal(linked.real, "C:\\other\\x.txt");
  assert.equal(linked.inside, false);
  assert.equal(resolvePath("~\\x", env).absolute, "C:\\Users\\me\\x");
});

test("isWithin does not mistake a sibling with a common prefix, or a name starting with ..", () => {
  assert.equal(isWithin("/a/b", "/a/bc", "linux"), false);
  assert.equal(isWithin("/a/b", "/a/b", "linux"), true);
  assert.equal(isWithin("/a/b", "/a/b/..hidden", "linux"), true);
  assert.equal(isWithin("/a/b", "/a", "linux"), false);
  assert.equal(isWithin("C:\\a", "c:\\A\\x", "win32"), true);
  assert.equal(isWithin("C:\\a", "D:\\a\\x", "win32"), false);
});

test("realPath leaves a path alone when nothing on it exists", () => {
  const nothing: PathFs = { realpath: () => null, readlink: () => null };
  assert.equal(realPath("/x/y/z", nothing, "linux"), "/x/y/z");
});

test("displayPath is relative under cwd, ~ under home, absolute elsewhere", () => {
  assert.equal(displayPath("/w/src/a.ts", "/w", "/h", "linux"), "src/a.ts");
  assert.equal(displayPath("/w", "/w", "/h", "linux"), ".");
  assert.equal(displayPath("/h/.ssh/config", "/w", "/h", "linux"), "~/.ssh/config");
  assert.equal(displayPath("/etc/hosts", "/w", "/h", "linux"), "/etc/hosts");
});
