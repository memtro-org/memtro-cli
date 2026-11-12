import type { Risk, Tool, ToolResult } from "../agent/types.js";
import type { ApiClient } from "../api/client.js";
import { callTool, listTools, resultText, type McpTool, type Surface } from "../api/mcp.js";
import { LOCAL_TOOL_NAMES } from "./names.js";
import { capText } from "./truncate.js";
import { describe as describeValue } from "./validate.js";

/**
 * Memtro's own tools (memory, and each connected system) as harness tools, from `/api/mcp` `tools/list`.
 *
 * One `Tool` per entry, under Memtro's real name and with its schema passed through, executed with `tools/call`
 * on the same surface it was listed from: `shape=system` (a connected system is ONE tool taking
 * `{operation, input}`; brain src/lib/tools/consolidate.ts) and `actions=none` unless the person turned actions
 * on, so with actions off the server never offers a tool that changes anything (brain selection.ts).
 *
 * Names: nothing is prefixed, so the model sees the names Memtro's own prompt and instructions use. A remote tool
 * whose name equals a local one (`read`, `bash`, …) is DROPPED, silently, because the local tool must win and the
 * signature has no channel for a notice; Memtro's names are `memtro_*` or a connector kind (`github`, `xero`),
 * none of which is a local tool's name today.
 *
 * Risk: the server sends no MCP annotations (brain src/app/api/mcp/route.ts registers each tool with only a
 * description and an input schema). What it does send is the marker the platform itself uses to tell an action
 * from a read: a description beginning `ACTION:` (brain security/gates.ts `ACTION_PREFIX`, connectors/risk.ts
 * `tierOf`, and the `?actions=none` filter in tools/index.ts). A folded system tool lists each operation as
 * `- name: <its description, cut to 110 chars>`, so the marker survives per operation. Memtro's own writes do
 * not carry it; they are the platform's persistence list (security/gates.ts `PERSISTENCE_TOOLS`), mirrored here.
 * So: annotations when sent; else `remote-act` for an `ACTION:` tool or operation, a persistence tool, or any
 * operation of a system tool that cannot be found in its listing; `remote-read` otherwise.
 */

/** brain src/lib/security/gates.ts PERSISTENCE_TOOLS (plus the two agent-mode tools that start work elsewhere). */
const MEMTRO_WRITES = new Set([
  "memtro_remember",
  "memtro_schedule_job",
  "memtro_schedule_once",
  "memtro_update_job",
  "memtro_record_commitment",
  "memtro_update_commitment",
  "memtro_raise_contradiction",
  "memtro_answer_contradiction",
  "memtro_define_term",
  "memtro_update_term",
  "memtro_define_measure",
  "memtro_update_measure",
  "memtro_record_procedure",
  "memtro_update_procedure",
  "memtro_artifact",
  "memtro_delegate",
  "memtro_run_script",
]);
/** A `memtro_*` tool added after this list was written is judged by its verb. */
const WRITE_VERB = /^memtro_(remember|schedule|update|record|raise|answer|define|delete|forget|create|set|add|remove|send|post|share|artifact|delegate|run)/;

const ACTION = /^\s*ACTION:/;
const GROUP_MARKER = "Run one operation on this connected system.";

export async function loadMemtroTools(client: ApiClient, opts: { actions: boolean }): Promise<Tool[]> {
  const surface = memtroSurface(opts);
  const listed = await listTools(client, surface);
  const seen = new Set<string>(LOCAL_TOOL_NAMES);
  const tools: Tool[] = [];
  for (const t of listed) {
    if (!t || typeof t.name !== "string" || !t.name || seen.has(t.name)) continue;
    seen.add(t.name);
    tools.push(memtroTool(client, t, surface));
  }
  return tools;
}

export function memtroSurface(opts: { actions: boolean }): Surface {
  return opts.actions ? { shape: "system" } : { shape: "system", actions: false };
}

/** The operations a folded system tool lists, by short name, with the line describing each. Pure. */
export function groupOperations(t: McpTool): Map<string, string> | null {
  const description = t.description ?? "";
  const props = (t.inputSchema?.properties ?? {}) as Record<string, unknown>;
  if (!description.includes(GROUP_MARKER) && !("operation" in props && "input" in props)) return null;
  const ops = new Map<string, string>();
  for (const m of description.matchAll(/^- ([^:\s]+): ?(.*)$/gm)) ops.set(m[1]!, m[2]!);
  return ops;
}

export function riskOf(t: McpTool, args: Record<string, unknown>): Risk {
  const a = t.annotations;
  if (a?.readOnlyHint === true && a.destructiveHint !== true) return "remote-read";
  if (a?.readOnlyHint === false || a?.destructiveHint === true) return "remote-act";
  if (ACTION.test(t.description ?? "")) return "remote-act";
  if (t.name.startsWith("memtro_")) return MEMTRO_WRITES.has(t.name) || WRITE_VERB.test(t.name) ? "remote-act" : "remote-read";
  const ops = groupOperations(t);
  if (!ops) return "remote-read";
  const op = typeof args.operation === "string" ? args.operation : "";
  if (op === "describe") return "remote-read";
  const short = op.startsWith(`${t.name}_`) ? op.slice(t.name.length + 1) : op;
  const line = ops.get(short);
  if (line === undefined) return "remote-act"; // not in the listing: cannot be shown to be a read
  return ACTION.test(line) ? "remote-act" : "remote-read";
}

