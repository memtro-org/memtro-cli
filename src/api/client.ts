import { CliError, refusedKey, UnavailableError } from "../errors.js";

/**
 * Talking to Memtro, with the three outcomes kept apart that a person (and a script) needs kept apart:
 *
 *   could not reach Memtro      network failure, timeout, 502/503/504      → UnavailableError (exit 4)
 *   Memtro said no              401 → the key was refused (exit 3); other 4xx/5xx → its own message (exit 1)
 *   nothing found               a 200 with nothing in it — the command says so, and exits 0
 *
 * The key goes in the Authorization header and nowhere else. `--verbose` logs method, path, status and time,
 * never headers or bodies, so there is no flag that prints a key.
 */

export interface ClientOptions {
  baseUrl: string;
  key: string | null;
  profile: string;
  /** Where the key came from, so a refusal says which key: MEMTRO_API_KEY is never replaced by signing in. */
  keySource?: "env" | "stored";
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
    const { type, code } = serverCode(text);
    const requestId = res.headers.get("x-request-id");
    const ref = requestId ? ` (request ${requestId})` : "";
    const colon = said ? `: ${said}` : "";
    if (res.status === 401) return refusedKey(this.opts.profile, this.opts.keySource ?? "stored");
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return new UnavailableError(`Memtro is unavailable right now (HTTP ${res.status})${colon}${ref}. Try again shortly.`);
    }
    // brain auth/principal.ts BillingError: the organisation has no usable subscription. Retrying cannot help.
    if (res.status === 402) {
      return new PlatformError(`Your organisation's Memtro subscription is not active (HTTP 402)${colon}${ref}. An administrator can renew it in the Memtro dashboard.`, { status: 402, code: code ?? "subscription_inactive" });
    }
    if (res.status === 429) {
      // brain cost/plan.ts AllowanceExhausted (and the run-hold refusal): a quota, not a rate. Retrying cannot help.
      if (type === "insufficient_quota" || code === "allowance_exhausted") {
        return new PlatformError(`Memtro's usage allowance does not cover this request (HTTP 429${code ? `, ${code}` : ""})${colon}${ref}. Ask an administrator of your organisation to raise the allowance, or try again when it resets.`, { status: 429, code: code ?? type });
      }
      // nginx's limit_req (deploy/nginx.conf), with a non-JSON body: a plain rate limit, which clears by itself.
      return new PlatformError(`Memtro is limiting how fast requests arrive (HTTP 429)${ref}. Wait a moment and try again.`, { status: 429, code, retryable: true, retryAfterMs: retryAfter(res.headers.get("retry-after")) });
    }
    if (res.status === 400 && code === "provider_not_configured") {
      return new PlatformError(`Your organisation has no provider key for that model (HTTP 400)${colon}${ref}. Pick another model (\`/model\` or \`--model\`), or ask an administrator to add the key under Providers in the dashboard.`, { status: 400, code });
    }
    if ((res.status === 400 || res.status === 404) && code === "model_not_found") {
      return new PlatformError(`Memtro does not know that model (HTTP ${res.status})${colon}${ref}. \`/model\` lists the ones your account can use.`, { status: res.status, code });
    }
    if (res.status === 404 && !said) return new CliError(`${this.opts.baseUrl} has no such endpoint (404). Check the base URL, or update the CLI.${ref}`);
    // A 500 is the platform or its provider failing on this attempt; another attempt may well succeed.
    if (res.status >= 500) return new PlatformError(`Memtro failed to answer (HTTP ${res.status})${colon}${ref}`, { status: res.status, code, retryable: true });
    return new PlatformError(`Memtro said no (HTTP ${res.status})${colon}${ref}`, { status: res.status, code });
  }
}

/**
 * Memtro refused or failed, with the status and the platform's error code kept so a caller can decide whether
 * trying again could help. A `CliError` (exit 1), so commands that only print it need nothing new.
 */
export class PlatformError extends CliError {
  readonly status: number;
  readonly code: string | null;
  /** True only where waiting and asking again can succeed: a plain rate limit or a 5xx. Never a quota. */
  readonly retryable: boolean;
  /** From a `Retry-After` header, when there was one. */
  readonly retryAfterMs: number | null;
  constructor(message: string, o: { status: number; code?: string | null; retryable?: boolean; retryAfterMs?: number | null }) {
    super(message);
    this.name = "PlatformError";
    this.status = o.status;
    this.code = o.code ?? null;
    this.retryable = o.retryable ?? false;
    this.retryAfterMs = o.retryAfterMs ?? null;
  }
}

/** `error.type` and `error.code` from OpenAI's error shape, when the body is that. */
export function serverCode(text: string): { type: string | null; code: string | null } {
  try {
    const body = JSON.parse(text) as { error?: { type?: unknown; code?: unknown } };
    const e = body.error && typeof body.error === "object" ? body.error : {};
    return { type: typeof e.type === "string" ? e.type : null, code: typeof e.code === "string" ? e.code : null };
  } catch {
    return { type: null, code: null };
  }
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds; null when absent or unreadable. */
export function retryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\s*\d+\s*$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
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
