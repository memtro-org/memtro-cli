import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { openSessionStore } from "../src/agent/session-store.js";
import { parseCommandLine } from "../src/args.js";
import { chat } from "../src/commands/chat.js";
import { buildContext } from "../src/context.js";
import { otherSessions } from "../src/tui/slash.js";
import { Capture, startFakePlatform, textReply, type FakePlatform } from "./fake-platform.js";

/** `/resume` behind `--inline` lists earlier sessions only, as the full-screen one does: never the one in progress. */

let fake: FakePlatform;
before(async () => (fake = await startFakePlatform()));
after(() => fake.close());

test("otherSessions leaves out the session in progress and keeps the order", () => {
  const meta = (id: string) => ({ id, cwd: "/r", started: "2026-11-01T00:00:00.000Z", model: "auto", title: id });
  assert.deepEqual(otherSessions([meta("cli-b"), meta("cli-now"), meta("cli-a")], "cli-now").map((m) => m.id), ["cli-b", "cli-a"]);
  assert.deepEqual(otherSessions([], "cli-now"), []);
});

test("inline /resume does not offer the session in progress", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "memtro-resume-cwd-")));
  const env: NodeJS.ProcessEnv = {
    MEMTRO_CONFIG_DIR: mkdtempSync(join(tmpdir(), "memtro-resume-")),
    MEMTRO_CREDENTIALS: "file",
    MEMTRO_BASE_URL: fake.base,
    MEMTRO_NO_UPDATE_CHECK: "1",
    XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "memtro-resume-state-")),
    NO_COLOR: "1",
    MEMTRO_API_KEY: fake.mintKey(),
  };
  // An earlier session in this directory.
  const store = openSessionStore({ env });
  store.create({ id: "cli-0123456789abcdef", cwd, started: new Date(Date.now() - 3_600_000).toISOString(), model: "auto", title: "the earlier work" });
  store.appendMessage("cli-0123456789abcdef", { role: "user", content: "the earlier work" });

  fake.chatScript.push(textReply("Hello back."));
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const stdout = new Capture(true);
  const ctx = buildContext({ stdout, stderr: new Capture(false), stdin, env, flags: parseCommandLine(["--no-classifier", "--inline"]).flags, positionals: [], cwd });
  const ended = chat(ctx);
  const until = async (re: RegExp) => {
    for (let i = 0; i < 500 && !re.test(stdout.text); i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(stdout.text, re);
  };
  await until(/\/help for commands/);
  // Typed, then Enter on its own: an Enter in the same chunk as the text would be a newline (an unmarked paste).
  // A slow machine only lengthens the pause, so real time is safe here.
  stdin.write("the current work");
  await new Promise((r) => setTimeout(r, 60));
  stdin.write("\r");
  await until(/Hello back\./);
  await new Promise((r) => setTimeout(r, 50));
  const before = stdout.text.length;
  stdin.write("/resume");
  await new Promise((r) => setTimeout(r, 60));
  stdin.write("\r");
  await until(/Which one/);
  const listed = stdout.text.slice(before);
  assert.match(listed, /1 {2}the earlier work/);
  assert.doesNotMatch(listed, /the current work {2}/, "the session in progress is not offered");
  assert.doesNotMatch(listed, / 2 {2}/, "only one session listed");
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 50));
  stdin.write("\u0004");
  stdin.end();
  const code = await Promise.race([ended, new Promise<string>((r) => setTimeout(() => r("hung"), 3000))]);
  assert.equal(code, 0);
});
