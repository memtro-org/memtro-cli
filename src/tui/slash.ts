import type { Mode, SessionMeta, Tool } from "../agent/types.js";
import type { ModelInfo } from "../api/models.js";
import { compactNumber } from "./status.js";
import { oneLine } from "./sanitise.js";
import type { Style } from "./style.js";

/**
 * Slash commands: parsing, help, and what each does, against a host the interactive session implements. The
 * host is an interface so each command is tested without a terminal or a network.
 */

export interface SlashCommand {
  name: string;
  args: string;
}

/** One value an argument can take, for the full-screen interface's menu. */
export interface SlashChoice {
  /** What is typed after the command: `/mode ask`. */
  value: string;
  /** Shown beside the value, muted. */
  detail?: string;
  /** The value in force now, marked in a list. */
  current?: boolean;
}

/** What a command's choices are read from: the parts of the host that answer without side effects. */
export type ChoiceHost = Pick<SlashHost, "model" | "models" | "mode" | "sessions" | "actions" | "now"> & { theme?: () => string };

export interface SlashCommandInfo {
  name: string;
  usage: string;
  summary: string;
  /** The argument, as the menu shows it after the name: `[id]`, `ask|auto`. Empty when it takes none. */
  hint: string;
  /**
   * True when running it changes something beyond this screen (signs out, installs, starts afresh): the menu
   * completes such a command on Tab and runs it only on Enter.
   */
  acts: boolean;
  /** The values its argument can take, when they are known. Never does anything but read the host. */
  choices?: (host: ChoiceHost) => SlashChoice[];
}

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: "help", usage: "/help", summary: "These commands, and the keys", hint: "", acts: false },
  {
    name: "model",
    usage: "/model [<id>]",
    summary: "List the models this account offers, or switch to one",
    hint: "[id]",
    acts: false,
    choices: (h) =>
      (h.models() ?? []).map((m) => {
        const id = m.id.replace(/:(chat|agent)$/, "");
        return { value: id, current: id === h.model(), ...(m.context ? { detail: `${compactNumber(m.context)} context` } : {}) };
      }),
  },
  {
    name: "mode",
    usage: "/mode [ask|auto]",
    summary: "Show or change how much you are asked",
    hint: "[ask|auto]",
    acts: false,
    choices: (h) => [
      { value: "ask", detail: "every edit, command and remote action is put to you", current: h.mode() === "ask" },
      { value: "auto", detail: "the safety check judges them; its doubts are put to you", current: h.mode() === "auto" },
    ],
  },
  { name: "new", usage: "/new", summary: "Start a new session (this one stays saved)", hint: "", acts: true },
  {
    name: "resume",
    usage: "/resume",
    summary: "Carry on an earlier session in this directory",
    hint: "[session]",
    acts: true,
    choices: (h) =>
      h
        .sessions()
        .slice(0, SESSIONS_LISTED)
        .map((s) => ({ value: s.id, detail: `${oneLine(s.title) || "(untitled)"} · ${ago(s.started, h.now())}` })),
  },
  { name: "compact", usage: "/compact", summary: "Summarise the older part of the conversation now", hint: "", acts: true },
  { name: "copy", usage: "/copy", summary: "Copy the last answer to the clipboard", hint: "", acts: false },
  { name: "tools", usage: "/tools", summary: "The tools the model can use", hint: "", acts: false },
  {
    name: "actions",
    usage: "/actions on|off",
    summary: "Let Memtro's tools change connected systems, or stop them",
    hint: "on|off",
    acts: true,
    choices: (h) => [
      { value: "on", detail: "Memtro's tools can change connected systems (each call checked)", current: h.actions() },
      { value: "off", detail: "Memtro's tools can read, not change, connected systems", current: !h.actions() },
    ],
  },
  {
    name: "theme",
    usage: "/theme [dark|light|auto]",
    summary: "Change the colours (auto follows the terminal)",
    hint: "[dark|light|auto]",
    acts: false,
    choices: (h) =>
      (["auto", "dark", "light"] as const).map((v) => ({ value: v, current: h.theme?.() === v, ...(v === "auto" ? { detail: "follow the terminal's background" } : {}) })),
  },
  { name: "login", usage: "/login", summary: "Sign in again, perhaps as somebody else (the conversation carries on)", hint: "", acts: true },
  { name: "logout", usage: "/logout", summary: "Revoke this computer's key, remove it, and leave", hint: "", acts: true },
  { name: "update", usage: "/update", summary: "Update memtro to the latest release (it starts next time)", hint: "", acts: true },
  { name: "whoami", usage: "/whoami", summary: "Who the key belongs to", hint: "", acts: false },
  { name: "quit", usage: "/quit", summary: "Leave (so do /exit and Ctrl-D)", hint: "", acts: true },
];

