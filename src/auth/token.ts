import { CliError, UnavailableError } from "../errors.js";
import { looksLikeKey } from "../store/types.js";

/**
 * The code-for-key exchange: `POST {base}/api/cli/token`, no credentials, per the contract.
 *
 * Every refusal is `400 invalid_grant` with one deliberately indistinguishable description (unknown, expired,
 * used, wrong verifier, wrong redirect), so this does not pretend to know which; it says what the person can do.
 */

export interface TokenResponse {
  api_key: string;
  key_id: string;
  expires_at: string | null;
  user: { id: string; name: string | null; email: string | null };
  organisation: { id: string; name: string | null };
}

export async function exchangeCode(
  base: string,
  body: { code: string; codeVerifier: string; redirectUri: string },
  opts: { userAgent: string; timeoutMs?: number; fetch?: typeof fetch },
): Promise<TokenResponse> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}/api/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": opts.userAgent },
      body: JSON.stringify({ code: body.code, code_verifier: body.codeVerifier, redirect_uri: body.redirectUri }),
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new UnavailableError(`Could not reach Memtro at ${base} to finish signing in (${reason(err)}). Nothing was stored.`);
  }

  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 400 && parsed?.error === "invalid_grant") {
    throw new CliError("Memtro refused the sign-in code: it had expired, had already been used, or did not match this terminal. Codes last two minutes. Run `memtro login` again.");
  }
  // Beyond this point nothing from the body is printed: a response from something that is not the contract's
  // endpoint (a proxy, a misconfigured host) could echo the code or carry anything else.
  if (res.status === 400) {
    throw new CliError(`Memtro rejected the sign-in request as malformed${parsed?.error === "invalid_request" ? " (invalid_request)" : ""}. This is a bug in the CLI or the platform; please report it.`);
  }
  if (res.status === 404) throw new CliError(`${base} does not offer CLI sign-in (404 on /api/cli/token). Check the base URL, or create a key in the dashboard and set MEMTRO_API_KEY.`);
  // 503 temporarily_unavailable: the platform could not reach its database. Retryable, unlike invalid_grant.
  if (res.status === 503 || res.status === 502 || res.status === 504) throw new UnavailableError(`Memtro is temporarily unavailable and could not finish the sign-in (HTTP ${res.status}). Nothing was stored; run \`memtro login\` again in a moment.`);
  if (!res.ok) throw new CliError(`Memtro answered the sign-in with HTTP ${res.status}. Nothing was stored.`);

  if (!parsed || typeof parsed.api_key !== "string" || !looksLikeKey(parsed.api_key)) {
    throw new CliError("Memtro answered the sign-in without a usable key. Nothing was stored.");
  }
  const user = (parsed.user ?? {}) as Record<string, unknown>;
  const org = (parsed.organisation ?? {}) as Record<string, unknown>;
  return {
    api_key: parsed.api_key,
    key_id: typeof parsed.key_id === "string" ? parsed.key_id : "",
    expires_at: typeof parsed.expires_at === "string" ? parsed.expires_at : null,
    user: { id: String(user.id ?? ""), name: typeof user.name === "string" ? user.name : null, email: typeof user.email === "string" ? user.email : null },
    organisation: { id: String(org.id ?? ""), name: typeof org.name === "string" ? org.name : null },
  };
}

function reason(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "timed out";
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
  return cause ?? (err instanceof Error ? err.message : String(err));
}
