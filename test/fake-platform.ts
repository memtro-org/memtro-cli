import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable, Writable } from "node:stream";

/**
 * A local stand-in for the Memtro platform, implementing CONTRACT.md's three endpoints and just enough of the
 * existing API (chat completions SSE, /v1/memory, /api/mcp) for the CLI's commands. Nothing here talks to the
 * network beyond 127.0.0.1.
 */

interface Pending {
  challenge: string;
  redirectUri: string;
  expiresAt: number;
  consumed: boolean;
}

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface FakePlatform {
  base: string;
  requests: Recorded[];
  /** How the authorize page answers: approve, deny (Cancel), or show the code (for manual). */
  mode: "approve" | "deny";
  keys: Map<string, { revoked: boolean; id: string }>;
  /** Mint a live key directly, as if a person had made one in the dashboard. */
  mintKey(): string;
  close(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString("base64url");

export async function startFakePlatform(): Promise<FakePlatform> {
  const pending = new Map<string, Pending>(); // keyed by sha256(code)
  const keys = new Map<string, { revoked: boolean; id: string }>();
  const requests: Recorded[] = [];
  const fake = { mode: "approve" } as FakePlatform;

  const mintKey = () => {
    const key = `sk-memtro-${b64url(randomBytes(27))}`;
    keys.set(key, { revoked: false, id: `key_${keys.size + 1}` });
    return key;
  };

  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
    res.end(JSON.stringify(body));
  };
  const authed = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization ?? "";
    const key = h.startsWith("Bearer ") ? h.slice(7) : "";
    const row = keys.get(key);
    return row && !row.revoked ? key : null;
  };
  const unauthorised = (res: ServerResponse) => json(res, 401, { error: { message: "Invalid or revoked API key", type: "invalid_request_error", param: null, code: "invalid_api_key" } });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body });

    // ---- the contract ----
    if (req.method === "GET" && url.pathname === "/cli/authorize") {
      const p = url.searchParams;
      const challenge = p.get("code_challenge") ?? "";
      const redirectUri = p.get("redirect_uri") ?? "";
      const state = p.get("state") ?? "";
      const loopback = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{4,5})\/callback$/.exec(redirectUri);
      const valid =
        /^[A-Za-z0-9_-]{43}$/.test(challenge) &&
        p.get("code_challenge_method") === "S256" &&
        (redirectUri === "manual" || (loopback && Number(loopback[2]) >= 1024 && Number(loopback[2]) <= 65535)) &&
        (redirectUri === "manual" || /^[A-Za-z0-9_-]{1,128}$/.test(state));
      if (!valid) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("invalid authorize request");
      }
      if (fake.mode === "deny") {
        if (redirectUri === "manual") return res.end("Cancelled");
        res.writeHead(303, { Location: `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}` });
        return res.end();
      }
      const code = b64url(randomBytes(32));
      pending.set(createHash("sha256").update(code).digest("hex"), { challenge, redirectUri, expiresAt: Date.now() + 120_000, consumed: false });
      if (redirectUri === "manual") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(code);
      }
      res.writeHead(303, { Location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}` });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/api/cli/token") {
      const b = body as { code?: unknown; code_verifier?: unknown; redirect_uri?: unknown } | null;
      if (!b || typeof b.code !== "string" || typeof b.code_verifier !== "string" || typeof b.redirect_uri !== "string") {
        return json(res, 400, { error: "invalid_request", error_description: "Malformed body." });
      }
      const grant = () => json(res, 400, { error: "invalid_grant", error_description: "The code is invalid or has expired." });
      const row = pending.get(createHash("sha256").update(b.code).digest("hex"));
      // Claimed first, then checked: a wrong verifier burns the code, as the contract says.
      if (!row || row.consumed || row.expiresAt < Date.now()) return grant();
      row.consumed = true;
      if (b64url(createHash("sha256").update(b.code_verifier).digest()) !== row.challenge || b.redirect_uri !== row.redirectUri) return grant();
      const key = mintKey();
      return json(res, 200, {
        api_key: key,
        key_id: keys.get(key)!.id,
        expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
        organisation: { id: "o1", name: "Analytical Engines" },
      });
    }

    if (req.method === "GET" && url.pathname === "/api/cli/whoami") {
      const key = authed(req);
      if (!key) return unauthorised(res);
      return json(res, 200, {
        user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
        organisation: { id: "o1", name: "Analytical Engines" },
        key: { id: keys.get(key)!.id, name: "Memtro CLI (test)", prefix: key.slice(0, 16), expires_at: null, created_at: new Date().toISOString() },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/cli/logout") {
      const key = authed(req);
      if (!key) return unauthorised(res);
      keys.get(key)!.revoked = true;
      return json(res, 200, { revoked: true });
    }

    // ---- existing API ----
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!authed(req)) return unauthorised(res);
      const question = String((body as { messages?: { content?: string }[] })?.messages?.[0]?.content ?? "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const meta = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "fake/model" };
      const frames = [
        `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { content: "Hello, " }, finish_reason: null }] })}\n\n`,
      ];
      if (question.includes("fail")) {
        frames.push(`data: ${JSON.stringify({ error: { message: "provider fell over", type: "server_error" } })}\n\n`);
      } else if (question.includes("cut")) {
        // ends without [DONE]
      } else {
        frames.push(
          `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { content: "wörld" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...meta, choices: [], memtro: { sources: 2 } })}\n\n`,
          `data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          `data: ${JSON.stringify({ ...meta, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
          "data: [DONE]\n\n",
        );
      }
      // Written in awkward pieces, split mid-line and mid-character, to exercise the parser.
      const all = Buffer.from(frames.join(""), "utf8");
      for (let i = 0; i < all.length; i += 7) {
        res.write(all.subarray(i, i + 7));
        await new Promise((r) => setImmediate(r));
      }
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/v1/memory") {
      if (!authed(req)) return unauthorised(res);
      const q = url.searchParams.get("q") ?? "";
      const data =
        q === "nothing"
          ? []
          : [{ object: "memory", id: "m1", content: `Remembered about ${q}`, kind: "fact", scope: "shared", source: "chat", system: null, url: null, trust: "trusted", created_at: "2026-11-01T10:00:00.000Z", superseded_by: null, score: 0.9 }];
      return json(res, 200, { object: "list", data, has_more: false, next_cursor: null, search: { query: q, matched_on: "meaning", as_of: null } });
    }

    if (url.pathname === "/api/mcp") {
      if (!authed(req)) return json(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Invalid or revoked API key" }, id: null }, { "WWW-Authenticate": 'Bearer realm="memtro"' });
      const accept = req.headers.accept ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return json(res, 406, { jsonrpc: "2.0", error: { code: -32000, message: "Not Acceptable" }, id: null });
      const rpc = body as { id: string; method: string; params: { name?: string; arguments?: Record<string, unknown> } };
      if (rpc.method === "tools/list") {
        return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "memtro_remember", description: "Save durable knowledge.\nMore.", inputSchema: { type: "object" } }, { name: "memtro_why", description: "Why code is the way it is" }] } });
      }
      if (rpc.method === "tools/call" && rpc.params.name === "memtro_remember") {
        return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ saved: true, memory_id: "m9", scope: rpc.params.arguments?.scope === "personal" ? "personal" : "shared", entities: 0, replaced: false }) }], isError: false } });
      }
      if (rpc.method === "tools/call") {
        return json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `Tool ${rpc.params.name} not found` }], isError: true } });
      }
      return json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  Object.assign(fake, {
    base: `http://127.0.0.1:${port}`,
    requests,
    keys,
    mintKey,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return fake;
}

/** A writable that remembers what was written, optionally pretending to be a terminal. */
export class Capture extends Writable {
  text = "";
  isTTY: boolean;
  constructor(tty = false) {
    super();
    this.isTTY = tty;
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

export function stdinFrom(text: string | null, tty = false): NodeJS.ReadableStream & { isTTY?: boolean } {
  if (text === null) {
    const s = new PassThrough() as PassThrough & { isTTY?: boolean };
    s.isTTY = tty;
    if (!tty) s.end();
    return s;
  }
  const s = Readable.from([Buffer.from(text)]) as Readable & { isTTY?: boolean };
  s.isTTY = tty;
  return s;
}
