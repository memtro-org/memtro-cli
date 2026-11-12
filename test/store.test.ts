import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialsPath, fileStore, tooOpen } from "../src/store/file.js";
import { preferredKind } from "../src/store/index.js";
import { KEYCHAIN_ARGS, keychainCommand, keychainStore, quoted } from "../src/store/keychain.js";
import { secretToolStore } from "../src/store/secret-tool.js";
import type { RunResult } from "../src/store/run.js";

const KEY = "sk-memtro-AbCdEf0123456789_-xyzXYZ0123456789abcd";
const posix = process.platform !== "win32";

test("file store: 0600 file in a 0700 directory, round trip, delete", { skip: !posix }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "memtro-")), "memtro");
  const store = fileStore(dir);
  assert.equal(await store.get("default"), null);
  await store.set("default", KEY);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(credentialsPath(dir)).mode & 0o777, 0o600);
  assert.equal(await store.get("default"), KEY);
  await store.set("work", KEY.replace("Ab", "Zz"));
  assert.equal(await store.delete("default"), true);
  assert.equal(await store.delete("default"), false);
  assert.equal(await store.get("work"), KEY.replace("Ab", "Zz"));
});

test("file store: refuses to read a file others can read", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "memtro-"));
  writeFileSync(credentialsPath(dir), JSON.stringify({ version: 1, keys: { default: KEY } }));
  chmodSync(credentialsPath(dir), 0o644);
  await assert.rejects(fileStore(dir).get("default"), /can be read by other users.*chmod 600/s);
  chmodSync(credentialsPath(dir), 0o600);
  assert.equal(await fileStore(dir).get("default"), KEY);
  assert.equal(tooOpen(0o100600), false);
  assert.equal(tooOpen(0o100640), true);
  assert.equal(tooOpen(0o100604), true);
});

test("file store: will not store something that is not a key, or under a bad profile name", async () => {
  const store = fileStore(mkdtempSync(join(tmpdir(), "memtro-")));
  await assert.rejects(store.set("default", "hunter2"));
  await assert.rejects(store.set("../evil", KEY));
});

test("keychain: the key travels hex-encoded on stdin; argv is only -i", () => {
  const line = keychainCommand.set("work", KEY);
  assert.deepEqual(KEYCHAIN_ARGS, ["-i"]);
  assert.ok(!line.includes(KEY), "the key never appears in plain form, even on stdin");
  assert.ok(line.includes(`-X "${Buffer.from(KEY).toString("hex")}"`));
  assert.equal(line, `add-generic-password -U -a "work" -s "memtro-cli" -l "Memtro CLI (work)" -X "${Buffer.from(KEY).toString("hex")}"\n`);
  assert.equal(keychainCommand.get("work"), 'find-generic-password -a "work" -s "memtro-cli" -w\n');
  assert.equal(keychainCommand.delete("work"), 'delete-generic-password -a "work" -s "memtro-cli"\n');
  assert.equal(line.split("\n").length, 2, "exactly one command");
});

test("keychain: nothing can break out of a quoted token", () => {
  for (const bad of ['a"b', "a\nb", "a;b", "a\\b", "a$b", "a`b", "a'b"]) assert.throws(() => quoted(bad));
  assert.equal(quoted("Memtro CLI (x_y-1)"), '"Memtro CLI (x_y-1)"');
  // Profile names are validated before they reach the stream at all.
  for (const bad of ['x" -s other', "x\ndelete-generic-password", "UPPER", "a".repeat(33), ""]) {
    assert.throws(() => keychainCommand.get(bad));
    assert.throws(() => keychainCommand.set(bad, KEY));
  }
  // And a "key" that is not one never reaches it either.
  assert.throws(() => keychainCommand.set("work", 'sk-memtro-abc"\ndelete-keychain'));
});

test("keychain store: drives security -i and reads 44 as 'no key'", async () => {
  const calls: { command: string; args: readonly string[]; input: string }[] = [];
  let next: RunResult = { code: 0, stdout: "", stderr: "" };
  const run = async (command: string, args: readonly string[], input: string) => (calls.push({ command, args, input }), next);
  const store = keychainStore(run);
  await store.set("default", KEY);
  assert.equal(calls[0]!.command, "/usr/bin/security");
  assert.deepEqual(calls[0]!.args, ["-i"]);
  assert.ok(!calls.some((c) => c.args.join(" ").includes(KEY)));
  next = { code: 0, stdout: `${KEY}\n`, stderr: "" };
  assert.equal(await store.get("default"), KEY);
  next = { code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." };
  assert.equal(await store.get("default"), null);
  assert.equal(await store.delete("default"), false);
  next = { code: 51, stdout: "", stderr: "User interaction is not allowed." };
  await assert.rejects(store.get("default"), /User interaction is not allowed/);
});

test("secret-tool store: the key is on stdin, the attributes in argv", async () => {
  const calls: { args: readonly string[]; input: string }[] = [];
  const store = secretToolStore("/usr/bin/secret-tool", async (_c, args, input) => (calls.push({ args, input }), { code: 0, stdout: "", stderr: "" }));
  await store.set("default", KEY);
  assert.deepEqual(calls[0]!.args, ["store", "--label=Memtro CLI (default)", "service", "memtro-cli", "account", "default"]);
  assert.equal(calls[0]!.input, KEY);
  const missing = secretToolStore("/x", async () => ({ code: 1, stdout: "", stderr: "" }));
  assert.equal(await missing.get("default"), null);
});

test("store choice: forced by MEMTRO_CREDENTIALS, else keychain, else secret-tool, else file", () => {
  const none = { keychain: () => false, secretTool: () => null };
  assert.equal(preferredKind({ MEMTRO_CREDENTIALS: "file" }, { keychain: () => true, secretTool: () => null }), "file");
  assert.equal(preferredKind({}, { keychain: () => true, secretTool: () => null }), "keychain");
  assert.equal(preferredKind({}, { keychain: () => false, secretTool: () => "/usr/bin/secret-tool" }), "secret-tool");
  assert.equal(preferredKind({}, none), "file");
  assert.throws(() => preferredKind({ MEMTRO_CREDENTIALS: "vault" }, none));
});
