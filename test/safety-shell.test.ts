import assert from "node:assert/strict";
import { test } from "node:test";
import { commandSegments, readOnlyCommand, simpleCommand } from "../src/safety/shell.js";

const WS = "/home/ada/work/proj";
const ctx = { platform: "linux" as const, cwd: WS, workspaceRoot: WS };

test("shell: a simple command's words, with quoting handled just enough", () => {
  const cases: [string, string[]][] = [
    ["npm test", ["npm", "test"]],
    ["  npm   test  ", ["npm", "test"]],
    ["git commit -m 'fix the thing'", ["git", "commit", "-m", "fix the thing"]],
    ['echo "a b"', ["echo", "a b"]],
    ["a\\ b c", ["a b", "c"]],
    ["'n'pm test", ["npm", "test"]],
    ["echo ''", ["echo", ""]],
    ["git log HEAD~1", ["git", "log", "HEAD~1"]],
    ["ls *.ts", ["ls", "*.ts"]],
  ];
  for (const [command, words] of cases) {
    const r = simpleCommand(command, "linux");
    assert.ok(r.ok, `${command}: ${!r.ok ? r.reason : ""}`);
    assert.deepEqual(r.words, words, command);
  }
});

test("shell: anything the splitter could be wrong about is unsure", () => {
  const cases: [string, RegExp][] = [
    ["npm test; rm -rf ~", /`~` expansion|more than one command/],
    ["npm test; rm -rf x", /more than one command/],
    ["npm test && rm x", /more than one command/],
    ["npm test | sh", /more than one command/],
    ["echo $(id)", /variable or substitution/],
    ["echo $HOME", /variable or substitution/],
    ['echo "$x"', /could expand/],
    ['echo "a`id`"', /could expand/],
    ["echo `id`", /command substitution/],
    ["echo x > f", /redirection/],
    ["ls 2>&1", /redirection/],
    ["ls >| f", /redirection/],
    ["cat <<EOF", /redirection/],
    ["diff <(ls) x", /redirection|subshell/],
    ["sleep 1 &", /background/],
    ["ls\nrm x", /more than one line/],
    ["ls\r", /more than one line/],
    ["echo {a,b}", /braces/],
    ["( ls )", /subshell/],
    ["FOO=bar npm test", /environment variable/],
    ["cat ~/x", /`~` expansion/],
    ["ls --dir=~/x", /`~` expansion/],
    ["echo 'unterminated", /not closed/],
    ["echo x\\", /backslash/],
    ["ls || rm x", /`\|\|`/],
    ["ls |& cat", /standard error/],
    ["ls # rm", /comment/],
    ["echo !!", /`!`/],
    ["ls\u0007", /control character/],
    ["", /empty/],
  ];
  for (const [command, reason] of cases) {
    const r = simpleCommand(command, "linux");
    assert.equal(r.ok, false, command);
    if (!r.ok) assert.match(r.reason, reason, command);
  }
});

test("shell: segments split on && ; and | only", () => {
  const r = commandSegments("git status && git log -1; cat a | head -5", "linux");
  assert.ok(r.ok);
  assert.deepEqual(r.segments, [["git", "status"], ["git", "log", "-1"], ["cat", "a"], ["head", "-5"]]);
  for (const bad of ["ls;", "; ls", "ls && && ls", "ls ;; ls", "| ls"]) assert.equal(commandSegments(bad, "linux").ok, false, bad);
});

test("shell: cmd.exe commands are never analysed", () => {
  assert.equal(simpleCommand("dir", "win32").ok, false);
  assert.equal(readOnlyCommand("dir", { ...ctx, platform: "win32", cwd: "C:\\w", workspaceRoot: "C:\\w" }).ok, false);
});

test("read-only list: what is on it", () => {
  for (const command of [
    "git status",
    "git status --short",
    "ls -la src",
    "pwd",
    "cat a.txt | head -5",
    "git log --oneline -5 && git status",
    "git diff HEAD~1 -- src",
    "git show HEAD:src/a.ts",
    "git rev-parse --abbrev-ref HEAD",
    "git ls-files",
    "git blame src/a.ts",
    "git log main..feature",
    "grep -rn foo src",
    "rg -n 'a b' src",
    "find . -name '*.ts' -type f",
    "git branch",
    "git branch -a -v",
    "git branch --list 'feat*'",
    "git remote -v",
    "git remote",
    "node --version",
    "npm --version",
    "python3 --version",
    "go version",
    "git --version",
    "echo hello",
    "wc -l src/a.ts",
    "which node",
    "stat -c %s a",
    "file a.bin",
    "tail -n 20 log.txt",
    `cat ${WS}/src/a.ts`,
  ]) {
    const r = readOnlyCommand(command, ctx);
    assert.ok(r.ok, `${command}: ${!r.ok ? r.reason : ""}`);
  }
});

test("read-only list: each refusal, with its reason", () => {
  const cases: [string, RegExp][] = [
    ["cat $(echo a)", /substitution/],
    ["echo x > f", /redirection/],
    ["find . -exec rm x +", /find -exec/],
    ["find . -execdir rm x +", /find -execdir/],
    ["find . -delete", /find -delete/],
    ["find . -ok rm x +", /find -ok/],
    ["find . -fprint out", /find -fprint/],
    ["git branch -D main", /git branch -D/],
    ["git branch -d main", /git branch -d/],
    ["git branch -m a b", /git branch -m/],
    ["git branch new-branch", /creates a branch/],
    ["git remote add x y", /git remote -v/],
    ["git push", /not on the read-only list/],
    ["git checkout .", /not on the read-only list/],
    ["git -C .. status", /path with `\.\.`|options before/],
    ["git -c core.pager=sh log", /options before/],
    ["git diff --output=x", /can write or run/],
    ["git log --output x", /can write or run/],
    ["git diff --ext-diff", /can write or run/],
    ["rg --pre sh foo", /rg --pre/],
    ["rg --pre=./x foo", /rg --pre/],
    ["file -C -m magic", /file -C/],
    ["rm -rf build", /`rm` is not on the read-only list/],
    ["npm test", /`npm` is not on the read-only list/],
    ["node -e 1", /`node` is not on the read-only list/],
    ["cat a | sh", /`sh` is not on the read-only list/],
    ["/bin/ls", /not on the read-only list/],
    ["cat /etc/passwd", /outside the workspace/],
    ["grep -f/etc/x foo", /outside the workspace/],
    ["ls --dir=/etc", /outside the workspace/],
    ["cat ../secret", /`\.\.`/],
    ["ls ..", /`\.\.`/],
    ["ls &", /background/],
    ["ls 2>&1", /redirection/],
    ["ls; git status\nrm x", /more than one line/],
  ];
  for (const [command, reason] of cases) {
    const r = readOnlyCommand(command, ctx);
    assert.equal(r.ok, false, command);
    if (!r.ok) assert.match(r.reason, reason, command);
  }
});

test("read-only list: a working directory outside the workspace is refused", () => {
  const r = readOnlyCommand("ls", { ...ctx, cwd: "/tmp" });
  assert.equal(r.ok, false);
});
