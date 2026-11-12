import type { SessionMeta, Tool } from "../../../agent/types.js";
import { explicitModelsUsable, type ModelInfo } from "../../../api/models.js";
import { LOCAL_TOOL_NAMES } from "../../../tools/names.js";
import { ago, SESSIONS_LISTED, SLASH_COMMANDS } from "../../slash.js";
import { compactNumber } from "../../status.js";
import { openDialog, type DialogRow, type DialogState } from "./dialog.js";
import { clean } from "./text.js";

/**
 * The dialogs' contents, built from plain data so each is tested without a session: the palette, the model picker,
 * the session list, help and the tools.
 */

const GROUP: Record<string, string> = {
  new: "Session",
  resume: "Session",
  compact: "Session",
  copy: "Session",
  model: "Model",
  mode: "Safety",
  actions: "Safety",
  login: "Account",
  logout: "Account",
  whoami: "Account",
  help: "App",
  tools: "App",
  theme: "App",
  update: "App",
  quit: "App",
};

const SECTIONS = ["Session", "Model", "Safety", "Account", "App"];

/** Key actions that are not slash commands, offered in the palette beside them. Their ids start with `key:`. */
export const KEY_ACTIONS: { id: string; label: string; key: string; section: string }[] = [
  { id: "key:interrupt", label: "Interrupt the turn", key: "esc", section: "Session" },
  { id: "key:top", label: "Scroll to the top", key: "ctrl+g", section: "Session" },
  { id: "key:bottom", label: "Scroll to the newest", key: "ctrl+alt+g", section: "Session" },
  { id: "key:repaint", label: "Repaint the screen", key: "ctrl+l", section: "App" },
];

const LABEL: Record<string, string> = {
  help: "Help",
  model: "Switch model",
  mode: "Switch mode (ask or auto)",
  new: "New session",
  resume: "Resume a session",
  compact: "Compact the conversation",
  copy: "Copy the last answer",
  tools: "Tools",
  actions: "Actions in connected systems (on or off)",
  theme: "Theme",
  login: "Sign in again",
  logout: "Sign out and leave",
  update: "Update memtro",
  whoami: "Who am I",
  quit: "Quit",
};

export function paletteDialog(): DialogState {
  const rows: DialogRow[] = [];
  for (const section of SECTIONS) {
    for (const c of SLASH_COMMANDS) if (GROUP[c.name] === section) rows.push({ id: `/${c.name}`, label: LABEL[c.name] ?? c.summary, detail: `/${c.name}`, section });
    for (const k of KEY_ACTIONS) if (k.section === section) rows.push({ id: k.id, label: k.label, detail: k.key, section });
  }
  return openDialog({ kind: "palette", title: "Commands", rows });
}

const bare = (id: string) => id.replace(/:(chat|agent)$/, "");

export function modelDialog(models: ModelInfo[] | null, current: string): DialogState {
  const list = models ?? [];
  const rows: DialogRow[] = list.map((m) => ({
    id: bare(m.id),
    label: clean(bare(m.id)),
    ...(m.context ? { detail: `${compactNumber(m.context)} context` } : {}),
    current: bare(m.id) === current,
  }));
  let note: string | undefined;
  if (!models) note = "The list of models could not be loaded; /model <id> sends any id as typed.";
  else if (!explicitModelsUsable(list)) note = "Your organisation routes every request: a choice here is answered by its default model.";
  return openDialog({ kind: "model", title: "Models", rows, ...(note ? { note } : {}), footer: "enter switch · type to filter" });
}

export function sessionsDialog(sessions: SessionMeta[], now: Date): DialogState {
  const rows: DialogRow[] = sessions.slice(0, SESSIONS_LISTED).map((s) => ({
    id: s.id,
    label: clean(s.title) || "(untitled)",
    detail: `${ago(s.started, now)} · ${clean(s.model)}`,
  }));
  return openDialog({ kind: "resume", title: "Sessions in this directory", rows, footer: "enter resume · esc keep this one" });
}

export function choiceDialog(command: string, choices: { value: string; detail?: string; current?: boolean }[]): DialogState {
  return openDialog({
    kind: "choice",
    command,
    title: `/${command}`,
    rows: choices.map((c) => ({ id: c.value, label: clean(c.value), ...(c.detail ? { detail: clean(c.detail) } : {}), ...(c.current ? { current: true } : {}) })),
  });
}

export const HELP_KEYS: [string, string][] = [
  ["enter", "send (or run the menu's choice)"],
  ["shift+enter", "new line (also alt+enter, ctrl+j)"],
  ["esc", "stop the turn; again clears a queued message"],
  ["ctrl+c", "stop the turn; at an empty prompt twice to quit"],
  ["ctrl+d", "quit, at an empty prompt"],
  ["ctrl+p", "commands"],
  ["/", "slash commands (tab completes)"],
  ["@", "insert a file's path"],
  ["↑ ↓", "history; in a menu, move"],
  ["pgup pgdn", "scroll the conversation"],
  ["ctrl+alt+u/d", "scroll half a page"],
  ["ctrl+g", "top of the conversation"],
  ["ctrl+alt+g", "newest (also end, at an empty prompt)"],
  ["ctrl+l", "repaint the screen"],
  ["y a n e", "answer an approval (one key, on purpose)"],
];

export function helpDialog(): DialogState {
  const rows: DialogRow[] = [
    ...HELP_KEYS.map(([k, d], i) => ({ id: `k${i}`, label: k, detail: d, section: "Keys" })),
    ...SLASH_COMMANDS.map((c) => ({ id: c.name, label: `/${c.name}${c.hint ? ` ${c.hint}` : ""}`, detail: c.summary, section: "Commands" })),
  ];
  return openDialog({
    kind: "help",
    title: "Help",
    rows,
    readOnly: true,
    twoColumns: ["Keys"],
    footer: "To send a message that starts with /, begin it with a space.",
  });
}

/** Whether a tool can change something: the local writers and command runner, or a Memtro tool marked `ACTION:`. */
export function toolActs(t: Tool): boolean {
  if (t.spec.name === "edit" || t.spec.name === "write" || t.spec.name === "bash") return true;
  return /(^|\n)\s*(-\s*[\w.-]+:\s*)?ACTION:/.test(t.spec.description);
}

export function toolsDialog(tools: Tool[], actions: boolean): DialogState {
  const local = new Set<string>(LOCAL_TOOL_NAMES);
  const row = (t: Tool, section: string): DialogRow => ({
    id: t.spec.name,
    label: clean(t.spec.name),
    detail: clean(t.spec.description.split("\n")[0] ?? "").slice(0, 120),
    section,
    ...(toolActs(t) ? { flag: local.has(t.spec.name) ? "changes files or runs" : "acts" } : {}),
  });
  const rows = [...tools.filter((t) => local.has(t.spec.name)).map((t) => row(t, "On this computer")), ...tools.filter((t) => !local.has(t.spec.name)).map((t) => row(t, "Memtro"))];
  return openDialog({ kind: "tools", title: "Tools", rows, footer: `Actions are ${actions ? "on" : "off"} (/actions on|off).` });
}
