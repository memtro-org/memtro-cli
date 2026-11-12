import { Writable } from "node:stream";
import type { Agent, AgentEvent, Answer, Approver } from "../agent/types.js";
import { bool, str } from "../args.js";
import { signIn, signInOptions, startSignedIn, type SignInDeps } from "../auth/ensure.js";
import { interfaceSettings, type InterfaceSettings } from "../config.js";
import { refreshContext, type Context } from "../context.js";
import { errorText, UsageError } from "../errors.js";
import { colourAllowed, paint } from "../output.js";
import { normaliseModel, startSession, UNCHECKED_WARNING, type Session } from "../session/start.js";
import { createTtyApprover } from "../tui/approval.js";
import type { BaseHost, FullApp, ThemeName } from "../tui/full/run.js";
import { Composer, historyFile, readOneLine } from "../tui/input.js";
import { interruptKey, KeyRouter, type TtyIn } from "../tui/keys.js";
import { TurnRenderer } from "../tui/render.js";
import { oneLine } from "../tui/sanitise.js";
import { otherSessions, parseSlash, runSlash, sessionList, SESSIONS_LISTED, type SlashHost } from "../tui/slash.js";
import { Spinner } from "../tui/spinner.js";
import { statusLine } from "../tui/status.js";
import { style } from "../tui/style.js";
import { guardTerminal } from "../tui/terminal.js";
import { VERSION } from "../version.js";
import { logout } from "./logout.js";
import { describeOutcome, loadUpdateApi, runUpdate, startUpdateCheck, type UpdateApi } from "./update.js";
import { whoami } from "./whoami.js";

/** A second Ctrl-C this soon after the first, while the turn is still stopping, leaves. */
export const SECOND_INTERRUPT_MS = 2000;

export type ChatDeps = { signIn?: Partial<SignInDeps>; update?: UpdateApi };

/**
 * `memtro` in a terminal: the interactive session. Full screen when the terminal can carry it (see
 * `chooseInterface`), otherwise the inline interface.
 */
export async function chat(ctx: Context, deps: ChatDeps = {}): Promise<number> {
  const ui = interfaceSettings(ctx.config);
  themeFlag(ctx);
  const out = ctx.stdout as NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number };
  const which = chooseInterface({
    inlineFlag: bool(ctx.flags.inline),
    configured: ui.ui,
    stdinTTY: Boolean((ctx.stdin as { isTTY?: boolean }).isTTY),
    stdoutTTY: Boolean(out.isTTY),
    columns: out.columns,
    rows: out.rows,
    term: ctx.env.TERM,
  });
  if (which === "full") return chatFull(ctx, deps, ui);
  return chatInline(ctx, deps);
}

/** The smallest terminal the full-screen interface is drawn in. */
export const FULL_MIN = { columns: 50, rows: 12 };

/**
 * Full screen when stdin and stdout are terminals at least 50×12 and TERM is not "dumb"; inline with `--inline`,
 * `"ui": "inline"`, or anything smaller. Pure.
 */
export function chooseInterface(i: { inlineFlag: boolean; configured?: "full" | "inline"; stdinTTY: boolean; stdoutTTY: boolean; columns?: number; rows?: number; term?: string }): "full" | "inline" {
  if (i.inlineFlag || i.configured === "inline") return "inline";
  if (!i.stdinTTY || !i.stdoutTTY) return "inline";
  if (!i.term || i.term === "dumb") return "inline";
  if ((i.columns ?? 0) < FULL_MIN.columns || (i.rows ?? 0) < FULL_MIN.rows) return "inline";
  return "full";
}

/**
 * The inline interface: output scrolls like any command's, the prompt is readline while the agent is idle, and raw
 * keys (Esc, Ctrl-C, an approval's one key) while it works.
 */
