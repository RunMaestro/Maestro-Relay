import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferContextStrategy,
  selectContextWindow,
  DEFAULT_RECENT_TURNS,
  type ContextWindowStrategy,
  type TranscriptEntryLike,
} from '../core/room/contextWindow';

// A room transcript entry: the `source` discriminant plus the payload the bus
// renders. Only `source` matters to the heuristics; the rest rides along.
interface Entry extends TranscriptEntryLike {
  source: 'human' | 'bot' | 'tool';
  text: string;
}

const human = (text: string): Entry => ({ source: 'human', text });
const bot = (text: string): Entry => ({ source: 'bot', text });
const tool = (text: string): Entry => ({ source: 'tool', text });

// ---------------------------------------------------------------------------
// inferContextStrategy — every hint class
// ---------------------------------------------------------------------------

test('inferContextStrategy: explicit "last N messages" → recent-messages', () => {
  assert.deepEqual(inferContextStrategy('catch up on the last 5 messages'), {
    kind: 'recent-messages',
    messages: 5,
  });
  // singular unit is accepted too
  assert.deepEqual(inferContextStrategy('read the last 1 message'), {
    kind: 'recent-messages',
    messages: 1,
  });
});

test('inferContextStrategy: explicit "last N turns"/"exchanges" → recent-turns', () => {
  assert.deepEqual(inferContextStrategy('summarize the last 3 turns'), {
    kind: 'recent-turns',
    turns: 3,
  });
  assert.deepEqual(inferContextStrategy('the last 2 exchanges please'), {
    kind: 'recent-turns',
    turns: 2,
  });
});

test('inferContextStrategy: unit-less "share the last N" → recent-messages', () => {
  assert.deepEqual(inferContextStrategy('share the last 10'), {
    kind: 'recent-messages',
    messages: 10,
  });
  // the "the" is optional
  assert.deepEqual(inferContextStrategy('share last 4 with them'), {
    kind: 'recent-messages',
    messages: 4,
  });
});

test('inferContextStrategy: soft "recent" hints → recent-turns default window', () => {
  const expected: ContextWindowStrategy = {
    kind: 'recent-turns',
    turns: DEFAULT_RECENT_TURNS,
  };
  assert.deepEqual(inferContextStrategy('pull them in on this'), expected);
  assert.deepEqual(inferContextStrategy('loop them in on this thread'), expected);
  assert.deepEqual(inferContextStrategy('give the most recent context'), expected);
  assert.deepEqual(inferContextStrategy('weigh in on this topic'), expected);
});

test('inferContextStrategy: no hint → full transcript', () => {
  assert.deepEqual(inferContextStrategy('hey Ada, what do you think?'), { kind: 'full' });
  assert.deepEqual(inferContextStrategy(''), { kind: 'full' });
});

test('inferContextStrategy: "most recent <non-conversational noun>" does NOT force a window', () => {
  // The noun is code/work, not conversation — a newly invited bot should get the
  // full room history, not a tail. (Bare "most recent" used to match too broadly.)
  assert.deepEqual(inferContextStrategy('what changed in the most recent commit?'), {
    kind: 'full',
  });
  assert.deepEqual(inferContextStrategy('most recent commit'), { kind: 'full' });
  assert.deepEqual(inferContextStrategy('rerun the most recent test'), { kind: 'full' });
});

test('inferContextStrategy: unit-less "share the last N" with a competing noun → full', () => {
  // "commits"/"files" are not conversational units, so a unit-less share must not
  // clamp the window — fall back to the full transcript.
  assert.deepEqual(inferContextStrategy('share the last 2 commits'), { kind: 'full' });
  assert.deepEqual(inferContextStrategy('share the last 2 files'), { kind: 'full' });
  // …but the genuinely unit-less forms still resolve to messages (regression guard).
  assert.deepEqual(inferContextStrategy('share the last 10'), {
    kind: 'recent-messages',
    messages: 10,
  });
  assert.deepEqual(inferContextStrategy('share last 4 with them'), {
    kind: 'recent-messages',
    messages: 4,
  });
});

