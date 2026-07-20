/**
 * Shared send-with-retry helper.
 *
 * Extracts the per-message retry/backoff that both outbound paths need — the
 * push API (`api.ts`) and the agent reply path (`queue.ts`). Callouts multiply
 * the number of messages emitted per response, so a burst can hit a provider's
 * rate limit; centralizing the backoff keeps the two paths in lockstep instead
 * of duplicating (and drifting) the logic.
 *
 * Pure core: no provider-SDK imports. Callers pass a `send` closure that hides
 * the provider/target details.
 */

import { RateLimitError } from './errors';
import type { OutgoingMessage } from './types';

export interface SendWithRetryOptions {
  /** Total attempts before giving up (default 3). */
  retries?: number;
  /** Invoked with the clamped backoff (ms) each time a rate limit is hit. */
  onRateLimit?: (waitMs: number) => void;
}

/**
 * Attempt `send(msg)` up to `retries` times (default 3).
 *
 * On a caught `RateLimitError` it waits `clamp(err.retryAfterMs, 100, 5000)` ms
 * then retries; the clamp never spins on a zero delay and never ties up the
 * caller for more than a few seconds. On any non-`RateLimitError` it rethrows
 * immediately. If every attempt is exhausted it rethrows the last error, so a
 * caller can translate a final `RateLimitError` into an HTTP 429.
 */
export async function sendWithRetry(
  send: (msg: OutgoingMessage) => Promise<void>,
  msg: OutgoingMessage,
  opts: SendWithRetryOptions = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await send(msg);
      return;
    } catch (err) {
      if (err instanceof RateLimitError) {
        lastError = err;
        const waitMs = Math.min(Math.max(err.retryAfterMs, 100), 5000);
        opts.onRateLimit?.(waitMs);
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }

  // Exhausted all attempts on rate limits; surface the last one so callers can
  // translate it (e.g. HTTP 429 with a Retry-After header).
  throw lastError;
}
