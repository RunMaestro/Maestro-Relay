/**
 * Provider-agnostic bridge errors.
 *
 * Adapters must translate platform-specific error shapes (Discord's
 * `DiscordAPIError` / `@discordjs/rest` `RateLimitError`, Slack's
 * `WebAPIRateLimitedError`, etc.) into these classes so the kernel
 * can react without leaking platform types.
 */

/**
 * The chat platform asked us to slow down. The kernel uses
 * `retryAfterMs` to schedule a backoff before retrying; adapters
 * convert their platform's unit (Discord returns ms, Slack returns
 * seconds) into a single milliseconds value here.
 */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, context?: string) {
    super(context ?? `Rate limited; retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The requested agent does not exist in the maestro registry.
 * The kernel surfaces this to API callers as 404.
 */
export class AgentNotFoundError extends Error {
  readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = 'AgentNotFoundError';
    this.agentId = agentId;
  }
}
