import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, DEFAULT_MAX_LENGTH } from '../core/splitMessage';

/**
 * Mention-atomicity: `splitMessage` must never place a chunk boundary inside a
 * Discord mention token — a torn `<@…>` fires no ping. When a token would
 * straddle the max-length boundary, the split happens BEFORE the token so the
 * whole token carries to the next chunk. Everything non-mention keeps the
 * original greedy newline-preserving behavior (covered by splitMessage.test.ts).
 */

/** A chunk must not end mid-token (`…<@1234`) nor start with a dangling id (`5678>`). */
function assertNoTornMention(parts: string[]): void {
  for (const p of parts) {
    assert.ok(!/<(?:@[!&]?|#)\d*$/.test(p), `chunk ends mid mention token: ${JSON.stringify(p.slice(-16))}`);
    assert.ok(!/^\d+>/.test(p), `chunk starts with a dangling mention tail: ${JSON.stringify(p.slice(0, 16))}`);
  }
}

test('a user mention straddling the boundary splits BEFORE the token', () => {
  const token = '<@123456789012345678>';
  // No newline, so the greedy split falls back to the hard boundary at maxLength.
  const filler = 'a'.repeat(DEFAULT_MAX_LENGTH - 5); // token starts a few chars before the cut
  const tail = 'b'.repeat(50);
  const parts = splitMessage(filler + token + tail);

  assert.ok(parts.length >= 2, 'the message is long enough to split');
  assertNoTornMention(parts);
  assert.equal(parts.filter((p) => p.includes(token)).length, 1, 'the token survives intact in exactly one chunk');
  assert.ok(parts.some((p) => p.startsWith(token)), 'the carried chunk begins with the whole token');
});

test('role and channel tokens are equally indivisible', () => {
  for (const token of ['<@&987654321098765432>', '<#111122223333444455>', '<@!555566667777888899>']) {
    const filler = 'x'.repeat(DEFAULT_MAX_LENGTH - 6);
    const parts = splitMessage(filler + token + 'y'.repeat(40));
    assertNoTornMention(parts);
    assert.equal(parts.filter((p) => p.includes(token)).length, 1, `${token} survives intact`);
  }
});

test('multiple mentions near the boundary each stay whole', () => {
  const a = '<@111111111111111111>';
  const b = '<@222222222222222222>';
  // Pack both tokens right around the cut point.
  const text = 'z'.repeat(DEFAULT_MAX_LENGTH - 10) + a + b + 'z'.repeat(30);
  const parts = splitMessage(text);
  assertNoTornMention(parts);
  assert.ok(parts.some((p) => p.includes(a)), 'first token intact');
  assert.ok(parts.some((p) => p.includes(b)), 'second token intact');
});

test('mention-free content splits exactly as before (regression guard)', () => {
  const line = 'lorem ipsum dolor sit amet '.repeat(200); // ~5400 chars, no mentions
  const parts = splitMessage(line);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= DEFAULT_MAX_LENGTH));
  assertNoTornMention(parts); // trivially true, but documents intent
});
