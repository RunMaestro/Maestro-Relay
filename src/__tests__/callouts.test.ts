import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCallouts,
  toOutgoing,
  CALLOUT_META,
  type Segment,
  type CalloutSegment,
  type TextSegment,
} from '../core/callouts';

/**
 * Covers plan §6.1 for the pure callout splitter/composer. `splitCallouts` is a
 * fence-aware line scanner; `toOutgoing` composes segments into OutgoingMessage[]
 * using injected `split`/`renderTables` helpers (kept provider-free).
 */

/** Narrowing helper: assert a segment is a callout and return it. */
function asCallout(seg: Segment): CalloutSegment {
  assert.equal(seg.kind, 'callout', `expected a callout segment, got ${seg.kind}`);
  return seg as CalloutSegment;
}

/** Narrowing helper: assert a segment is text and return it. */
function asText(seg: Segment): TextSegment {
  assert.equal(seg.kind, 'text', `expected a text segment, got ${seg.kind}`);
  return seg as TextSegment;
}

// ---------------------------------------------------------------------------
// splitCallouts
// ---------------------------------------------------------------------------

test('splitCallouts: a single callout yields one callout segment with stripped body', () => {
  const input = ['> [!NOTE]', '> Remember to hydrate.'].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 1);
  const c = asCallout(segs[0]);
  assert.equal(c.variant, 'NOTE');
  assert.equal(c.body, 'Remember to hydrate.', 'body is `>`-stripped, marker dropped');
});

test('splitCallouts: prose → callout → prose gives [text, callout, text] in order', () => {
  const input = [
    'Before the callout.',
    '> [!TIP]',
    '> Use a linter.',
    'After the callout.',
  ].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 3);
  assert.deepEqual(
    segs.map((s) => s.kind),
    ['text', 'callout', 'text'],
  );
  assert.equal(asText(segs[0]).body, 'Before the callout.');
  assert.equal(asCallout(segs[1]).variant, 'TIP');
  assert.equal(asCallout(segs[1]).body, 'Use a linter.');
  assert.equal(asText(segs[2]).body, 'After the callout.');
});

test('splitCallouts: callout at the very start AND very end emits no empty text segments', () => {
  const input = [
    '> [!NOTE]',
    '> First.',
    'middle prose',
    '> [!WARNING]',
    '> Last.',
  ].join('\n');
  const segs = splitCallouts(input);

  assert.deepEqual(
    segs.map((s) => s.kind),
    ['callout', 'text', 'callout'],
  );
  // No segment is an empty text segment.
  assert.ok(!segs.some((s) => s.kind === 'text' && s.body === ''), 'no empty text segments');
});

test('splitCallouts: multiple callouts of different variants each parse', () => {
  // GitHub (and the run-consumption rule) treats a blockquote as continuous:
  // distinct callouts must be separated by a blank line, else they are one run.
  const input = [
    '> [!NOTE]',
    '> n',
    '',
    '> [!TIP]',
    '> t',
    '',
    '> [!IMPORTANT]',
    '> i',
    '',
    '> [!CAUTION]',
    '> c',
  ].join('\n');
  const segs = splitCallouts(input);

  assert.deepEqual(
    segs.map((s) => (s.kind === 'callout' ? s.variant : s.kind)),
    ['NOTE', 'TIP', 'IMPORTANT', 'CAUTION'],
  );
});

test('splitCallouts: multi-line body preserves a bare `>` empty line', () => {
  const input = ['> [!NOTE]', '> line one', '>', '> line three'].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 1);
  const c = asCallout(segs[0]);
  assert.equal(c.body, 'line one\n\nline three', 'bare `>` becomes an empty body line');
});

test('splitCallouts: a `>`-quoted fenced block inside the callout survives in the body', () => {
  const input = [
    '> [!TIP]',
    '> Run:',
    '> ```bash',
    '> echo hi',
    '> ```',
  ].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 1);
  const c = asCallout(segs[0]);
  assert.equal(c.variant, 'TIP');
  assert.equal(c.body, ['Run:', '```bash', 'echo hi', '```'].join('\n'));
});

test('splitCallouts: a top-level fenced block containing a `> [!NOTE]` line stays ONE text segment', () => {
  const input = [
    '```md',
    'Example of a callout:',
    '> [!NOTE]',
    '> not a real callout here',
    '```',
  ].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 1, 'the whole fenced block is a single text segment');
  const t = asText(segs[0]);
  assert.equal(t.body, input, 'fenced content is preserved verbatim, no callout extracted');
});

test('splitCallouts: a plain blockquote with no [!TYPE] stays a single verbatim text segment', () => {
  const input = ['> just a quote', '> second line'].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 1);
  assert.equal(asText(segs[0]).body, input);
});

test('splitCallouts: an unknown tag `> [!FOOBAR]` is treated as text', () => {
  const input = ['> [!FOOBAR]', '> body'].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 1);
  assert.equal(asText(segs[0]).body, input);
});

