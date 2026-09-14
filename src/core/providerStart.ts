import type { BridgeProvider, KernelContext, KernelLogger } from './types';

/**
 * Start a provider, and keep trying while its platform is unreachable.
 *
 * A provider that failed to start used to exit the process. launchd restarted
 * it, the next start failed the same way, and a network outage became a crash
 * loop. On 2026-09-14 discord.com timed out for ten hours and the relay ran 82
 * times. The API port closed with every exit, so the doctor saw a dead relay
 * instead of a relay waiting for its network, and paged an agent to fix it.
 *
 * A network failure is now retried inside the process with capped backoff.
 * Any other failure still rejects at once. A bad token does not get better
 * with time, and the caller exits on it exactly as before.
 */

/** Error codes that mean the connection never worked, not that it was refused for cause. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Messages that carry no code. `ws` raises the handshake timeout as a plain
 * Error, and undici's connect timeout is matched by text as well as by code in
 * case a wrapper drops the code.
 */
const NETWORK_ERROR_TEXT = /Connect Timeout Error|Opening handshake has timed out|socket hang up/i;

/** Retry waits in ms. The last step repeats for as long as the outage lasts. */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

/** True when the error means the platform could not be reached at all. */
export function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;
  // undici wraps the socket error in `cause`, so walk a few levels down.
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const { code, name, message, cause } = current as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
    if (name === 'ConnectTimeoutError') return true;
    if (typeof message === 'string' && NETWORK_ERROR_TEXT.test(message)) return true;
    current = cause;
  }
  return false;
}

export interface StartRetryOptions {
  logger: KernelLogger;
  /** Wait before each retry, in ms. The last entry repeats. */
  delaysMs?: number[];
  /** Injected so tests do not wait on a real clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Stop retrying, for example once shutdown has begun. */
  shouldStop?: () => boolean;
}

/**
 * Resolve true once the provider has started, or false if `shouldStop` ended
 * the attempts first. Reject on the first failure that is not a network error.
 */
export async function startProviderWithRetry(
  name: string,
  provider: BridgeProvider,
  ctx: KernelContext,
  opts: StartRetryOptions,
): Promise<boolean> {
  const delays = opts.delaysMs?.length ? opts.delaysMs : DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      await provider.start(ctx);
      if (attempt > 1) {
        opts.logger.info('bridge/startup', `provider "${name}" connected on attempt ${attempt}`);
      }
      return true;
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;

      // The failed attempt left a half-built client behind. Release it before
      // the next attempt builds another one.
      try {
        await provider.stop();
      } catch {
        /* the next start replaces it either way */
      }

      const wait = delays[Math.min(attempt - 1, delays.length - 1)];
      // Keep "failed to start" in the line: the doctor's upstream-unreachable
      // signature reads it. Only the first attempt goes to errors.log, so a long
      // outage does not fill the file with the same line.
      const line =
        `provider "${name}" failed to start (attempt ${attempt}, network unreachable), ` +
        `retrying in ${Math.round(wait / 1000)}s: ${String(err)}`;
      if (attempt === 1) await opts.logger.error('bridge/startup', line);
      else opts.logger.warn('bridge/startup', line);

      if (opts.shouldStop?.()) return false;
      await sleep(wait);
      if (opts.shouldStop?.()) return false;
    }
  }
}

/**
 * Handler for `uncaughtException` that survives one known library fault.
 *
 * When a gateway handshake times out, `@discordjs/ws` destroys the shard and
 * sets `connection.onerror = null` before the socket reports the timeout. The
 * socket then emits `error` with no listener, and Node kills the process. This
 * happened 5 times, including the crash that started the 2026-09-14 loop.
 *
 * Only a network error is absorbed. discord.js reconnects on its own, and a
 * client that never does reports itself not ready on /api/health, which the
 * doctor restarts. Every other uncaught exception still exits non-zero.
 */
export function createLateNetworkErrorHandler(
  logger: KernelLogger,
  exit: (code: number) => void = (code) => process.exit(code),
): (err: unknown) => void {
  return (err) => {
    if (isTransientNetworkError(err)) {
      logger.warn('bridge/network', `ignored a network error from a discarded connection: ${String(err)}`);
      return;
    }
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    void Promise.resolve(logger.error('bridge/fatal', `uncaught exception: ${detail}`)).finally(() =>
      exit(1),
    );
  };
}
