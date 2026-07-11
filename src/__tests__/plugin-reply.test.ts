import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAgentReply } from '../plugin/reply';
import { ManualScheduler, createFakeSdk, flush } from './plugin-helpers';

/**
 * The reply path (design-critical). `agents.dispatch` returns only a sessionId;
 * the reply is read back by polling `transcripts.read`. These tests pin the
 * contract that the loop was built against Maestro host 1.12.0:
 *   - dispatch is issued once with the prompt, and the sessionId anchors polling;
 *   - `transcripts.read`'s INCLUSIVE `timestamp >= since` filter re-returns the
 *     boundary row, so entries are deduped by id (never double-posted);
 *   - completion arrives via the `agent.completed` signal (markComplete), an
 *     idle-grace fallback, or a hard timeout.
 * Time is driven by a manual scheduler, so nothing depends on the wall clock.
 */

test('dispatches the prompt once and collects the reply on completion', async () => {
  const { sdk, calls } = createFakeSdk({
    dispatchSessionId: 'S1',
    read: () => [{ id: 'e1', type: 'assistant', timestamp: 100, fullResponse: 'Hello there' }],
  });
  const scheduler = new ManualScheduler();
  const chunks: string[] = [];
  const handle = collectAgentReply(
    sdk,
    { agentId: 'agent-1', prompt: 'hi', idleGraceMs: 10_000, timeoutMs: 60_000 },
    { onChunk: (text) => chunks.push(text) },
    scheduler,
  );

  await flush();
  assert.deepEqual(calls.dispatched, [{ agentId: 'agent-1', prompt: 'hi' }]);
  assert.equal(calls.reads[0]?.sessionId, 'S1');
  assert.ok(calls.reads[0]?.fields.includes('fullResponse'), 'requests fullResponse');
  assert.equal(calls.reads[0]?.since, 0, 'first poll reads from the start');

  handle.markComplete();
  const result = await handle.promise;
  assert.equal(result.reason, 'event');
  assert.equal(result.text, 'Hello there');
  assert.deepEqual(chunks, ['Hello there'], 'the reply is emitted exactly once');
});

test('dedupes the inclusive-since boundary row and finishes on idle grace', async () => {
  const { sdk, calls } = createFakeSdk({
    dispatchSessionId: 'S2',
    read: () => [{ id: 'e1', timestamp: 5, fullResponse: 'Only once' }],
  });
  const scheduler = new ManualScheduler();
  const handle = collectAgentReply(
    sdk,
    { agentId: 'a', prompt: 'p', idleGraceMs: 50, timeoutMs: 10_000 },
    {},
    scheduler,
  );

  await flush();
  scheduler.time = 50; // advance the clock past the idle grace window
  await scheduler.fire(); // second poll re-returns the same row (deduped), then idles out

  const result = await handle.promise;
  assert.equal(result.reason, 'idle');
  assert.equal(result.text, 'Only once');
  assert.equal(result.chunks.length, 1, 'the re-returned boundary row is not double-counted');
  assert.ok(calls.reads.length >= 2, 'polled more than once');
});

test('resolves with reason timeout when the agent never replies', async () => {
  const { sdk } = createFakeSdk({ dispatchSessionId: 'S3', read: () => [] });
  const scheduler = new ManualScheduler();
  const handle = collectAgentReply(
    sdk,
    { agentId: 'a', prompt: 'p', idleGraceMs: 30, timeoutMs: 40 },
    {},
    scheduler,
  );

  await flush();
  scheduler.time = 40;
  await scheduler.fire();

  const result = await handle.promise;
  assert.equal(result.reason, 'timeout');
  assert.equal(result.text, '');
});

test('accumulates multiple reply chunks across polls, in order', async () => {
  const rowsByCall = [
    [{ id: 'e1', timestamp: 1, fullResponse: 'A' }],
    [
      { id: 'e1', timestamp: 1, fullResponse: 'A' },
      { id: 'e2', timestamp: 2, fullResponse: 'B' },
    ],
  ];
  const { sdk } = createFakeSdk({
    dispatchSessionId: 'S4',
    read: (_call, index) => rowsByCall[Math.min(index, rowsByCall.length - 1)],
  });
  const scheduler = new ManualScheduler();
  const chunks: string[] = [];
  const handle = collectAgentReply(
    sdk,
    { agentId: 'a', prompt: 'p', idleGraceMs: 100, timeoutMs: 10_000 },
    { onChunk: (text) => chunks.push(text) },
    scheduler,
  );

  await flush(); // first poll -> 'A'
  await scheduler.fire(); // second poll -> 'B'
  handle.markComplete();

  const result = await handle.promise;
  assert.deepEqual(chunks, ['A', 'B']);
  assert.equal(result.text, 'AB');
});
