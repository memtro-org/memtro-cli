import type { Agent, AgentEvent } from "../agent/types.js";
import { signIn, signInOptions, startSignedIn, type SignInDeps } from "../auth/ensure.js";
import { refreshContext, type Context } from "../context.js";
import { errorText } from "../errors.js";
import { colourAllowed } from "../output.js";
import { normaliseModel, startSession, type Session } from "../session/start.js";
import { createTtyApprover } from "../tui/approval.js";
import { Composer, historyFile, readOneLine } from "../tui/input.js";
import { interruptKey, KeyRouter, type TtyIn } from "../tui/keys.js";
import { TurnRenderer } from "../tui/render.js";
import { oneLine } from "../tui/sanitise.js";
import { parseSlash, runSlash, sessionList, SESSIONS_LISTED, type SlashHost } from "../tui/slash.js";
import { Spinner } from "../tui/spinner.js";
import { statusLine } from "../tui/status.js";
import { style } from "../tui/style.js";
import { guardTerminal } from "../tui/terminal.js";
import { logout } from "./logout.js";
import { describeOutcome, loadUpdateApi, runUpdate, startUpdateCheck, type UpdateApi } from "./update.js";
import { whoami } from "./whoami.js";

/** A second Ctrl-C this soon after the first, while the turn is still stopping, leaves. */
export const SECOND_INTERRUPT_MS = 2000;

/**
 * `memtro` in a terminal: the interactive session. Inline, not full screen: output scrolls like any command's,
 * the prompt is readline while the agent is idle, and raw keys (Esc, Ctrl-C, an approval's one key) while it works.
 */