export const findSlash = (name: string): SlashCommandInfo | undefined => SLASH_COMMANDS.find((c) => c.name === name);

/** `/model x` → {name: "model", args: "x"}. Null for text that is not a slash command. */
export function parseSlash(text: string): SlashCommand | null {
  const t = text.trim();
  // A command is one line. Several lines that begin with a command's name (a paste, say "/logout" then more) are a
  // message, so pasted text can never run a command that acts.
  if (t.includes("\n") || t.includes("\r")) return null;
  const m = /^\/([a-z]+)(?:\s+(.*))?$/.exec(t);
  if (!m || !text.startsWith("/")) return null;
  return { name: m[1]!, args: (m[2] ?? "").trim() };
}

export function slashHelp(st: Style): string {
  const width = Math.max(...SLASH_COMMANDS.map((c) => c.usage.length));
  const lines = SLASH_COMMANDS.map((c) => `  ${st.bold(c.usage.padEnd(width))}  ${c.summary}`);
  lines.push(
    "",
    `  ${st.dim("Enter sends. End a line with \\ to carry on onto the next; pasted text keeps its lines.")}`,
    `  ${st.dim("While the agent works, Esc or Ctrl-C stops it. Ctrl-C clears what you typed; twice, or Ctrl-D, leaves.")}`,
    `  ${st.dim("To send a message that starts with /, begin it with a space.")}`,
  );
  return lines.join("\n");
}

/** This directory's sessions without the one in progress: resuming that would change nothing. Both interfaces list these. */
export function otherSessions(list: SessionMeta[], current: string): SessionMeta[] {
  return list.filter((m) => m.id !== current);
}

export interface SlashHost {
  style: Style;
  say(text: string): void;
  model(): string;
  setModel(id: string): void;
  /** The models list, or null when it could not be loaded. */
  models(): ModelInfo[] | null;
  /** Normalises an id the person typed, or throws a message for them. */
  normaliseModel(id: string): string;
  mode(): Mode;
  setMode(mode: Mode): void;
  classifierOn(): boolean;
  newSession(): void;
  /** Earlier sessions in this directory, newest first, never the one in progress (`otherSessions`). */
  sessions(): SessionMeta[];
  resume(id: string): boolean;
  pick(prompt: string): Promise<string>;
  compact(): Promise<void>;
  tools(): Tool[];
  actions(): boolean;
  setActions(on: boolean): Promise<string>;
  login(): Promise<void>;
  /** Revokes and removes the key. True when the session should end (the key is gone from this computer). */
  logout(): Promise<boolean>;
  update(): Promise<void>;
  whoami(): Promise<void>;
  now(): Date;
  /** `/theme`: the full-screen interface changes its colours; the inline one has none of its own. */
  theme?(choice: string): void;
  /** `/copy`: the full-screen interface copies the last answer; the inline one leaves that to the terminal. */
  copy?(): void;
}

