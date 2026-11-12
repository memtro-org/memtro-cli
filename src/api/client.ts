import { CliError, refusedKey, UnavailableError } from "../errors.js";

/**
 * Talking to Memtro, with the three outcomes kept apart that a person (and a script) needs kept apart:
 *
 *   could not reach Memtro      network failure, timeout, 502/503/504      → UnavailableError (exit 4)
 *   Memtro said no              401 → "run memtro login" (exit 3); other 4xx/5xx → its own message (exit 1)
 *   nothing found               a 200 with nothing in it — the command says so, and exits 0
 *
 * The key goes in the Authorization header and nowhere else. `--verbose` logs method, path, status and time,
 * never headers or bodies, so there is no flag that prints a key.
 */

export interface ClientOptions {
  baseUrl: string;
  key: string | null;
  profile: string;
  userAgent: string;
  /** Called with one line per request when --verbose is on. */
  log?: (line: string) => void;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Whole-request timeout. Streaming requests pass their own signal instead. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Send without the key (the token exchange). */
  anonymous?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

export class ApiClient {
  constructor(readonly opts: ClientOptions) {}

  url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.opts.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return url.toString();
  }

  /** The raw response for a 2xx; every other status is turned into the right error here. */
  async fetch(path: string, o: RequestOptions = {}): Promise<Response> {
    const method = o.method ?? (o.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { "User-Agent": this.opts.userAgent, Accept: "application/json", ...o.headers };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (!o.anonymous && this.opts.key) headers.Authorization = `Bearer ${this.opts.key}`;
    const signal = o.signal ?? AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(this.url(path, o.query), {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        // A redirect would carry the Authorization header to wherever it pointed. Memtro's API never redirects.
        redirect: "error",
        signal,
      });
    } catch (err) {
      this.opts.log?.(`${method} ${path} failed after ${Date.now() - started}ms`);
      throw new UnavailableError(`Could not reach Memtro at ${this.opts.baseUrl} (${networkReason(err)}).`);
    }
    this.opts.log?.(`${method} ${path} → ${res.status} in ${Date.now() - started}ms${res.headers.get("x-request-id") ? ` (request ${res.headers.get("x-request-id")})` : ""}`);
    if (res.ok) return res;
    throw await this.errorFor(res);
  }

  async json<T = unknown>(path: string, o: RequestOptions = {}): Promise<T> {
    const res = await this.fetch(path, o);
    try {
      return (await res.json()) as T;
    } catch {
      throw new CliError(`Memtro answered ${path} with something that is not JSON.`);
    }
  }

  async errorFor(res: Response): Promise<CliError> {
    const text = await res.text().catch(() => "");
    const said = serverMessage(text);
    const requestId = res.headers.get("x-request-id");
    const ref = requestId ? ` (request ${requestId})` : "";
    if (res.status === 401) return refusedKey(this.opts.profile);
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return new UnavailableError(`Memtro is unavailable right now (HTTP ${res.status})${said ? `: ${said}` : ""}${ref}. Try again shortly.`);
    }
    if (res.status === 404 && !said) return new CliError(`${this.opts.baseUrl} has no such endpoint (404). Check the base URL, or update the CLI.${ref}`);
    return new CliError(`Memtro said no (HTTP ${res.status})${said ? `: ${said}` : ""}${ref}`);
  }
}

/** The message from any of the error shapes Memtro uses: OpenAI's, JSON-RPC's, or a bare `{ error: "…" }`. */
export function serverMessage(text: string): string | null {
  if (!text) return null;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; error_description?: unknown };
    if (body.error && typeof body.error === "object" && typeof (body.error as { message?: unknown }).message === "string") return clip((body.error as { message: string }).message);
    if (typeof body.error_description === "string") return clip(body.error_description);
    if (typeof body.error === "string") return clip(body.error);
    if (typeof body.message === "string") return clip(body.message);
    return null;
  } catch {
    // An HTML error page from a proxy is not worth printing.
    return /^\s*</.test(text) ? null : clip(text);
  }
}

const clip = (s: string): string => (s.length > 500 ? `${s.slice(0, 499)}…` : s).trim();

export function networkReason(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timed out";
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the host name did not resolve";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code) return code;
  return cause?.message ?? (err instanceof Error ? err.message : String(err));
}
