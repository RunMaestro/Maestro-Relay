import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWithRetry } from '../core/sendRetry';
import { RateLimitError } from '../core/errors';
import type { OutgoingMessage } from '../core/types';

const MSG: OutgoingMessage = { text: 'hello' };

test('sendWithRetry calls send exactly once when it succeeds first try', async () => {
  let calls = 0;
  await sendWithRetry(async () => {
    calls++;
  }, MSG);
  assert.equal(calls, 1);
});

test('sendWithRetry retries after RateLimitError then resolves, invoking onRateLimit per backoff', async () => {
  let calls = 0;
  const waits: number[] = [];
  await sendWithRetry(
    async () => {
      calls++;
      if (calls <= 2) throw new RateLimitError(5);
    },
    MSG,
    { onRateLimit: (ms) => waits.push(ms) },
  );
  assert.equal(calls, 3);
  // Two rate-limited attempts → two backoffs, each clamped up to the 100ms floor.
  assert.deepEqual(waits, [100, 100]);
});

test('sendWithRetry rejects with a RateLimitError after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    sendWithRetry(
      async () => {
        calls++;
        throw new RateLimitError(5);
      },
      MSG,
      { retries: 2 },
    ),
    (err: unknown) => err instanceof RateLimitError,
  );
  assert.equal(calls, 2);
});

test('sendWithRetry rethrows a non-RateLimitError immediately without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    sendWithRetry(async () => {
      calls++;
      throw new Error('boom');
    }, MSG),
    (err: unknown) => err instanceof Error && err.message === 'boom',
  );
  assert.equal(calls, 1);
});
