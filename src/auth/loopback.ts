import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { loopbackRedirect } from "./authorize.js";
import { page, PAGE_HEADERS, type PageKind } from "./pages.js";
import { sameSecret } from "./pkce.js";

/**
 * The one-shot listener the browser is redirected back to (RFC 8252 §7.3).
 *
 * Bound to 127.0.0.1 on a port the OS picks, answering exactly one thing: `GET /callback` with the `Host` it was
 * bound as. A `Host` of anything else is refused before the query is even read: a web page that gets a DNS name
 * to resolve to 127.0.0.1 can make the browser send requests here, but it cannot make the browser send this
 * address as their Host, so the check is what stops a page on the internet from probing or feeding the listener.
 *
 * A wrong path or Host is answered and ignored, and the wait goes on: the browser asks for /favicon.ico on its
 * own, and a stray request should not be able to end somebody's sign-in. A `/callback` whose `state` does not
 * match ends it, because that is either a stale tab from an earlier attempt or something forged, and either way
 * the honest move is to stop and say so.
 */

export type CallbackOutcome = { kind: "code"; code: string } | { kind: "denied" } | { kind: "error"; message: string };

export type Classified = { action: "ignore"; status: number; page: PageKind } | { action: "finish"; outcome: CallbackOutcome };

export function classifyCallback(req: { method: string | undefined; url: string | undefined; host: string | undefined }, expected: { host: string; state: string }): Classified {
  if (req.host !== expected.host) return { action: "ignore", status: 400, page: "not-found" };
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${expected.host}`);
  } catch {
    return { action: "ignore", status: 400, page: "not-found" };
  }
  if (url.pathname !== "/callback") return { action: "ignore", status: 404, page: "not-found" };
  if (req.method !== "GET") return { action: "ignore", status: 405, page: "not-found" };

  const state = url.searchParams.get("state");
  if (state === null || !sameSecret(state, expected.state)) {
    return { action: "finish", outcome: { kind: "error", message: "The browser came back with a different sign-in attempt's state (an old tab, or a request this terminal did not start). Nothing was exchanged. Run `memtro login` again." } };
  }
  const error = url.searchParams.get("error");
  if (error === "access_denied") return { action: "finish", outcome: { kind: "denied" } };
  if (error) return { action: "finish", outcome: { kind: "error", message: `Memtro returned an error instead of a code (${error.slice(0, 64)}).` } };
  const code = url.searchParams.get("code");
  if (!code) return { action: "finish", outcome: { kind: "error", message: "The browser came back with neither a code nor an error." } };
  return { action: "finish", outcome: { kind: "code", code } };
}

export type LoopbackResult<T> = { kind: "done"; value: T } | { kind: "denied" } | { kind: "error"; error: Error } | { kind: "timeout" } | { kind: "aborted" };

export interface Loopback<T> {
  port: number;
  redirectUri: string;
  result: Promise<LoopbackResult<T>>;
  /** Stops listening and settles `result` as aborted if it had not settled. Safe to call twice. */
  close(): void;
}

/**
 * Starts the listener. `onCode` runs while the browser waits, so the page it is shown says what actually
 * happened (signed in, or not) rather than "probably fine, check the terminal".
 */
export async function startLoopback<T>(opts: { state: string; timeoutMs: number; onCode: (code: string) => Promise<T>; host?: string }): Promise<Loopback<T>> {
  const bindHost = opts.host ?? "127.0.0.1";
  let settle!: (r: LoopbackResult<T>) => void;
  const result = new Promise<LoopbackResult<T>>((resolve) => (settle = resolve));
  let finished = false;
  let expectedHost = "";

  const send = (res: ServerResponse, status: number, kind: PageKind) => {
    res.writeHead(status, { ...PAGE_HEADERS, Connection: "close" });
    res.end(page(kind));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const verdict = classifyCallback({ method: req.method, url: req.url, host: req.headers.host }, { host: expectedHost, state: opts.state });
    if (verdict.action === "ignore") return send(res, verdict.status, verdict.page);
    if (finished) return send(res, 409, "failed");
    finished = true;
    const outcome = verdict.outcome;
    if (outcome.kind === "denied") {
      send(res, 200, "cancelled");
      return finish({ kind: "denied" });
    }
    if (outcome.kind === "error") {
      send(res, 400, "failed");
      return finish({ kind: "error", error: new Error(outcome.message) });
    }
    opts.onCode(outcome.code).then(
      (value) => {
        send(res, 200, "success");
        finish({ kind: "done", value });
      },
      (err: unknown) => {
        send(res, 200, "failed");
        finish({ kind: "error", error: err instanceof Error ? err : new Error(String(err)) });
      },
    );
  });

  const timer = setTimeout(() => finish({ kind: "timeout" }), opts.timeoutMs);
  timer.unref();

  let closed = false;
  function finish(r: LoopbackResult<T>) {
    clearTimeout(timer);
    settle(r);
    if (closed) return;
    closed = true;
    // Let the response that ended it flush, then stop accepting anything at all.
    setImmediate(() => {
      server.close();
      server.closeAllConnections?.();
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  expectedHost = `${bindHost}:${port}`;

  return {
    port,
    redirectUri: loopbackRedirect(port),
    result,
    close() {
      finished = true;
      finish({ kind: "aborted" });
    },
  };
}
