import { RateLimitError } from '../../core/errors';

/**
 * Translate a Bot Framework HTTP 429 into the kernel-level `RateLimitError`.
 * Teams surfaces throttling as a `statusCode === 429` with a `retry-after`
 * header (seconds). We convert to ms so the kernel deals in a single unit.
 *
 * Returns `null` when the error is not a rate-limit; the caller rethrows the
 * original error in that case.
 *
 * This lives in its own SDK-free module (no `botbuilder` import) so it can be
 * unit-tested without pulling the Bot Framework runtime — the adapter
 * re-exports it.
 */
export function toRateLimitError(err: unknown): RateLimitError | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    statusCode?: number;
    retryAfter?: number;
    headers?: Record<string, string | string[] | undefined>;
  };
  if (e.statusCode !== 429) return null;

  let secs = typeof e.retryAfter === 'number' ? e.retryAfter : NaN;
  if (Number.isNaN(secs)) {
    const header = e.headers?.['retry-after'];
    const raw = Array.isArray(header) ? header[0] : header;
    secs = raw != null ? parseInt(String(raw), 10) : NaN;
  }
  if (Number.isNaN(secs) || secs < 1) secs = 1;

  return new RateLimitError(secs * 1000, `Teams rate limited; retry after ${secs}s`);
}
