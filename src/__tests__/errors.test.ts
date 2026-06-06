import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentNotFoundError, RateLimitError } from '../core/errors';
import { toRateLimitError as discordToRateLimit } from '../providers/discord/adapter';
import { toRateLimitError as slackToRateLimit } from '../providers/slack/adapter';

test('RateLimitError carries retryAfterMs', () => {
  const err = new RateLimitError(2500, 'test');
  assert.equal(err.name, 'RateLimitError');
  assert.equal(err.retryAfterMs, 2500);
  assert.equal(err.message, 'test');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof RateLimitError);
});

test('RateLimitError has a default message when context is omitted', () => {
  const err = new RateLimitError(500);
  assert.match(err.message, /Rate limited; retry after 500ms/);
});

test('AgentNotFoundError carries the agentId', () => {
  const err = new AgentNotFoundError('agent-7');
  assert.equal(err.name, 'AgentNotFoundError');
  assert.equal(err.agentId, 'agent-7');
  assert.match(err.message, /Agent not found: agent-7/);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof AgentNotFoundError);
});

test('RateLimitError is distinguishable from AgentNotFoundError', () => {
  const rl = new RateLimitError(1000);
  const nf = new AgentNotFoundError('x');
  assert.ok(!(rl instanceof AgentNotFoundError));
  assert.ok(!(nf instanceof RateLimitError));
});

test('discord toRateLimitError maps status=429 with no retryAfter to a 1s backoff', () => {
  const err = Object.assign(new Error('rate limited'), { status: 429 });
  const result = discordToRateLimit(err);
  assert.ok(result instanceof RateLimitError);
  assert.equal(result!.retryAfterMs, 1000);
});

test('discord toRateLimitError preserves the platform retryAfter (ms)', () => {
  const err = Object.assign(new Error('rate limited'), {
    status: 429,
    retryAfter: 4321,
  });
  const result = discordToRateLimit(err);
  assert.ok(result instanceof RateLimitError);
  assert.equal(result!.retryAfterMs, 4321);
});

test('discord toRateLimitError returns null for unrelated errors', () => {
  assert.equal(discordToRateLimit(new Error('boom')), null);
  assert.equal(discordToRateLimit(null), null);
  assert.equal(discordToRateLimit(undefined), null);
  assert.equal(discordToRateLimit('string'), null);
});

test('slack toRateLimitError converts seconds to ms', () => {
  const err = Object.assign(new Error('rate limited'), {
    code: 'slack_webapi_rate_limited_error',
    retryAfter: 30,
  });
  const result = slackToRateLimit(err);
  assert.ok(result instanceof RateLimitError);
  assert.equal(result!.retryAfterMs, 30000);
});

test('slack toRateLimitError ignores non-rate-limit errors', () => {
  const platform = Object.assign(new Error('channel_not_found'), {
    code: 'slack_webapi_platform_error',
    data: { error: 'channel_not_found' },
  });
  assert.equal(slackToRateLimit(platform), null);
  assert.equal(slackToRateLimit(new Error('network down')), null);
});