async function chatInline(ctx: Context, deps: ChatDeps): Promise<number> {
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
      sessions: () => otherSessions(s.store.list(s.cwd), s.agent.sessionId),
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

/** How many files the `@` menu is offered at most. */
export const AT_FILES = 20_000;

/**
 * The full-screen interface. Signing in (which prints to the normal screen and may open a browser) is finished
 * before the alternate screen is entered; on the way out the terminal is put back and one line says how to resume.
 */
async function chatFull(ctx: Context, deps: ChatDeps, ui: InterfaceSettings): Promise<number> {
  const stdin = ctx.stdin as NodeJS.ReadStream;
  const stdout = ctx.stdout as NodeJS.WriteStream;
  const st = style(colourAllowed(stdout, ctx.env, Boolean(ctx.flags["no-color"])));
  const theme: ThemeName = themeFlag(ctx) ?? ui.theme ?? "auto";
  const mouse = bool(ctx.flags["no-mouse"]) ? false : ui.mouse ?? true;
  const guard = guardTerminal(stdin, stdout);

  let app: FullApp | null = null;
  // The agent is built before the interface exists; until it does there is nobody to ask, which is a refusal.
  const approver: Approver = {
    ask: (call, decision, suggested): Promise<Answer> => (app ? app.ask(call, decision, suggested) : Promise.resolve({ kind: "deny", note: "Nobody was there to answer." })),
  };
  let stopUpdateCheck = () => {};
  // Stops an /update still downloading when the session ends.
  const updates = new AbortController();
  // Loaded only here, so the other commands do not pay for the full screen's modules at start-up.
  const [{ FullApp: App, themeFor }, { createScreen }, { Editor }, { listFiles }] = await Promise.all([
    import("../tui/full/run.js"),
    import("../tui/full/screen/screen.js"),
    import("../tui/full/editor.js"),
    import("../tools/files.js"),
  ]);
  let screen: ReturnType<typeof createScreen> | null = null;
  let session: Session | undefined;
  try {
    stdout.write(`${st.dim("Starting…")}\n`);
    const started = await startSignedIn(ctx, signInOptions(ctx), (c) => startSession(c, { approver, interactive: true }), deps.signIn);
    ctx = started.ctx;
    session = started.value;
    let s: Session = session;
    const notices: string[] = [];
    if (s.gate.mode === "unchecked") notices.push(UNCHECKED_WARNING.replace(/^memtro: /, ""));
    notices.push(...s.notices);
    stopUpdateCheck = await startUpdateCheck(ctx, (line) => (app ? app.say(line) : notices.unshift(line)), deps.update);

    // From here the screen is the terminal's: anything the session's parts would print goes to the transcript.
    const quiet = (c: Context): Context => {
      const sink = textSink((text) => app?.say(text.replace(/\n$/, "")));
      return { ...c, stdout: sink, stderr: sink, out: paint(false), err: paint(false), log: (line: string) => (c.verbose ? app?.say(`[memtro] ${line}`) : undefined) };
    };
    // The client made at start-up logs through this context's `log`, looked up when it logs.
    ctx.log = (line: string) => {
      if (ctx.verbose) app?.say(`[memtro] ${line}`);
    };

    const host = (say: (text: string) => void): BaseHost => ({
      model: () => s.agent.model,
      setModel: (id) => s.agent.setModel(id),
      models: () => s.models,
      normaliseModel,
      mode: () => s.gate.mode,
      setMode: (m) => s.gate.setMode(m),
      classifierOn: () => s.classifier.model !== null,
      newSession: () => void s.newAgent(),
      sessions: () => otherSessions(s.store.list(s.cwd), s.agent.sessionId),
      resume: (id) => {
        const loaded = s.store.load(id);
        if (!loaded) return false;
        s.newAgent(loaded);
        return true;
      },
      tools: () => s.tools(),
      actions: () => s.actions(),
      setActions: (on) => s.setActions(on),
      // Runs with the full screen left (FullApp.outside): signing in prints and may wait for a pasted code.
      login: async () => {
        const ok = await signIn(ctx, { interactive: true, noBrowser: Boolean(ctx.flags["no-browser"]) }, deps.signIn).then(
          () => true,
          (err: unknown) => {
            say(errorText(err));
            return false;
          },
        );
        if (!ok) return;
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
        say("Signed in again; the conversation carries on.");
      },
      logout: async () => {
        const code = await logout(quiet(ctx)).catch((err: unknown) => {
          say(errorText(err));
          return null;
        });
        if (code === null) return false;
        say("Signed out, so this session ends here. The next memtro you run signs you in again.");
        return true;
      },
      update: async () => {
        try {
          const api = deps.update ?? (await loadUpdateApi());
          const outcome = await runUpdate(api, ctx.env, { signal: updates.signal, progress: (line) => say(line) });
          say(describeOutcome(outcome).text);
        } catch (err) {
          say(`The update failed: ${errorText(err)}`);
        }
      },
      whoami: async () => {
        await whoami(quiet(ctx)).catch((err: unknown) => say(errorText(err)));
      },
      now: () => new Date(),
    });

    const organisation = ctx.profileConfig.organisation?.name ?? null;
    const editor = new Editor({ historyPath: historyFile(s.sessionsDir, s.cwd) });
    // --no-color reaches the screen the way NO_COLOR does.
    const screenEnv = ctx.flags["no-color"] ? { ...ctx.env, NO_COLOR: "1" } : ctx.env;
    screen = createScreen({ stdin, stdout }, { theme: themeFor(theme, null), mouse, env: screenEnv });
    const workspace = s.workspaceRoot;
    app = new App({
      screen,
      editor,
      session: () => s,
      host,
      version: VERSION,
      cwd: s.cwd,
      home: ctx.env.HOME,
      organisation,
      verbose: ctx.verbose,
      startNotices: notices,
      pickResume: s.pickResume,
      theme,
      noColour: screen.depth === "none",
      listFiles: async () => (await listFiles(workspace, { env: ctx.env })).files.slice(0, AT_FILES),
      writeRaw: (text) => {
        stdout.write(text);
      },
      env: ctx.env,
    });
    await app.run();
    screen.stop();
    const line = resumeLine(s.agent);
    if (line) stdout.write(`${st.dim(line)}\n`);
    return 0;
  } catch (err) {
    // Never leave the person in the alternate screen: put the terminal back, then say what went wrong.
    screen?.stop();
    if (!app) throw err;
    stdout.write(`${st.red(`memtro: the interface stopped: ${errorText(err)}`)}\n`);
    const line = session ? resumeLine(session.agent) : null;
    if (line) stdout.write(`${st.dim(line)}\n`);
    return 1;
  } finally {
    updates.abort();
    stopUpdateCheck();
    guard.dispose();
  }
}

/** `--theme`, checked whichever interface runs (the inline one ignores it, but a typo is still a typo). */
function themeFlag(ctx: Context): ThemeName | undefined {
  const v = str(ctx.flags.theme);
  if (v !== undefined && v !== "auto" && v !== "dark" && v !== "light") throw new UsageError(`--theme must be auto, dark or light; got "${v}".`);
  return v;
}

/**
 * The one line left on the normal screen after the full screen closes: how to carry on. A session in which nothing
 * was said was never saved, so there is nothing to resume and nothing is printed.
 */
export function resumeLine(agent: Pick<Agent, "sessionId" | "messages">): string | null {
  if (!agent.messages().length) return null;
  return `Session ${agent.sessionId}. To carry on: memtro --resume ${agent.sessionId}`;
}

/** A writable that hands each write's text to `fn` (for commands that print, while the screen is the terminal's). */
function textSink(fn: (text: string) => void): NodeJS.WritableStream & { isTTY: false } {
  const w = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      fn(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      cb();
    },
  });
  return Object.assign(w, { isTTY: false as const });
}
