import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyCompaction } from "./compaction.js";
import type { Message, SessionMeta, SessionStore } from "./types.js";

/**
 * Sessions as JSON lines, one file per session, under `${XDG_STATE_HOME:-~/.local/state}/memtro/sessions/`
 * (`%LOCALAPPDATA%\memtro\sessions` on Windows). The files hold file contents and command output, so the
 * directory is 0700 and each file 0600.
 *
 * Line 1 is `{"type":"session", ...meta}`; then `{"type":"message","message":…}` and
 * `{"type":"compaction","summary":…,"keptFrom":n}` in the order they happened. Each line goes down in one
 * append, so a process killed mid-write leaves at worst one torn last line: `load` skips it, and the next append
 * starts on a fresh line so the torn one cannot swallow it.
 */

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEADER_READ_BYTES = 64 * 1024;

export function sessionsDir(opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "memtro", "sessions");
  const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : join(home, ".local", "state");
  return join(state, "memtro", "sessions");
}

type Line = ({ type: "session" } & SessionMeta) | { type: "message"; message: Message } | { type: "compaction"; summary: string; keptFrom: number };

export function openSessionStore(opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {}): SessionStore {
  const dir = sessionsDir(opts);
  const windows = (opts.platform ?? process.platform) === "win32";
  /** Files this process has checked end on a newline. */
  const healed = new Set<string>();

  const fileFor = (id: string): string => {
    if (!ID.test(id)) throw new Error(`Not a session id: ${JSON.stringify(id)}`);
    return join(dir, `${id}.jsonl`);
  };

  const ensureDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!windows) chmodSync(dir, 0o700);
  };

  const append = (id: string, line: Line, create = false) => {
    const file = fileFor(id);
    ensureDir();
    if (!create && !existsSync(file)) throw new Error(`No session ${id} to append to.`);
    const fd = openSync(file, create ? "wx" : "a", 0o600);
    try {
      if (!windows && create) chmodSync(file, 0o600);
      let prefix = "";
      if (!create && !healed.has(file)) {
        // A torn last line from an earlier crash would otherwise run into this one and take it down with it.
        const size = fstatSync(fd).size;
        if (size > 0) {
          const last = Buffer.alloc(1);
          const rfd = openSync(file, "r");
          try {
            readSync(rfd, last, 0, 1, size - 1);
          } finally {
            closeSync(rfd);
          }
          if (last[0] !== 0x0a) prefix = "\n";
        }
        healed.add(file);
      }
      writeSync(fd, `${prefix}${JSON.stringify(line)}\n`);
    } finally {
      closeSync(fd);
    }
    if (create) healed.add(file);
  };

  const readHeader = (file: string): SessionMeta | null => {
    try {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(HEADER_READ_BYTES);
        const n = readSync(fd, buf, 0, buf.length, 0);
        const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
        return toMeta(JSON.parse(first));
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  };

  return {
    create(meta) {
      append(meta.id, { type: "session", ...meta }, true);
    },
    appendMessage(id, message) {
      append(id, { type: "message", message });
    },
    appendCompaction(id, summary, keptFrom) {
      append(id, { type: "compaction", summary, keptFrom });
    },
    list(cwd) {
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
      } catch {
        return [];
      }
      const found: { meta: SessionMeta; mtime: number }[] = [];
      for (const name of names) {
        const file = join(dir, name);
        const meta = readHeader(file);
        if (!meta || meta.cwd !== cwd || `${meta.id}.jsonl` !== name) continue;
        let mtime = 0;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        found.push({ meta, mtime });
      }
      // Newest by last activity, so `--continue` picks up the session last worked in.
      return found.sort((a, b) => b.mtime - a.mtime || b.meta.started.localeCompare(a.meta.started)).map((f) => f.meta);
    },
    load(id) {
      if (!ID.test(id)) return null;
      let text: string;
      try {
        text = readFileSync(fileFor(id), "utf8");
      } catch {
        return null;
      }
      const lines = text.split("\n");
      const meta = (() => {
        try {
          return toMeta(JSON.parse(lines[0] ?? ""));
        } catch {
          return null;
        }
      })();
      if (!meta) return null;
      let messages: Message[] = [];
      for (const raw of lines.slice(1)) {
        if (!raw.trim()) continue;
        let line: Line;
        try {
          line = JSON.parse(raw) as Line;
        } catch {
          // A torn line (the last, after a crash): what came before it is intact.
          continue;
        }
        if (line.type === "message" && isMessage(line.message)) messages.push(line.message);
        else if (line.type === "compaction" && typeof line.summary === "string" && Number.isInteger(line.keptFrom)) {
          messages = applyCompaction(messages, line.summary, line.keptFrom);
        }
      }
      return { meta, messages: answerDangling(messages) };
    },
  };
}

export const LOST_RESULT = "Not known: the session ended (the program was stopped or crashed) before this call's result was saved. It may have run; check before relying on it.";

/**
 * A conversation the platform will take: every assistant tool call answered by one tool message straight after it.
 * A process killed while a call was running leaves the call unanswered on disk; loading supplies the missing
 * result (saying so) and drops a tool message that answers nothing, so `--continue` never sends a broken history.
 */
export function answerDangling(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") continue; // taken with its assistant message below; an orphan is dropped
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const results = new Map<string, Message>();
    let j = i + 1;
    for (; j < messages.length && messages[j]!.role === "tool"; j++) {
      const t = messages[j] as Extract<Message, { role: "tool" }>;
      if (!results.has(t.tool_call_id)) results.set(t.tool_call_id, t);
    }
    for (const c of m.tool_calls) out.push(results.get(c.id) ?? { role: "tool", tool_call_id: c.id, content: LOST_RESULT });
    i = j - 1;
  }
  return out;
}

function toMeta(v: unknown): SessionMeta | null {
  const o = v as Partial<SessionMeta> & { type?: unknown };
  if (!o || o.type !== "session" || typeof o.id !== "string" || typeof o.cwd !== "string") return null;
  return { id: o.id, cwd: o.cwd, started: String(o.started ?? ""), model: String(o.model ?? ""), title: String(o.title ?? "") };
}

function isMessage(m: unknown): m is Message {
  const o = m as { role?: unknown; content?: unknown; tool_call_id?: unknown } | null;
  if (!o || typeof o !== "object") return false;
  if (o.role === "user" || o.role === "system") return typeof o.content === "string";
  if (o.role === "assistant") return typeof o.content === "string" || o.content === null;
  if (o.role === "tool") return typeof o.tool_call_id === "string" && typeof o.content === "string";
  return false;
}
