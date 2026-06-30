import test from 'node:test';
import assert from 'node:assert/strict';
import { toRateLimitError } from '../providers/teams/errors';
import { RateLimitError } from '../core/errors';

/**
 * Pure-helper unit tests for the Teams rate-limit translator. `toRateLimitError`
 * lives in the SDK-free `providers/teams/errors` module (re-exported from the
 * adapter), so these never touch the `botbuilder` runtime.
 */

test('toRateLimitError maps a 429 with a retry-after header to RateLimitError (seconds × 1000)', () => {
  const err = { statusCode: 429, headers: { 'retry-after': '5' } };

  const rl = toRateLimitError(err);

  assert.ok(rl instanceof RateLimitError);
  assert.equal(rl.retryAfterMs, 5000);
});

test('toRateLimitError reads a numeric retryAfter property when present', () => {
  const rl = toRateLimitError({ statusCode: 429, retryAfter: 3 });

  assert.ok(rl instanceof RateLimitError);
  assert.equal(rl.retryAfterMs, 3000);
});

test('toRateLimitError handles an array-valued retry-after header', () => {
  const rl = toRateLimitError({ statusCode: 429, headers: { 'retry-after': ['7'] } });

  assert.ok(rl instanceof RateLimitError);
  assert.equal(rl.retryAfterMs, 7000);
});

test('toRateLimitError floors a missing/invalid retry-after to a 1s minimum', () => {
  const noHeader = toRateLimitError({ statusCode: 429 });
  assert.ok(noHeader instanceof RateLimitError);
  assert.equal(noHeader.retryAfterMs, 1000);

  const garbage = toRateLimitError({ statusCode: 429, headers: { 'retry-after': 'nope' } });
  assert.ok(garbage instanceof RateLimitError);
  assert.equal(garbage.retryAfterMs, 1000);
});

test('toRateLimitError returns null for a non-429 error', () => {
  assert.equal(toRateLimitError({ statusCode: 500 }), null);
});

test('toRateLimitError returns null for non-object inputs', () => {
  assert.equal(toRateLimitError(null), null);
  assert.equal(toRateLimitError(undefined), null);
  assert.equal(toRateLimitError('429'), null);
});
