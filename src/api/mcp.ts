import { randomUUID } from "node:crypto";
import { CliError, UsageError } from "../errors.js";
import type { ApiClient } from "./client.js";
import { SseParser } from "./sse.js";

/**
 * Memtro's MCP endpoint, spoken directly: one JSON-RPC request per HTTP POST.
 *
 * `/api/mcp` runs the SDK's streamable HTTP transport stateless (`sessionIdGenerator: undefined`,
 * `enableJsonResponse: true`; brain src/app/api/mcp/route.ts), and a fresh server per request. Stateless means
 * the transport skips session validation entirely and nothing gates a request on a prior `initialize`
 * (sdk server/webStandardStreamableHttp.js `validateSession` returns early), so `tools/list` and `tools/call`
 * are sent on their own, with no handshake round trip. What the transport does insist on, per the spec:
 *
 *   Accept: application/json, text/event-stream    both, or 406
 *   Content-Type: application/json                 or 415
 *   MCP-Protocol-Version                           optional; if sent it must be a version the SDK supports
 *
 * The reply is JSON in this configuration. An SSE reply is still read, in case the server is ever switched over.
 */

export const PROTOCOL_VERSION = "2025-06-18";
export const MCP_TIMEOUT_MS = 130_000; // the route's maxDuration is 120s

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpContent {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
  structuredContent?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** `?tools=memory` skips building every connector's tools on the server for calls that only need Memtro's own. */
export type Surface = "all" | "memory";

export async function rpc<T>(client: ApiClient, method: string, params: Record<string, unknown>, surface: Surface = "all"): Promise<T> {
  const id = randomUUID();
  const res = await client.fetch("/api/mcp", {
    method: "POST",
    query: surface === "memory" ? { tools: "memory" } : undefined,
    body: { jsonrpc: "2.0", id, method, params },
    headers: { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL_VERSION },
    timeoutMs: MCP_TIMEOUT_MS,
  });
  const text = await res.text();
  const message = parseRpcBody(text, res.headers.get("content-type") ?? "", id);
  if (!message) throw new CliError(`Memtro's MCP endpoint answered ${method} with nothing this CLI could read.`);
  if (message.error) throw new CliError(`Memtro refused ${method}: ${message.error.message}`);
  return message.result as T;
}

/** The JSON-RPC response for `id`, from a JSON body or an SSE stream of them. Pure. */
export function parseRpcBody(text: string, contentType: string, id: string): JsonRpcResponse | null {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    const parser = new SseParser();
    for (const ev of [...parser.push(text), ...parser.push("\n\n")]) {
      try {
        candidates.push(JSON.parse(ev.data));
      } catch {
        // not a message
      }
    }
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) candidates.push(...parsed);
      else candidates.push(parsed);
    } catch {
      return null;
    }
  }
  const messages = candidates.filter((m): m is JsonRpcResponse => Boolean(m && typeof m === "object" && (m as { jsonrpc?: unknown }).jsonrpc === "2.0"));
  return messages.find((m) => m.id === id) ?? messages.find((m) => m.error && m.id === null) ?? null;
}

export async function listTools(client: ApiClient, surface: Surface = "all"): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  // Bounded: a server that kept handing back cursors would otherwise keep this running for ever.
  for (let page = 0; page < 50; page++) {
    const result = await rpc<{ tools?: McpTool[]; nextCursor?: string }>(client, "tools/list", cursor ? { cursor } : {}, surface);
    tools.push(...(result.tools ?? []));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return tools;
}

export async function callTool(client: ApiClient, name: string, args: Record<string, unknown>, surface: Surface = "all"): Promise<McpCallResult> {
  const result = await rpc<{ content?: McpContent[]; isError?: boolean; structuredContent?: unknown }>(client, "tools/call", { name, arguments: args }, surface);
  return {
    content: Array.isArray(result.content) ? result.content : [],
    isError: Boolean(result.isError),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };
}

/** All text content joined. */
export function resultText(result: McpCallResult): string {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

/** The result's text read as JSON when it is JSON (Memtro's own tools answer that way), otherwise null. */
export function resultJson(result: McpCallResult): unknown {
  const text = resultText(result).trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `--arg key=value` (always a string) and `--arg key:=json` (a number, boolean, array, object, null).
 *
 * Two spellings rather than guessing: `--arg id=123` must stay the string "123" for a tool that wants an id,
 * and `--arg limit:=5` is the number. The same convention HTTPie uses, for the same reason.
 */
export function parseArgPairs(pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`--arg expects key=value or key:=json; got "${pair}".`);
    const raw = pair.slice(0, eq);
    const json = raw.endsWith(":");
    const key = json ? raw.slice(0, -1) : raw;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new UsageError(`"${key}" is not an argument name.`);
    const value = pair.slice(eq + 1);
    if (json) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        throw new UsageError(`--arg ${key}:= needs valid JSON; got ${value}`);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function parseInputJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`--input is not valid JSON (${(err as Error).message}).`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("--input must be a JSON object of the tool's arguments.");
  return parsed as Record<string, unknown>;
}
