/**
 * SusFactor prompt screening (0din.ai).
 *
 * Optional, off-by-default guard that scores every inbound prompt for
 * prompt-injection intent before it reaches an agent. Provider-agnostic: the
 * queue composes the final prompt, calls `screen()`, and acts on the decision.
 *
 * Auth is two-step. A long-lived API token is exchanged at
 * `POST /api/v1/access_tokens` for a short-lived JWT (15 min at time of
 * writing). The JWT is cached, refreshed shortly before expiry, and refreshed
 * once more on an unexpected 401.
 */

export type SusFactorMode = 'off' | 'log' | 'flag' | 'block';

/** Raw scoring result from `POST /api/v1/sus`. */
export interface SusVerdict {
  score: number;
  isSuspicious: boolean;
  label: string;
  model: string;
  /** The threshold reported alongside the score. */
  threshold: number;
  /**
   * Whether suspicion was decided by a locally configured `SUSFACTOR_THRESHOLD`
   * (`score >= threshold` holds) or by the server's own `is_suspicious` flag
   * (in which case `threshold` is only the server's echoed value and the
   * comparison may well be false). Callers rendering a reason must not claim
   * the comparison unless this is `'local'`.
   */
  thresholdSource: 'local' | 'server';
  timingMs: number;
  /** True when the prompt was longer than `maxChars` and was head/tail sampled. */
  sampled: boolean;
}

export type SusDecision =
  /** Forward the prompt unchanged. */
  | { action: 'allow'; verdict?: SusVerdict; error?: string }
  /**
   * Forward the prompt, but warn the agent and the channel. `verdict` is absent
   * when the flag came from a fail-closed screening error rather than a score.
   */
  | { action: 'flag'; verdict?: SusVerdict; error?: string }
  /** Do not forward. `verdict` is absent when the block came from a fail-closed error. */
  | { action: 'block'; verdict?: SusVerdict; error?: string };

export interface SusFactorOptions {
  mode: SusFactorMode;
  /** 0din API token (the value behind "View API Token"). Required unless mode is 'off'. */
  apiToken: string;
  /**
   * Local score threshold in [0,1]. When set, `score >= threshold` decides
   * suspicion instead of the server's own `is_suspicious` flag.
   */
  threshold?: number;
  /** Per-request timeout for both the token exchange and the scoring call. */
  timeoutMs?: number;
  /**
   * On API error or timeout: true forwards the prompt unchanged. False refuses
   * to forward it *in `block` mode* — in `log` and `flag` the failure is
   * degraded to that mode's own strongest action (forward, and forward with a
   * banner) rather than escalated to a block the operator never asked for.
   * Default true.
   */
  failOpen?: boolean;
  /** Prompts longer than this are head/tail sampled down to it before scoring. */
  maxChars?: number;
  tokenUrl?: string;
  susUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; must return epoch milliseconds. */
  now?: () => number;
}

export interface SusFactorScreener {
  readonly mode: SusFactorMode;
  readonly enabled: boolean;
  /** Score `text` and apply the configured policy. Never throws. */
  screen(text: string): Promise<SusDecision>;
}

const DEFAULT_TOKEN_URL = 'https://0din.ai/api/v1/access_tokens';
const DEFAULT_SUS_URL = 'https://defense.0din.ai/api/v1/sus';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_CHARS = 8000;
/** Refresh the JWT this far ahead of its stated expiry. */
const EXPIRY_SKEW_MS = 60_000;
const SAMPLE_MARKER = '\n\n[... middle of prompt omitted for screening ...]\n\n';
/**
 * Smallest `maxChars` at which `sampleForScreening` will spend budget on the
 * elision marker. Below this the marker would be most of the sample.
 */
const MIN_MARKER_BUDGET = SAMPLE_MARKER.length * 2;

class SusFactorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SusFactorError';
  }
}

/**
 * Reduce an oversized prompt to `maxChars` by keeping its head and its tail.
 * Truncating from the front alone would let an attacker pad past the limit and
 * hide the payload in the tail; keeping both ends closes that.
 */
export function sampleForScreening(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // The marker only earns its place when real text still dominates the sample.
  // At a budget barely above the marker's own length the result is a couple of
  // characters of user text wrapped in a ~52-char constant, which scores as
  // benign every time and silently disables screening. Requiring twice the
  // marker length makes this function safe for any caller, not just the one
  // behind MIN_SUSFACTOR_MAX_CHARS in config.ts.
  if (maxChars < MIN_MARKER_BUDGET) {
    const head = Math.ceil(maxChars / 2);
    return text.slice(0, head) + text.slice(text.length - (maxChars - head));
  }
  const budget = maxChars - SAMPLE_MARKER.length;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return text.slice(0, head) + SAMPLE_MARKER + (tail > 0 ? text.slice(text.length - tail) : '');
}