export async function chat(ctx: Context, deps: { signIn?: Partial<SignInDeps>; update?: UpdateApi } = {}): Promise<number> {
  const input = ctx.stdin as TtyIn;
  const out = ctx.stdout;
  const st = style(colourAllowed(out, ctx.env, Boolean(ctx.flags["no-color"])));
  const guard = guardTerminal(input, out);
  const router = new KeyRouter(input);
  const spinner = new Spinner(out as NodeJS.WritableStream & { columns?: number }, Boolean(out.isTTY), st.dim);
  const say = (text: string) => {
    spinner.stop();
    out.write(text.endsWith("\n") ? text : `${text}\n`);
  };

  let turn: AbortController | null = null;
  let lastInterrupt = 0;
  const leave = (code: number): never => {
    spinner.stop();
    router.detach();
    guard.restore();
    out.write("\n");
    process.exit(code);
  };

  const approver = createTtyApprover({
    output: out,
    router,
    style: st,
    classifierOn: () => session?.classifier.model != null,
    readNote: (prompt) => readOneLine(input, out, prompt),
    beforePrompt: () => spinner.stop(),
    onInterrupt: () => turn?.abort(),
    signal: () => turn?.signal ?? null,
  });

  let session: Session | undefined;
  // The background update check, stopped when the session ends however it ends.
  let stopUpdateCheck = () => {};
  try {
    say(st.dim("Starting…"));
    // No key: sign in first. A stored key Memtro refuses: sign in again, once.
    const started = await startSignedIn(ctx, signInOptions(ctx), (c) => startSession(c, { approver, interactive: true }), deps.signIn);
    ctx = started.ctx;
    session = started.value;
    // Reassigned by /login, which rebuilds the session around the new key; everything below reads it through here.
    let s: Session = session;
    say(`${st.bold("memtro")} ${st.dim(`· ${s.agent.model} · ${s.gate.mode} · ${s.cwd}${s.project ? ` (${s.project})` : ""}`)}`);
    for (const n of s.notices) say(st.yellow(`· ${oneLine(n)}`));
    stopUpdateCheck = await startUpdateCheck(ctx, (line) => say(st.yellow(`· ${line}`)), deps.update);
    say(st.dim("/help for commands. Esc stops the agent; Ctrl-D leaves."));

    const composer = new Composer({
      input,
      output: out,
      historyPath: historyFile(s.sessionsDir, s.cwd),
      prompt: `${st.cyan("›")} `,
      continuation: `${st.dim("…")} `,
      hint: st.dim,
    });

    if (s.pickResume) await pickSession(s, say, st, input, out);

    /** One turn, or a compaction: events drawn, Esc and Ctrl-C stop it. */
    const drive = async (events: (signal: AbortSignal) => AsyncIterable<AgentEvent>, agent: Agent) => {
      const controller = new AbortController();
      turn = controller;
      const r = new TurnRenderer((_ch, text) => {
        spinner.stop();
        out.write(text);
      }, { style: st, thinking: ctx.verbose ? "full" : "collapsed", shared: true, mode: s.gate.mode }, agent.model);
      router.attach();
      const pop = router.push((chunk, at) => {
        const key = interruptKey(chunk);
        if (!key) return;
        if (controller.signal.aborted) {
          if (key === "ctrl-c" && at - lastInterrupt < SECOND_INTERRUPT_MS) leave(130);
          lastInterrupt = at;
          return;
        }
        lastInterrupt = at;
        spinner.setLabel("Stopping… (Ctrl-C again to quit)");
        controller.abort();
      });
      spinner.start("Working…");
      try {
        for await (const e of events(controller.signal)) {
          r.event(e);
          // Waiting again after anything but the answer itself: say for what.
          if (e.type === "tool-call") spinner.start("Checking…");
          else if (e.type === "tool-decision") spinner.start("Running…");
          else if (e.type === "tool-progress") spinner.start(r.lastProgress || "Running…");
          else if (e.type !== "text" && e.type !== "thinking" && e.type !== "turn-end" && e.type !== "error") spinner.start("Working…");
          // Full thinking is printed as it comes, so a spinner would draw over its partial line.
          else if (e.type === "thinking" && !ctx.verbose) spinner.start("Thinking…");
          if (controller.signal.aborted) spinner.setLabel("Stopping…");
        }
      } catch (err) {
        r.event({ type: "error", message: err instanceof Error ? err.message : String(err), retryable: false });
      } finally {
        r.finish();
        spinner.stop();
        pop();
        router.detach();
        turn = null;
      }
      if (r.reason) say(statusLine({ ...r.stats, mode: s.gate.mode }, st));
    };

    const host: SlashHost = {
      style: st,
      say,
      model: () => s.agent.model,
      setModel: (id) => s.agent.setModel(id),
      models: () => s.models,
      normaliseModel,
      mode: () => s.gate.mode,
      setMode: (m) => s.gate.setMode(m),
      classifierOn: () => s.classifier.model !== null,
      newSession: () => void s.newAgent(),
      sessions: () => s.store.list(s.cwd),
      resume: (id) => {
        const loaded = s.store.load(id);
        if (!loaded) return false;
        s.newAgent(loaded);
        return true;
      },
      pick: (prompt) => readOneLine(input, out, prompt),
      compact: () => drive((signal) => s.agent.compact(signal), s.agent),
      tools: () => s.tools(),
      actions: () => s.actions(),
      setActions: (on) => s.setActions(on),
      login: async () => {
        // A person typed /login, so a person is there; signing in again replaces this profile's key.
        const ok = await signIn(ctx, { interactive: true, noBrowser: Boolean(ctx.flags["no-browser"]) }, deps.signIn).then(
          () => true,
          (err: unknown) => {
            say(st.red(errorText(err)));
            return false;
          },
        );
        if (!ok) return;
        // A fresh context reads the profile the sign-in just wrote; the conversation carries on with the new key.
        const fresh = refreshContext(ctx, { ...ctx.flags, continue: undefined, resume: undefined });
        const current = s.agent;
        const next = await startSession(fresh, { approver, interactive: true });
        const loaded = next.store.load(current.sessionId);
        next.newAgent(loaded ?? undefined);
        next.gate.setMode(s.gate.mode);
        if (loaded) next.agent.setModel(current.model);
        s = next;
        session = next;
        ctx = fresh;
      },
      logout: async () => {
        // Revokes the key and removes it; the session ends, since nothing after this could reach Memtro.
        const code = await logout(ctx).catch((err: unknown) => {
          say(st.red(errorText(err)));
          return null;
        });
        if (code === null) return false;
        say("Signed out, so this session ends here. The next memtro you run signs you in again.");
        return true;
      },
      update: async () => {
        const controller = new AbortController();
        // Ctrl-C while it downloads stops the update (cleaning up after itself) rather than the whole session.
        const onInt = () => controller.abort();
        process.on("SIGINT", onInt);
        try {
          const api = deps.update ?? (await loadUpdateApi());
          const outcome = await runUpdate(api, ctx.env, { signal: controller.signal, progress: (line) => say(st.dim(line)) });
          const d = describeOutcome(outcome);
          say(d.ok ? d.text : d.code === 1 ? st.red(d.text) : st.yellow(d.text));
        } catch (err) {
          say(st.red(`The update failed: ${errorText(err)}`));
        } finally {
          process.off("SIGINT", onInt);
        }
      },
      whoami: async () => {
        await whoami(ctx).catch((err: unknown) => say(st.red(err instanceof Error ? err.message : String(err))));
      },
      now: () => new Date(),
    };

    for (;;) {
      const text = await composer.read();
      if (text === null) break;
      if (!text.trim()) continue;
      const slash = parseSlash(text);
      if (slash) {
        if ((await runSlash(slash, host)) === "quit") break;
        continue;
      }
      await drive((signal) => s.agent.run(text, signal), s.agent);
    }
    return 0;
  } finally {
    stopUpdateCheck();
    spinner.stop();
    router.detach();
    guard.dispose();
  }
}

async function pickSession(s: Session, say: (t: string) => void, st: ReturnType<typeof style>, input: TtyIn, out: NodeJS.WritableStream): Promise<void> {
  const list = s.store.list(s.cwd).slice(0, SESSIONS_LISTED);
  if (!list.length) {
    say("No earlier sessions in this directory; starting a new one.");
    return;
  }
  say(sessionList(list, new Date(), st));
  const answer = (await readOneLine(input, out, "Which one (number, Enter for a new session)? ")).trim();
  const n = Number(answer);
  if (!answer || !Number.isInteger(n) || n < 1 || n > list.length) {
    if (answer) say(st.red(`Not one of 1 to ${list.length}; starting a new session.`));
    return;
  }
  const loaded = s.store.load(list[n - 1]!.id);
  if (loaded) {
    s.newAgent(loaded);
    say(`Resumed: ${oneLine(list[n - 1]!.title)}`);
  } else say(st.red("That session could not be loaded; starting a new one."));
}