test('splitCallouts: a marker with trailing prose `> [!NOTE] hi` is NOT an opener', () => {
  const input = ['> [!NOTE] hi', '> more'].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 1);
  assert.equal(asText(segs[0]).body, input, 'GitHub-exact: trailing prose disqualifies the marker');
});

test('splitCallouts: lowercase `> [!note]` is NOT an opener (uppercase-only)', () => {
  const input = ['> [!note]', '> body'].join('\n');
  const segs = splitCallouts(input);

  assert.equal(segs.length, 1);
  assert.equal(asText(segs[0]).kind, 'text');
});

// ---------------------------------------------------------------------------
// CALLOUT_META
// ---------------------------------------------------------------------------

test('CALLOUT_META has an entry for every variant with label/emoji/hex', () => {
  for (const variant of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const) {
    const meta = CALLOUT_META[variant];
    assert.ok(meta, `${variant} present`);
    assert.equal(typeof meta.label, 'string');
    assert.equal(typeof meta.emoji, 'string');
    assert.match(meta.hex, /^#[0-9a-f]{6}$/, `${variant} hex is a 6-digit color`);
  }
});

// ---------------------------------------------------------------------------
// toOutgoing
// ---------------------------------------------------------------------------

const identitySplit = (t: string) => [t];
const identityTables = (t: string) => t;

test('toOutgoing: text segments pass through the injected split and renderTables', () => {
  const calls: { split: string[]; tables: string[] } = { split: [], tables: [] };
  const split = (t: string) => {
    calls.split.push(t);
    return [t];
  };
  const renderTables = (t: string) => {
    calls.tables.push(t);
    return `[T]${t}`;
  };

  const msgs = toOutgoing('plain prose', { split, renderTables });

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '[T]plain prose', 'renderTables applied then split');
  assert.deepEqual(calls.tables, ['plain prose']);
  assert.deepEqual(calls.split, ['[T]plain prose']);
});

test('toOutgoing: a text segment that splits into N chunks yields N messages', () => {
  const split = (t: string) => t.split('|');
  const msgs = toOutgoing('a|b|c', { split, renderTables: identityTables });

  assert.deepEqual(
    msgs.map((m) => m.text),
    ['a', 'b', 'c'],
  );
  assert.ok(msgs.every((m) => m.callout === undefined), 'text messages carry no callout');
});

test('toOutgoing: a callout message carries both the blockquote fallback text AND the callout payload', () => {
  const input = ['> [!WARNING]', '> Danger ahead.'].join('\n');
  const msgs = toOutgoing(input, { split: identitySplit, renderTables: identityTables });

  assert.equal(msgs.length, 1);
  const m = msgs[0];
  assert.equal(m.text, ['> [!WARNING]', '> Danger ahead.'].join('\n'), 'lossless blockquote fallback');
  assert.ok(m.callout, 'callout payload present');
  assert.equal(m.callout!.variant, 'WARNING');
  assert.equal(m.callout!.body, 'Danger ahead.');
});

test('toOutgoing: renderTables is applied to the callout body too (decision #5)', () => {
  const input = ['> [!NOTE]', '> body text'].join('\n');
  const renderTables = (t: string) => `<rt>${t}</rt>`;
  const msgs = toOutgoing(input, { split: identitySplit, renderTables });

  assert.equal(msgs[0].callout!.body, '<rt>body text</rt>', 'callout body passed through renderTables');
});

test('toOutgoing: mention is set on the FIRST message only across mixed segments', () => {
  const input = [
    'intro',
    '> [!TIP]',
    '> a tip',
    'outro',
  ].join('\n');
  // Split the leading text into two chunks so the first message is a text chunk.
  const split = (t: string) => (t === 'intro' ? ['intro-1', 'intro-2'] : [t]);
  const msgs = toOutgoing(input, { split, renderTables: identityTables, mention: true });

  assert.ok(msgs.length >= 3, 'multiple messages produced');
  assert.equal(msgs[0].mention, true, 'first message is mentioned');
  assert.ok(
    msgs.slice(1).every((m) => m.mention !== true),
    'no later message is mentioned',
  );
});

test('toOutgoing: without opts.mention no message is mentioned', () => {
  const msgs = toOutgoing('hello', { split: identitySplit, renderTables: identityTables });
  assert.ok(msgs.every((m) => m.mention !== true));
});

test('toOutgoing: a callout with an empty body reconstructs a lone marker fallback', () => {
  const input = '> [!IMPORTANT]';
  const msgs = toOutgoing(input, { split: identitySplit, renderTables: identityTables });

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '> [!IMPORTANT]', 'empty body → just the marker line');
  assert.equal(msgs[0].callout!.variant, 'IMPORTANT');
  assert.equal(msgs[0].callout!.body, '');
});
