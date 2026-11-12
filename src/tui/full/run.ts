import type { Agent, AgentEvent, Answer, Approver, Decision, Message, PendingCall, SessionRule } from "../../agent/types.js";
import { errorText } from "../../errors.js";
import type { Session } from "../../session/start.js";
import { findSlash, otherSessions, parseSlash, runSlash, type SlashHost } from "../slash.js";
import { style } from "../style.js";
import { ApprovalPanel, HOLD_MS } from "./app/approval.js";
import { choiceDialog, helpDialog, modelDialog, paletteDialog, sessionsDialog, toolsDialog } from "./app/commands.js";
import { openDialog } from "./app/dialog.js";
import { editorSetText } from "./app/editing.js";
import { handleInput, settleScroll, syncMenu, type Effect } from "./app/keys.js";
import type { MenuContext } from "./app/menu.js";
import { createState, type AppState, type Item } from "./app/state.js";
import { addNotice, addUser, applyEvent, beginTurn, lastAnswer, markAsking } from "./app/transcript.js";
import { draw, geometry } from "./app/views.js";
import type { Editor } from "./editor.js";
import { darkTheme, lightTheme } from "./screen/colour.js";
import type { FullScreen } from "./screen/screen.js";
import type { Frame, Input, Theme } from "./types.js";

/**
 * The loop of the full-screen interface: the screen's input and draws, the agent's events, the approval panel and
 * the slash commands. Everything that has an effect is here; what is on screen is `draw(state)` and what a key
 * does to the state is `handleInput` (both pure apart from the editor).
 */

/** The parts of `SlashHost` that touch the session; the interface adds the rest (saying, compacting, picking). */
export type BaseHost = Omit<SlashHost, "style" | "say" | "pick" | "compact" | "theme" | "copy">;

export type ThemeName = "auto" | "dark" | "light";