/** How long ago, in words a list can carry: "3 min ago", "2 h ago", "4 days ago". */
export function ago(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86_400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function sessionList(sessions: SessionMeta[], now: Date, st: Style): string {
  return sessions.map((s, i) => `  ${st.bold(String(i + 1).padStart(2))}  ${oneLine(s.title) || st.dim("(untitled)")}  ${st.dim(`${ago(s.started, now)} · ${oneLine(s.model)}`)}`).join("\n");
}

export const SESSIONS_LISTED = 20;

/** Runs one command. Returns "quit" for /quit, otherwise "ok". */
export async function runSlash(cmd: SlashCommand, h: SlashHost): Promise<"quit" | "ok"> {
  const st = h.style;
  switch (cmd.name) {
    case "help":
      h.say(slashHelp(st));
      return "ok";
    case "quit":
    case "exit":
      return "quit";
    case "model": {
      const models = h.models();
      if (!cmd.args) {
        if (!models) {
          h.say(`Model: ${h.model()}. The list of models could not be loaded, so any id is sent as typed.`);
          return "ok";
        }
        const lines = models.map((m) => {
          const current = m.id.replace(/:(chat|agent)$/, "") === h.model();
          const limit = m.context ? st.dim(` ${compactNumber(m.context)} context`) : "";
          return `  ${current ? st.green("●") : " "} ${oneLine(m.id)}${limit}`;
        });
        h.say(`${lines.join("\n")}\n${st.dim("  /model <id> to switch.")}`);
        return "ok";
      }
      let id: string;
      try {
        id = h.normaliseModel(cmd.args);
      } catch (err) {
        h.say(st.red((err as Error).message));
        return "ok";
      }
      if (models && !models.some((m) => m.id.replace(/:(chat|agent)$/, "") === id)) {
        h.say(st.red(`"${oneLine(id)}" is not a model this account offers. /model lists them.`));
        return "ok";
      }
      h.setModel(id);
      h.say(`Model: ${oneLine(id)}${models ? "" : st.dim(" (not checked: the list of models could not be loaded)")}.`);
      return "ok";
    }
    case "mode": {
      if (!cmd.args) {
        const m = h.mode();
        const note = m === "auto" && !h.classifierOn() ? " (the safety check's model is off, so it works like ask)" : "";
        h.say(`Mode: ${m}${note}. /mode ask puts every edit, command and remote action to you; /mode auto lets the safety check judge them.`);
        return "ok";
      }
      if (h.mode() === "unchecked") {
        h.say(st.red("This session was started with --unchecked; start a new one without it to be asked."));
        return "ok";
      }
      if (cmd.args !== "ask" && cmd.args !== "auto") {
        h.say(st.red("/mode takes ask or auto. (Nothing-checked mode is only the --unchecked flag.)"));
        return "ok";
      }
      h.setMode(cmd.args);
      h.say(cmd.args === "auto" && !h.classifierOn() ? "Mode: auto. The safety check's model is off, so auto works exactly like ask." : `Mode: ${cmd.args}.`);
      return "ok";
    }
    case "new":
      h.newSession();
      h.say("New session.");
      return "ok";
    case "resume": {
      const list = h.sessions().slice(0, SESSIONS_LISTED);
      if (!list.length) {
        h.say("No earlier sessions in this directory.");
        return "ok";
      }
      h.say(sessionList(list, h.now(), st));
      const answer = (await h.pick("Which one (number, Enter for none)? ")).trim();
      if (!answer) return "ok";
      const n = Number(answer);
      if (!Number.isInteger(n) || n < 1 || n > list.length) {
        h.say(st.red(`Not one of 1 to ${list.length}.`));
        return "ok";
      }
      const chosen = list[n - 1]!;
      h.say(h.resume(chosen.id) ? `Resumed: ${oneLine(chosen.title)}` : st.red("That session could not be loaded."));
      return "ok";
    }
    case "compact":
      await h.compact();
      return "ok";
    case "tools": {
      const tools = h.tools();
      const width = Math.min(32, Math.max(...tools.map((t) => t.spec.name.length), 4));
      h.say(tools.map((t) => `  ${st.bold(oneLine(t.spec.name).padEnd(width))}  ${st.dim(oneLine(t.spec.description.split("\n")[0] ?? "").slice(0, 90))}`).join("\n") || "No tools.");
      h.say(st.dim(`  Actions are ${h.actions() ? "on" : "off"} (/actions on|off).`));
      return "ok";
    }
    case "actions": {
      if (cmd.args !== "on" && cmd.args !== "off") {
        h.say(`Actions are ${h.actions() ? "on" : "off"}. /actions on lets Memtro's tools change connected systems; /actions off stops them.`);
        return "ok";
      }
      h.say(await h.setActions(cmd.args === "on"));
      return "ok";
    }
    case "login":
      await h.login();
      return "ok";
    case "logout":
      return (await h.logout()) ? "quit" : "ok";
    case "update":
      await h.update();
      return "ok";
    case "whoami":
      await h.whoami();
      return "ok";
    case "theme":
      if (!h.theme) h.say("/theme changes the full-screen interface's colours; this one uses your terminal's own.");
      else if (cmd.args && cmd.args !== "dark" && cmd.args !== "light" && cmd.args !== "auto") h.say(st.red("/theme takes dark, light or auto."));
      else h.theme(cmd.args);
      return "ok";
    case "copy":
      if (!h.copy) h.say("/copy works in the full-screen interface; here, select the text with your terminal.");
      else h.copy();
      return "ok";
    default:
      h.say(st.red(`Unknown command /${oneLine(cmd.name)}. /help lists them; to send text starting with /, begin it with a space.`));
      return "ok";
  }
}