export function createSusFactor(options: SusFactorOptions): SusFactorScreener {
  const mode = options.mode;

  if (mode === 'off') {
    return {
      mode,
      enabled: false,
      async screen(): Promise<SusDecision> {
        return { action: 'allow' };
      },
    };
  }

  if (!options.apiToken) {
    throw new Error(
      `SUSFACTOR_MODE is "${mode}" but SUSFACTOR_API_TOKEN is not set. ` +
        `Set the token, or set SUSFACTOR_MODE=off to disable prompt screening.`,
    );
  }

  if (options.threshold !== undefined && !(options.threshold >= 0 && options.threshold <= 1)) {
    throw new Error(
      `SUSFACTOR_THRESHOLD must be a number between 0 and 1 (got "${options.threshold}").`,
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failOpen = options.failOpen ?? true;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const tokenUrl = options.tokenUrl ?? DEFAULT_TOKEN_URL;
  const susUrl = options.susUrl ?? DEFAULT_SUS_URL;

  let cached: { token: string; expiresAt: number } | null = null;
  /** In-flight exchange, so concurrent conversations share one token request. */
  let inFlight: Promise<string> | null = null;

  async function exchangeToken(): Promise<string> {
    const res = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { Authorization: options.apiToken },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new SusFactorError(`token exchange failed: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { token?: string; expires_in?: number };
    if (!body?.token) {
      throw new SusFactorError('token exchange returned no token');
    }
    const ttlMs = (typeof body.expires_in === 'number' ? body.expires_in : 900) * 1000;
    cached = { token: body.token, expiresAt: now() + ttlMs };
    return body.token;
  }

  async function getToken(force = false): Promise<string> {
    if (force) cached = null;
    if (cached && now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached.token;
    if (!inFlight) {
      inFlight = exchangeToken().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function scoreOnce(prompt: string, jwt: string): Promise<Response> {
    return doFetch(susUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function score(text: string): Promise<SusVerdict> {
    const sampled = text.length > maxChars;
    const prompt = sampled ? sampleForScreening(text, maxChars) : text;

    let jwt = await getToken();
    let res = await scoreOnce(prompt, jwt);
    if (res.status === 401) {
      // Cached JWT was rejected (rotated or revoked early) — re-exchange once.
      jwt = await getToken(true);
      res = await scoreOnce(prompt, jwt);
    }
    if (!res.ok) {
      throw new SusFactorError(`scoring failed: HTTP ${res.status}`, res.status);
    }

    const body = (await res.json()) as {
      is_suspicious?: boolean;
      score?: number;
      label?: string;
      model?: string;
      threshold?: number;
      timing_ms?: number;
    };
    if (typeof body?.score !== 'number') {
      throw new SusFactorError('scoring returned no score');
    }

    const serverThreshold = typeof body.threshold === 'number' ? body.threshold : 0.5;
    const isSuspicious =
      options.threshold !== undefined
        ? body.score >= options.threshold
        : body.is_suspicious === true;

    return {
      score: body.score,
      isSuspicious,
      label: body.label ?? (isSuspicious ? 'suspicious' : 'safe'),
      model: body.model ?? 'unknown',
      threshold: options.threshold ?? serverThreshold,
      thresholdSource: options.threshold !== undefined ? 'local' : 'server',
      timingMs: typeof body.timing_ms === 'number' ? body.timing_ms : 0,
      sampled,
    };
  }

  return {
    mode,
    enabled: true,
    async screen(text: string): Promise<SusDecision> {
      // Nothing to score: an attachment-only or empty message can't carry an injection.
      if (!text.trim()) return { action: 'allow' };

      let verdict: SusVerdict;
      try {
        verdict = await score(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (failOpen) return { action: 'allow', error: message };
        // Fail-closed means "do not silently forward unscreened", not "enforce
        // a policy the operator did not select". `log` is documented as never
        // enforcing, so an outage must not start dropping messages just because
        // SUSFACTOR_FAIL_OPEN=false; `flag` degrades to its own action, which
        // is forwarding with the untrusted-input banner. Only `block` blocks.
        switch (mode) {
          case 'log':
            return { action: 'allow', error: message };
          case 'flag':
            return { action: 'flag', error: message };
          case 'block':
            return { action: 'block', error: message };
        }
      }

      if (!verdict.isSuspicious) return { action: 'allow', verdict };

      switch (mode) {
        case 'log':
          return { action: 'allow', verdict };
        case 'flag':
          return { action: 'flag', verdict };
        case 'block':
          return { action: 'block', verdict };
      }
    },
  };
}
