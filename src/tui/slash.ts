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

export const SLASH_COMMANDS: { name: string; usage: string; summary: string }[] = [
  { name: "help", usage: "/help", summary: "These commands, and the keys" },
  { name: "model", usage: "/model [<id>]", summary: "List the models this account offers, or switch to one" },
  { name: "mode", usage: "/mode [ask|auto]", summary: "Show or change how much you are asked" },
  { name: "new", usage: "/new", summary: "Start a new session (this one stays saved)" },
  { name: "resume", usage: "/resume", summary: "Carry on an earlier session in this directory" },
  { name: "compact", usage: "/compact", summary: "Summarise the older part of the conversation now" },
  { name: "tools", usage: "/tools", summary: "The tools the model can use" },
  { name: "actions", usage: "/actions on|off", summary: "Let Memtro's tools change connected systems, or stop them" },
  { name: "login", usage: "/login", summary: "Sign in again, perhaps as somebody else (the conversation carries on)" },
  { name: "logout", usage: "/logout", summary: "Revoke this computer's key, remove it, and leave" },
  { name: "update", usage: "/update", summary: "Update memtro to the latest release (it starts next time)" },
  { name: "whoami", usage: "/whoami", summary: "Who the key belongs to" },
  { name: "quit", usage: "/quit", summary: "Leave (Ctrl-D does too)" },
];

/** `/model x` → {name: "model", args: "x"}. Null for text that is not a slash command. */
export function parseSlash(text: string): SlashCommand | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
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
    default:
      h.say(st.red(`Unknown command /${oneLine(cmd.name)}. /help lists them; to send text starting with /, begin it with a space.`));
      return "ok";
  }
}