export interface FullOptions {
  screen: FullScreen;
  editor: Editor;
  session: () => Session;
  /** The session's commands, with `say` going to the transcript. */
  host: (say: (text: string) => void) => BaseHost;
  /** Leaves the full screen for something that needs the normal one (signing in again), then comes back. */
  version: string;
  cwd: string;
  home?: string;
  organisation: string | null;
  verbose: boolean;
  startNotices: string[];
  pickResume: boolean;
  theme: ThemeName;
  noColour: boolean;
  /** The workspace's files, for the `@` menu. */
  listFiles: () => Promise<string[]>;
  /** Writes straight to the terminal, between frames (OSC 52). */
  writeRaw: (s: string) => void;
  env: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Files for `@` are listed again after this long. */
export const FILES_TTL_MS = 10_000;
/** A notice under the input fades after this long. */
export const NOTICE_MS = 4000;
/** The largest OSC 52 payload (base64) sent; many terminals drop or truncate longer ones. */
export const OSC52_MAX = 100_000;

export function themeFor(name: ThemeName, background: "dark" | "light" | null): Theme {
  if (name === "light") return lightTheme;
  if (name === "dark") return darkTheme;
  return background === "light" ? lightTheme : darkTheme;
}

/** Whether OSC 52 is worth sending here, and if not, why not. Pure over the environment. */
export function osc52Support(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; why: string } {
  const term = env.TERM ?? "";
  if (env.TERM_PROGRAM === "Apple_Terminal") return { ok: false, why: "Terminal.app does not accept clipboard requests from programs" };
  if (term === "linux" || term === "dumb") return { ok: false, why: "this terminal has no clipboard to write to" };
  return { ok: true };
}

/**
 * What `/copy` puts on the clipboard: the answer as written, without the control characters a model can put in it.
 * Pasted into a shell, an ESC [201~ in the text would end the terminal's bracketed paste early and the rest would
 * run as typed; a carriage return would hide what came before it. Tabs and newlines stay. Returns the text and how
 * many characters were left out, so the notice can say so.
 */
export function clipboardText(text: string): { text: string; removed: number } {
  const normal = text.replace(/\r\n/g, "\n");
  const out = normal.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return { text: out, removed: normal.length - out.length };
}

export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`;
}

export class FullApp implements Approver {
  state: AppState;
  private readonly o: FullOptions;
  private readonly now: () => number;
  private turn: AbortController | null = null;
  private approval: { panel: ApprovalPanel; resolve: (a: Answer) => void; cleanup: () => void } | null = null;
  private files: { list: string[]; at: number } | null = null;
  private filesLoading = false;
  private quit: (() => void) | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private noticeTimer: NodeJS.Timeout | null = null;
  private holdTimer: NodeJS.Timeout | null = null;
  private readonly host: SlashHost;
  private busy = false;
  private themeName: ThemeName;

  constructor(o: FullOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.themeName = o.theme;
    const s = o.session();
    this.state = createState({
      editor: o.editor,
      width: o.screen.width,
      height: o.screen.height,
      status: { model: s.agent.model, mode: s.gate.mode, organisation: o.organisation, tokens: null, contextUsed: null, contextLimit: s.contextLimit(s.agent.model) },
      version: o.version,
      cwd: o.cwd,
      ...(o.home ? { home: o.home } : {}),
      verbose: o.verbose,
      startNotices: o.startNotices,
      themeName: o.theme,
      noColour: o.noColour,
      seed: Math.floor(this.now() / 1000),
    });
    // Started with --continue or --resume <id>: the conversation carried on is on screen, as /resume shows it.
    const earlier = s.agent.messages();
    if (earlier.length) {
      const items = itemsFromMessages(earlier, 1);
      const first = earlier.find((m) => m.role === "user");
      const title = first && typeof first.content === "string" ? first.content.split("\n")[0]!.slice(0, 80) : "";
      if (items.length) this.state = settleScroll({ ...this.state, items, nextKey: items.length + 1, view: "conversation", title });
    }
    const base = o.host((text) => this.say(text));
    this.host = {
      ...base,
      style: style(false),
      say: (text) => this.say(text),
      // Picking from a list is a dialog here; runSlash's own prompt is never reached.
      pick: async () => "",
      compact: () => this.drive((signal) => this.session.agent.compact(signal), this.session.agent),
      theme: (choice) => this.setTheme(choice === "" ? null : (choice as ThemeName)),
      copy: () => this.copy(),
    };
  }

  private get session(): Session {
    return this.o.session();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------------------------------------------

  /** Starts the screen and runs until the person leaves. */
  run(): Promise<void> {
    const sc = this.o.screen;
    sc.onDraw((frame) => this.paint(frame));
    sc.onInput((input) => this.onInput(input));
    sc.onBackground(() => {
      if (this.themeName === "auto") sc.setTheme(themeFor("auto", sc.background));
    });
    sc.setTheme(themeFor(this.themeName, sc.background));
    return new Promise<void>((resolve) => {
      this.quit = resolve;
      sc.onClose(() => this.leave());
      sc.start();
      this.set({ ...this.state, width: sc.width, height: sc.height });
      if (this.o.pickResume) this.openResume();
    }).finally(() => this.dispose());
  }

  private dispose(): void {
    for (const t of [this.ticker, this.noticeTimer, this.holdTimer]) if (t) clearTimeout(t);
    this.ticker = this.noticeTimer = this.holdTimer = null;
    this.turn?.abort();
  }

  leave(): void {
    const q = this.quit;
    this.quit = null;
    if (this.approval) this.finishApproval({ kind: "deny", note: "The person left." }, false);
    q?.();
  }

  private paint(frame: Frame): void {
    draw(this.state, frame, this.o.screen.theme);
    // The settle time starts when the whole panel is on screen, not merely asked for.
    if (this.approval && !this.approval.panel.isDrawn && this.panelShown()) this.approval.panel.drawn(this.now());
  }

  private set(state: AppState): void {
    this.state = state;
    this.o.screen.invalidate();
    if (state.notice && !this.noticeTimer) {
      this.noticeTimer = setTimeout(() => {
        this.noticeTimer = null;
        if (this.state.notice && this.now() - this.state.notice.at >= NOTICE_MS - 50) this.set({ ...this.state, notice: null });
        else if (this.state.notice) this.set(this.state);
      }, NOTICE_MS);
      this.noticeTimer.unref?.();
    }
  }

  say(text: string): void {
    this.set(addNotice(this.state, text, "plain"));
  }

  private menuContext(): MenuContext {
    const s = this.session;
    return {
      host: { model: () => s.agent.model, models: () => s.models, mode: () => s.gate.mode, sessions: () => this.otherSessions(), actions: () => s.actions(), now: () => new Date(this.now()), theme: () => this.themeName },
      files: this.files ? this.files.list : null,
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------------------------------------------

  onInput(input: Input): void {
    if (this.approval) return this.approvalInput(input);
    const r = handleInput(this.state, input, { now: this.now(), menu: this.menuContext() });
    this.set(r.state);
    for (const e of r.effects) this.effect(e);
  }

  private effect(e: Effect): void {
    switch (e.kind) {
      case "send":
        return void this.send(e.text);
      case "slash":
        return void this.slash(e.line);
      case "interrupt":
        this.turn?.abort();
        return;
      case "quit":
        return this.leave();
      case "repaint":
        // A fresh frame: the screen forgets what it believes is shown and paints every cell.
        this.o.screen.setTheme(this.o.screen.theme);
        return;
      case "suspend":
        this.o.screen.suspend();
        return;
      case "files":
        return void this.loadFiles();
      case "choose":
        return void this.choose(e.dialog.kind, e.id, e.dialog.command);
    }
  }

  private async loadFiles(): Promise<void> {
    if (this.filesLoading) return;
    if (this.files && this.now() - this.files.at < FILES_TTL_MS) return;
    this.filesLoading = true;
    try {
      const list = await this.o.listFiles();
      this.files = { list, at: this.now() };
    } catch {
      this.files = { list: [], at: this.now() };
    } finally {
      this.filesLoading = false;
    }
    this.set(syncMenu(this.state, this.menuContext()).state);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------------------------------------------

  /** Sends a message (or queues it behind the running turn). */
  async send(text: string): Promise<void> {
    if (this.busy) {
      this.set({ ...this.state, queued: text });
      return;
    }
    let s = this.state;
    if (!s.items.length && s.startNotices.length) {
      for (const n of s.startNotices) s = addNotice(s, n, "warning");
    }
    this.set(addUser(s, text));
    await this.drive((signal) => this.session.agent.run(text, signal), this.session.agent);
  }

  /** One turn or compaction: its events folded into the state, Esc and Ctrl-C stop it. */
  async drive(events: (signal: AbortSignal) => AsyncIterable<AgentEvent>, agent: Agent): Promise<void> {
    const controller = new AbortController();
    this.turn = controller;
    this.busy = true;
    this.set(beginTurn(this.state, agent.model));
    this.ticker = setInterval(() => this.set({ ...this.state, tick: this.state.tick + 1 }), 100);
    this.ticker.unref?.();
    try {
      for await (const e of events(controller.signal)) this.set(applyEvent(this.state, e));
    } catch (err) {
      this.set(applyEvent(this.state, { type: "error", message: errorText(err), retryable: false }));
    } finally {
      if (this.ticker) clearInterval(this.ticker);
      this.ticker = null;
      this.turn = null;
      this.busy = false;
      const s = this.session;
      this.set({ ...this.state, running: false, stopping: false, status: { ...this.state.status, mode: s.gate.mode, contextLimit: this.state.status.contextLimit ?? s.contextLimit(s.agent.model) } });
    }
    const queued = this.state.queued;
    if (queued !== null && this.quit) {
      if (controller.signal.aborted) {
        // A turn the person stopped does not start another by itself: the queued message goes back into the input.
        const back = !this.state.editor.text;
        if (back) editorSetText(this.state.editor, queued);
        const text = back ? "Stopped. The queued message is back in the input; Enter sends it." : "Stopped. The queued message was not sent.";
        this.set({ ...this.state, queued: null, notice: { text, tone: "plain", at: this.now() } });
        return;
      }
      this.set({ ...this.state, queued: null });
      // Queued as it was typed: a command runs as a command, as it would have from an idle prompt.
      setImmediate(() => void (parseSlash(queued) ? this.slash(queued.trim()) : this.send(queued)));
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Approval
  // -------------------------------------------------------------------------------------------------------------

  ask(call: PendingCall, decision: Decision, suggested: SessionRule | null): Promise<Answer> {
    if (!this.quit) return Promise.resolve({ kind: "deny", note: "Nobody was there to answer." });
    // One question at a time: a second call never replaces the panel a person is reading (their key would answer a
    // call they had not seen), and the first is never left without an answer.
    if (this.approval) return Promise.resolve({ kind: "deny", note: "Another call was already waiting for the person's answer, so this one was not put to them." });
    return new Promise<Answer>((resolve) => {
      const panel = new ApprovalPanel(call, decision, suggested, this.session.classifier.model !== null);
      const signal = this.turn?.signal ?? null;
      const onAbort = () => {
        const out = panel.aborted();
        if (out.kind === "answer") this.finishApproval(out.answer, false);
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.approval = { panel, resolve, cleanup };
      this.set(markAsking({ ...this.state, view: "conversation", overlay: { kind: "approval", approval: panel.state }, menuDismissed: false }, call.id));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private approvalInput(input: Input): void {
    const a = this.approval!;
    if (input.type === "resize") {
      // The layout moved under the person: a held answer is dropped and the typing gap starts again.
      a.panel.input(input, this.now(), this.o.screen.sinceInput(), 1, 1);
      this.set({ ...this.state, width: input.width, height: input.height });
      return;
    }
    if (input.type === "key" && input.ctrl && input.name === "l") return this.effect({ kind: "repaint" });
    const g = geometry(this.state);
    const bodyHeight = g.approval?.bodyHeight ?? 1;
    const bodyLines = g.approval?.body.length ?? 1;
    const out = a.panel.input(input, this.now(), this.o.screen.sinceInput(), bodyHeight, bodyLines, this.panelShown());
    if (out.kind === "answer") return this.finishApproval(out.answer, out.interrupt);
    this.set({ ...this.state, overlay: { kind: "approval", approval: a.panel.state } });
    if (a.panel.holding) {
      if (this.holdTimer) clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        if (this.approval !== a) return;
        const c = a.panel.commit(this.now());
        if (c.kind === "answer") this.finishApproval(c.answer, c.interrupt);
      }, HOLD_MS + 5);
    }
  }

  /** Whether the whole approval panel fits on the screen as it is now (a terminal shrunk to a sliver shows only part). */
  private panelShown(): boolean {
    const r = geometry(this.state).approval?.rect;
    return Boolean(r && r.y >= 0 && r.x >= 0 && r.y + r.height <= this.state.height && r.x + r.width <= this.state.width && r.width >= 20);
  }

  private finishApproval(answer: Answer, interrupt: boolean): void {
    const a = this.approval;
    if (!a) return;
    this.approval = null;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    a.cleanup();
    this.set(markAsking({ ...this.state, overlay: { kind: "none" } }, null));
    a.resolve(answer);
    if (interrupt) {
      this.set({ ...this.state, stopping: true });
      this.turn?.abort();
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Commands and dialogs
  // -------------------------------------------------------------------------------------------------------------

  async slash(line: string): Promise<void> {
    const cmd = parseSlash(line);
    if (!cmd) return;
    const s = this.session;
    try {
      switch (cmd.name) {
        case "help":
          return this.openDialog(helpDialog());
        case "tools":
          return this.openDialog(toolsDialog(s.tools(), s.actions()));
        case "model":
          if (!cmd.args) return this.openDialog(modelDialog(s.models, s.agent.model));
          break;
        case "resume":
          if (!cmd.args) return this.openResume();
          return this.resume(cmd.args);
        case "mode":
        case "actions":
        case "theme": {
          if (cmd.args) break;
          const info = findSlash(cmd.name)!;
          return this.openDialog(choiceDialog(cmd.name, info.choices!(this.menuContext().host)));
        }
        case "new":
          this.host.newSession();
          this.set(this.fresh("New session. The last one is saved; /resume finds it."));
          return;
        case "login":
          return await this.outside(() => this.host.login());
        case "quit":
        case "exit":
          return this.leave();
      }
      if (this.busy && (cmd.name === "compact" || cmd.name === "login" || cmd.name === "logout" || cmd.name === "update")) {
        this.say(`/${cmd.name} waits until the turn has finished.`);
        return;
      }
      const r = await runSlash(cmd, this.host);
      this.afterSlash();
      if (r === "quit") this.leave();
    } catch (err) {
      this.set(addNotice(this.state, errorText(err), "warning"));
    }
  }

  /** The status line follows whatever a command changed. */
  private afterSlash(): void {
    const s = this.session;
    this.set({ ...this.state, status: { ...this.state.status, model: s.agent.model, mode: s.gate.mode, contextLimit: s.contextLimit(s.agent.model) } });
  }

  private openDialog(dialog: import("./app/dialog.js").DialogState): void {
    this.set({ ...this.state, overlay: { kind: "dialog", dialog } });
  }

  /** This directory's sessions, newest first, without the one in progress (resuming it would change nothing). */
  private otherSessions() {
    const s = this.session;
    return otherSessions(s.store.list(s.cwd), s.agent.sessionId);
  }

  private openResume(): void {
    const list = this.otherSessions();
    if (!list.length) {
      this.set({ ...this.state, notice: { text: "No earlier sessions in this directory.", tone: "plain", at: this.now() } });
      return;
    }
    this.openDialog(sessionsDialog(list, new Date(this.now())));
  }

  private resume(id: string): void {
    const s = this.session;
    let loaded: { meta: { title: string }; messages: Message[] } | null = null;
    try {
      loaded = s.store.load(id);
    } catch {
      loaded = null;
    }
    if (!loaded || !this.host.resume(id)) {
      this.set(addNotice(this.state, "That session could not be loaded.", "warning"));
      return;
    }
    let st = this.fresh(null);
    st = { ...st, items: itemsFromMessages(loaded.messages, 1), title: "" };
    st = { ...st, nextKey: st.items.length + 1, view: st.items.length ? "conversation" : "start" };
    const first = loaded.messages.find((m) => m.role === "user");
    st = { ...st, title: first && typeof first.content === "string" ? first.content.split("\n")[0]!.slice(0, 80) : loaded.meta.title };
    this.set(addNotice(st, `Resumed: ${loaded.meta.title}`, "info"));
    this.afterSlash();
  }

  /** A clean transcript (a new session, or one being resumed). */
  private fresh(notice: string | null): AppState {
    return settleScroll({
      ...this.state,
      view: "start",
      items: [],
      title: "",
      scroll: { pinned: true, anchor: { key: 0, offset: 0 } },
      status: { ...this.state.status, tokens: null, contextUsed: null },
      notice: notice ? { text: notice, tone: "plain", at: this.now() } : null,
      overlay: { kind: "none" },
    });
  }

  private async choose(kind: string, id: string, command?: string): Promise<void> {
    switch (kind) {
      case "palette":
        if (id.startsWith("key:")) return this.keyAction(id);
        return this.slash(id);
      case "model":
        return this.slash(`/model ${id}`);
      case "resume":
        return this.resume(id);
      case "choice":
        return this.slash(`/${command} ${id}`);
      default:
        return;
    }
  }

  private keyAction(id: string): void {
    switch (id) {
      case "key:interrupt":
        if (this.turn) this.effect({ kind: "interrupt" });
        return;
      case "key:top":
        return this.onInput({ type: "key", name: "g", ctrl: true, alt: false, shift: false });
      case "key:bottom":
        return this.onInput({ type: "key", name: "g", ctrl: true, alt: true, shift: false });
      case "key:repaint":
        return this.effect({ kind: "repaint" });
    }
  }

  /** Runs something that needs the normal screen (signing in in a browser), then comes back. */
  private async outside(fn: () => Promise<void>): Promise<void> {
    const sc = this.o.screen;
    sc.stop();
    try {
      await fn();
    } finally {
      sc.start();
      this.afterSlash();
      this.set({ ...this.state, width: sc.width, height: sc.height });
    }
  }

  setTheme(name: ThemeName | null): void {
    if (name === null) {
      this.say(`Theme: ${this.themeName}. /theme dark, light or auto (auto follows the terminal's background).`);
      return;
    }
    this.themeName = name;
    this.o.screen.setTheme(themeFor(name, this.o.screen.background));
    this.set({ ...this.state, themeName: name, notice: { text: `Theme: ${name}.`, tone: "plain", at: this.now() } });
  }

  copy(): void {
    const answer = lastAnswer(this.state);
    const { text, removed } = clipboardText(answer ?? "");
    if (!answer || !text.trim()) {
      this.say("There is no answer to copy yet.");
      return;
    }
    const support = osc52Support(this.o.env);
    if (!support.ok) {
      this.say(`Not copied: ${support.why}. Select the text instead${this.mouseNote()}.`);
      return;
    }
    const seq = osc52(text);
    if (seq.length > OSC52_MAX) {
      this.say(`Not copied: the answer is ${text.length} characters, more than terminals accept in one clipboard request. Select the text instead${this.mouseNote()}.`);
      return;
    }
    this.o.writeRaw(seq);
    const tmux = this.o.env.TMUX ? " Inside tmux it arrives only with `set -g set-clipboard on`." : "";
    const left = removed ? `, without ${removed} control character${removed === 1 ? "" : "s"} it held` : "";
    this.say(`Copied the last answer (${text.length} characters, as Markdown${left}) through your terminal's clipboard request (OSC 52). If it did not arrive, your terminal does not accept those; select the text instead${this.mouseNote()}.${tmux}`);
  }

  private mouseNote(): string {
    return " (while memtro has the mouse, hold Shift, or Option in iTerm2, as you drag; or start with --no-mouse)";
  }
}

/** A saved conversation as transcript items: what was said, and which tools ran. */
export function itemsFromMessages(messages: readonly Message[], firstKey: number): Item[] {
  const items: Item[] = [];
  let key = firstKey;
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool") results.set(m.tool_call_id, m.content);
  for (const m of messages) {
    if (m.role === "user") items.push({ key: key++, kind: "user", text: m.content });
    else if (m.role === "assistant") {
      if (m.content) items.push({ key: key++, kind: "assistant", text: m.content, done: true });
      for (const c of m.tool_calls ?? []) {
        const content = results.get(c.id);
        items.push({
          key: key++,
          kind: "tool",
          id: c.id,
          tool: c.name,
          risk: null,
          title: c.name,
          asking: false,
          progress: "",
          ...(content !== undefined ? { result: { content } } : {}),
        });
      }
    }
  }
  return items;
}