test('inferContextStrategy: an explicit count wins over a soft hint', () => {
  // "this thread" (soft) co-occurs with an explicit unit count; the count wins.
  assert.deepEqual(inferContextStrategy('in this thread, take the last 2 messages'), {
    kind: 'recent-messages',
    messages: 2,
  });
});

test('inferContextStrategy: a @handle token cannot masquerade as a hint', () => {
  // The stripped handle leaves prose that carries no hint → full.
  assert.deepEqual(inferContextStrategy('@last-5-bot say hi'), { kind: 'full' });
  // …but a real hint next to a handle still fires.
  assert.deepEqual(inferContextStrategy('@Ada read the last 3 messages'), {
    kind: 'recent-messages',
    messages: 3,
  });
});

test('inferContextStrategy: a zero/invalid count falls through, not a 0-window', () => {
  assert.deepEqual(inferContextStrategy('the last 0 messages'), { kind: 'full' });
});

// ---------------------------------------------------------------------------
// selectContextWindow — full / recent-messages / recent-turns / coherence / few
// ---------------------------------------------------------------------------

test('selectContextWindow: full → a shallow clone of every entry (not the input ref)', () => {
  const logs = [human('a'), bot('b'), human('c')];
  const out = selectContextWindow(logs, { kind: 'full' });
  assert.deepEqual(out, logs);
  assert.notEqual(out, logs, 'must be a copy so callers cannot mutate the source store');
});

test('selectContextWindow: recent-messages → last N conversational entries', () => {
  const logs = [human('a'), bot('b'), human('c'), bot('d')];
  const out = selectContextWindow(logs, { kind: 'recent-messages', messages: 2 });
  assert.deepEqual(
    out.map((e) => (e as Entry).text),
    ['c', 'd'],
  );
});

test('selectContextWindow: recent-turns → last N pairs (2*N conversational entries)', () => {
  const logs = [human('a'), bot('b'), human('c'), bot('d'), human('e'), bot('f')];
  // 2 turns == the last 4 conversational entries.
  const out = selectContextWindow(logs, { kind: 'recent-turns', turns: 2 });
  assert.deepEqual(
    out.map((e) => (e as Entry).text),
    ['c', 'd', 'e', 'f'],
  );
});

test('selectContextWindow: coherence — interleaved tool entries inside the window are kept', () => {
  // Only human/bot entries are counted; a tool entry inside the bounding range
  // rides along, but a tool entry OUTSIDE the range (leading) is dropped.
  const logs = [
    tool('setup'), // outside the 2-message window → dropped
    human('a'), // counted (2nd from the end of conversational)
    tool('lookup'), // inside range → kept for coherence
    bot('b'), // counted (last conversational)
  ];
  const out = selectContextWindow(logs, { kind: 'recent-messages', messages: 2 });
  assert.deepEqual(
    out.map((e) => (e as Entry).text),
    ['a', 'lookup', 'b'],
  );
  // A leading tool entry is not counted and not included.
  assert.ok(!out.some((e) => (e as Entry).text === 'setup'));
});

test('selectContextWindow: fewer conversational entries than N → whole transcript', () => {
  const logs = [tool('x'), human('a'), tool('y'), bot('b')];
  const out = selectContextWindow(logs, { kind: 'recent-messages', messages: 10 });
  assert.deepEqual(out, logs);
  assert.notEqual(out, logs, 'still a copy');
});

test('selectContextWindow: recent-turns also honors the fewer-than-N fallback', () => {
  const logs = [human('a'), bot('b')]; // 1 turn available, 5 requested
  const out = selectContextWindow(logs, { kind: 'recent-turns', turns: 5 });
  assert.deepEqual(
    out.map((e) => (e as Entry).text),
    ['a', 'b'],
  );
});

test('selectContextWindow: a non-positive count yields an empty window', () => {
  const logs = [human('a'), bot('b')];
  assert.deepEqual(selectContextWindow(logs, { kind: 'recent-messages', messages: 0 }), []);
});
