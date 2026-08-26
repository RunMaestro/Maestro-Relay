import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAmbientBuffer,
  renderTranscript,
  buildAmbientPrompt,
  isSilence,
  SILENCE_SENTINEL,
  type AmbientFlush,
} from '../core/ambient';
import type { IncomingMessage } from '../core/types';

function msg(id: string, author: string, content: string): IncomingMessage {
  return {
    provider: 'discord',
    messageId: id,
    channelId: 'C1',
    authorId: `u-${author}`,
    authorName: author,
    content,
    attachments: [],
    isThread: false,
    raw: undefined,
  } as unknown as IncomingMessage;
}

/** Fake clock so the tests do not sleep. */
function fakeTimers() {
  let seq = 0;
  const scheduled = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  return {
    api: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq;
        scheduled.set(id, { fn, at: now + ms });
        return id as unknown as NodeJS.Timeout;
      },
      clearTimeout: (handle: NodeJS.Timeout) => {
        scheduled.delete(handle as unknown as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...scheduled.entries()]) {
        if (entry.at <= now) {
          scheduled.delete(id);
          entry.fn();
        }
      }
    },
  };
}

test('buffers messages and flushes after the quiet window', () => {
  const clock = fakeTimers();
  const flushes: AmbientFlush[] = [];
  const buf = createAmbientBuffer({
    windowMs: 1000,
    onFlush: (f) => void flushes.push(f),
    timers: clock.api,
  });

  buf.add('C1', {
    authorName: 'Pedram',
    content: 'the ORB result moved',
    message: msg('1', 'Pedram', 'a'),
  });
  buf.add('C1', { authorName: 'Ali', content: 'which cache build', message: msg('2', 'Ali', 'b') });

  clock.advance(500);
  assert.equal(flushes.length, 0, 'must not flush while people are still talking');

  clock.advance(600);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].entries.length, 2, 'both messages land in one batch');
  assert.equal(flushes[0].reason, 'quiet');
  assert.equal(flushes[0].anchor.messageId, '2', 'anchors on the newest message');
});

test('each new message pushes the quiet deadline back', () => {
  const clock = fakeTimers();
  const flushes: AmbientFlush[] = [];
  const buf = createAmbientBuffer({
    windowMs: 1000,
    onFlush: (f) => void flushes.push(f),
    timers: clock.api,
  });

  buf.add('C1', { authorName: 'A', content: 'one', message: msg('1', 'A', 'one') });
  clock.advance(900);
  buf.add('C1', { authorName: 'A', content: 'two', message: msg('2', 'A', 'two') });
  clock.advance(900);
  assert.equal(flushes.length, 0, 'still typing, still quiet-deadline-deferred');

  clock.advance(200);
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].entries.length, 2);
});

test('flushes early once the batch is full', () => {
  const clock = fakeTimers();
  const flushes: AmbientFlush[] = [];
  const buf = createAmbientBuffer({
    windowMs: 100_000,
    maxBatch: 3,
    onFlush: (f) => void flushes.push(f),
    timers: clock.api,
  });

  for (let i = 0; i < 3; i++) {
    buf.add('C1', { authorName: 'A', content: `m${i}`, message: msg(String(i), 'A', `m${i}`) });
  }
  assert.equal(flushes.length, 1, 'does not wait for quiet when the batch is full');
  assert.equal(flushes[0].reason, 'full');
});

test('a relentless conversation is forced out at max wait', () => {
  const clock = fakeTimers();
  const flushes: AmbientFlush[] = [];
  const buf = createAmbientBuffer({
    windowMs: 1000,
    maxBatch: 1000,
    maxWaitMs: 5000,
    onFlush: (f) => void flushes.push(f),
    timers: clock.api,
  });

  // Someone types every 900ms forever: the quiet timer never fires.
  for (let i = 0; i < 10; i++) {
    buf.add('C1', { authorName: 'A', content: `m${i}`, message: msg(String(i), 'A', `m${i}`) });
    clock.advance(900);
  }
  assert.ok(flushes.length >= 1, 'max-wait guarantees the agent eventually sees it');
  assert.equal(flushes[0].reason, 'max-wait');
});

test('channels are buffered independently', () => {
  const clock = fakeTimers();
  const flushes: AmbientFlush[] = [];
  const buf = createAmbientBuffer({
    windowMs: 1000,
    onFlush: (f) => void flushes.push(f),
    timers: clock.api,
  });

  buf.add('C1', { authorName: 'A', content: 'in one', message: msg('1', 'A', 'in one') });
  buf.add('C2', { authorName: 'B', content: 'in two', message: msg('2', 'B', 'in two') });
  clock.advance(1100);

  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes.map((f) => f.channelId).sort(), ['C1', 'C2']);
});

test('discard drops a pending batch without delivering it', () => {
  const clock = fakeTimers();
  const flushes: AmbientFlush[] = [];
  const buf = createAmbientBuffer({
    windowMs: 1000,
    onFlush: (f) => void flushes.push(f),
    timers: clock.api,
  });

  buf.add('C1', { authorName: 'A', content: 'x', message: msg('1', 'A', 'x') });
  assert.equal(buf.pending('C1'), 1);
  buf.discard('C1');
  clock.advance(5000);
  assert.equal(flushes.length, 0, 'turning ambient off must not deliver the leftovers');
});

test('transcript names the speaker on every line', () => {
  const out = renderTranscript([
    { authorName: 'Pedram', content: 'sharpe moved to -2.45', message: msg('1', 'Pedram', '') },
    { authorName: 'Ali', content: 'after the rebuild?', message: msg('2', 'Ali', '') },
  ]);
  assert.equal(out, '[Pedram] sharpe moved to -2.45\n[Ali] after the rebuild?');
});

test('the prompt tells the agent that silence is the default', () => {
  const p = buildAmbientPrompt('[A] hello', 'quantitative trading research');
  assert.match(p, /Staying silent is the normal outcome/);
  assert.ok(p.includes(SILENCE_SENTINEL), 'the sentinel must be stated verbatim');
  assert.match(p, /quantitative trading research/, 'purview is passed through');
});

test('silence is recognised even when the model decorates it', () => {
  assert.equal(isSilence(SILENCE_SENTINEL), true);
  assert.equal(isSilence('  [silence]  '), true);
  assert.equal(isSilence('`[silence]`'), true);
  assert.equal(isSilence('**[silence]**'), true);
  assert.equal(isSilence(''), true);
  assert.equal(isSilence(null), true);
  assert.equal(isSilence('The Sharpe is -2.45 after the rebuild.'), false);
  assert.equal(isSilence('[silence] but actually one thing'), false);
});

test('dispose clears timers so nothing fires afterwards', () => {
  const clock = fakeTimers();
  const flushes: AmbientFlush[] = [];
  const buf = createAmbientBuffer({
    windowMs: 1000,
    onFlush: (f) => void flushes.push(f),
    timers: clock.api,
  });

  buf.add('C1', { authorName: 'A', content: 'x', message: msg('1', 'A', 'x') });
  buf.dispose();
  clock.advance(5000);
  assert.equal(flushes.length, 0);
});