const label = (kind: string) => (kind ? kind[0]!.toUpperCase() + kind.slice(1) : kind);

const MEMTRO_TITLES: Record<string, string> = {
  memtro_search: "Search memory",
  memtro_remember: "Save to memory",
  memtro_why: "Ask memory why",
  memtro_timeline: "Read the memory timeline",
  memtro_explore: "Explore memory",
  memtro_transcripts: "Search transcripts",
  memtro_measures: "Read the measure register",
  memtro_values: "Read recorded values",
};

/** The first short string argument worth quoting in a title (a query, a question, a path). */
function gist(args: Record<string, unknown>): string | null {
  for (const key of ["query", "question", "q", "content", "text", "path", "name", "title"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) {
      const one = v.replace(/\s+/g, " ").trim();
      return one.length > 60 ? `${one.slice(0, 59)}…` : one;
    }
  }
  return null;
}

export function titleOf(t: McpTool, args: Record<string, unknown>): string {
  if (t.name.startsWith("memtro_")) {
    const base = MEMTRO_TITLES[t.name] ?? `Memtro: ${t.name.slice("memtro_".length).replace(/_/g, " ")}`;
    const g = gist(args);
    return g ? `${base}: "${g}"` : base;
  }
  if (groupOperations(t)) {
    const op = typeof args.operation === "string" ? args.operation : "?";
    const input = (args.input && typeof args.input === "object" ? args.input : {}) as Record<string, unknown>;
    if (op === "describe") return `Ask ${label(t.name)}: describe ${typeof input.operation === "string" ? input.operation : "an operation"}`;
    const g = gist(input);
    return `Ask ${label(t.name)}: ${op}${g ? ` "${g}"` : ""}`;
  }
  const at = t.name.indexOf("_");
  return at > 0 ? `Ask ${label(t.name.slice(0, at))}: ${t.name.slice(at + 1).replace(/_/g, " ")}` : `Ask ${label(t.name)}`;
}

const JSON_TYPES: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/** The checks a model's arguments can fail before Memtro is asked: an object, required fields, top-level types, an enum. */
export function validateAgainst(schema: Record<string, unknown> | undefined, raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Arguments must be a JSON object." };
  const args = raw as Record<string, unknown>;
  const props = (schema?.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema?.required) ? (schema!.required as unknown[]).filter((k): k is string => typeof k === "string") : [];
  for (const key of required) if (args[key] === undefined) return { ok: false, error: `"${key}" is required.` };
  for (const [key, value] of Object.entries(args)) {
    const p = props[key];
    if (!p || value === undefined) continue;
    const types = (Array.isArray(p.type) ? p.type : typeof p.type === "string" ? [p.type] : []) as string[];
    if (types.length && !types.some((ty) => JSON_TYPES[ty]?.(value) ?? true)) return { ok: false, error: `"${key}" must be ${types.join(" or ")}, not ${describeValue(value)}.` };
    if (Array.isArray(p.enum) && !p.enum.includes(value)) return { ok: false, error: `"${key}" must be one of: ${p.enum.map((e) => JSON.stringify(e)).join(", ")}.` };
  }
  return { ok: true, args };
}

export function memtroTool(client: ApiClient, t: McpTool, surface: Surface): Tool {
  const parameters = t.inputSchema && typeof t.inputSchema === "object" ? { type: "object", ...t.inputSchema } : { type: "object", properties: {} };
  return {
    spec: { name: t.name, description: t.description ?? t.name, parameters },
    validate: (raw) => validateAgainst(t.inputSchema, raw),
    risk: (args) => {
      try {
        return riskOf(t, args);
      } catch {
        return "remote-act";
      }
    },
    summarise: (args) => ({ title: titleOf(t, args) }),
    async run(args, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return { content: "Interrupted before Memtro was asked; nothing ran.", isError: true };
      try {
        const result = await callTool(client, t.name, args, surface, { signal: ctx.signal });
        const text = resultText(result);
        const other = result.content.filter((c) => c.type !== "text").length;
        const body = (text || (result.isError ? "Memtro reported an error with no message." : "(Memtro returned no text.)")) + (other ? `\n[${other} non-text part${other === 1 ? "" : "s"} of the result not shown.]` : "");
        return { content: capText(body, "Ask for less: a narrower query, a filter, or a smaller limit."), ...(result.isError ? { isError: true } : {}) };
      } catch (err) {
        if (ctx.signal.aborted) return { content: "Interrupted while waiting for Memtro; whether the call ran there is not known.", isError: true };
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}
