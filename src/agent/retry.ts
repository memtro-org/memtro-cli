import { PlatformError } from "../api/client.js";
import { UnavailableError } from "../errors.js";

/**
 * When a failed step is worth asking for again.
 *
 * Retried: Memtro unreachable or dropped (network, 502/503/504, a stream that went silent or was cut off), a 5xx,
 * and a plain rate limit. Never: a quota or an inactive subscription (waiting will not fix either), any other
 * refusal, an error the platform sent part-way through a stream (it has already tried), and, decided by the
 * caller, anything after output has started, since the person has already seen part of an answer.
 */

export const MAX_RETRIES = 3;
const BASE_MS = 1000;
const CAP_MS = 30_000;

export function retryable(err: unknown): boolean {
  if (err instanceof PlatformError) return err.retryable;
  return err instanceof UnavailableError;
}

/** Exponential with jitter, or what `Retry-After` said (capped). `attempt` counts from 0. */
export function backoffMs(attempt: number, err?: unknown, random: () => number = Math.random): number {
  if (err instanceof PlatformError && err.retryAfterMs !== null) return Math.min(err.retryAfterMs, CAP_MS);
  const ceiling = Math.min(BASE_MS * 2 ** attempt, CAP_MS);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` is aborted. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Interrupted.", "AbortError"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Interrupted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
