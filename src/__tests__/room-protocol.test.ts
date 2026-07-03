import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type Participant,
  parseMentions,
  renderNativeMentions,
  resolveBotUserId,
  buildPreamble,
  sanitizeHandle,
} from '../core/room/protocol';

// A small fixed roster the addressing tests share. Handles are the addressable
// identity; botUserId is the resolved bot account id used to fire a native ping.
const ada: Participant = { agentId: 'a-ada', handle: 'Ada', botUserId: '111' };
const bo: Participant = { agentId: 'a-bo', handle: 'Bo', botUserId: '222' };
const cy: Participant = { agentId: 'a-cy', handle: 'Cy', botUserId: '333' };
const roster: Participant[] = [ada, bo, cy];

// --- sanitizeHandle ---------------------------------------------------------

test('sanitizeHandle keeps safe chars, strips reserved substrings, never empty', () => {
  assert.equal(sanitizeHandle('Ada Lovelace!'), 'AdaLovelace');
  assert.equal(sanitizeHandle('discord-clyde-bot'), '--bot'); // both reserved words excised, hyphens kept
  assert.equal(sanitizeHandle('   '), 'agent');
  assert.equal(sanitizeHandle('###'), 'agent');
});

// --- resolveBotUserId -------------------------------------------------------

test('resolveBotUserId maps a handle (with or without @) to its bound bot id', () => {
  assert.equal(resolveBotUserId('Ada', roster), '111');
  assert.equal(resolveBotUserId('@Bo', roster), '222');
  assert.equal(resolveBotUserId('ADA', roster), '111'); // case-insensitive
  assert.equal(resolveBotUserId('nobody', roster), null); // unregistered
});

test('resolveBotUserId returns null when the participant has no bound bot id', () => {
  const unbound: Participant[] = [{ agentId: 'a-x', handle: 'Xy' }];
  assert.equal(resolveBotUserId('Xy', unbound), null);
});

// --- renderNativeMentions: round-trip invariant -----------------------------

test('renderNativeMentions rewrites exactly the handles parseMentions would target', () => {
  const text = 'Hey @Ada and @Bo, ping @Cy?';
  const self = ada; // Ada is speaking; she must never be rewritten
  const opts = { self, maxMentions: 3 };

  const parsed = parseMentions(text, roster, opts);
  const rendered = renderNativeMentions(text, roster, opts);

  // Every parser target's native id appears in the output...
  for (const target of parsed.targets) {
    assert.ok(
      rendered.includes(`<@${target.botUserId}>`),
      `expected native mention for @${target.handle}`,
    );
    // ...and its literal @Handle no longer does.
    assert.ok(
      !rendered.includes(`@${target.handle}`),
      `@${target.handle} should have been rewritten`,
    );
  }

  // Self (@Ada isn't in this text, but assert the invariant with a self mention).
  const selfText = 'I, @Ada, will ask @Bo.';
  const selfRendered = renderNativeMentions(selfText, roster, { self, maxMentions: 3 });
  assert.ok(selfRendered.includes('@Ada'), 'self handle must be left literal');
  assert.ok(!selfRendered.includes('<@111>'), 'self must never be rewritten to a native ping');
  assert.ok(selfRendered.includes('<@222>'), 'the addressed peer is still rewritten');
});

test('renderNativeMentions never rewrites the self handle', () => {
  const text = '@Bo take a look, said @Ada.';
  const rendered = renderNativeMentions(text, roster, { self: ada });
  assert.ok(rendered.includes('@Ada'), 'self stays literal');
  assert.ok(!rendered.includes('<@111>'), 'no native ping for self');
  assert.ok(rendered.includes('<@222>'), 'peer Bo is pinged');
});

// --- renderNativeMentions: maxMentions cap ----------------------------------

test('renderNativeMentions honors maxMentions for explicit handles', () => {
  const text = 'ping @Ada @Bo @Cy';
  // Cap at 2, no self → only the first two addressed handles are rewritten.
  const rendered = renderNativeMentions(text, roster, { maxMentions: 2 });
  assert.ok(rendered.includes('<@111>'), 'first target rewritten');
  assert.ok(rendered.includes('<@222>'), 'second target rewritten');
  assert.ok(rendered.includes('@Cy'), 'third target over the cap stays literal');
  assert.ok(!rendered.includes('<@333>'), 'over-cap handle not pinged');
});

test('renderNativeMentions @all respects maxMentions and excludes self', () => {
  const rendered = renderNativeMentions('everyone: @all', roster, {
    self: ada,
    maxMentions: 2,
  });
  // Non-self participants are Bo (222) and Cy (333); cap is 2, so both appear;
  // Ada (self) is excluded.
  assert.ok(rendered.includes('<@222>'), 'Bo included in @all');
  assert.ok(rendered.includes('<@333>'), 'Cy included in @all');
  assert.ok(!rendered.includes('<@111>'), 'self (Ada) excluded from @all');
  assert.ok(!rendered.includes('@all'), '@all token consumed');
});

test('renderNativeMentions @all caps the fan-out at maxMentions', () => {
  const rendered = renderNativeMentions('@all', roster, { maxMentions: 1 });
  // Only the first non-self participant (Ada, 111) is expanded.
  assert.ok(rendered.includes('<@111>'), 'first participant expanded');
  const nativeCount = (rendered.match(/<@\d+>/g) ?? []).length;
  assert.equal(nativeCount, 1, 'exactly one native mention under the cap');
});

// --- renderNativeMentions: @human -------------------------------------------

test('renderNativeMentions expands @human to the configured id, literal if unset', () => {
  const withId = renderNativeMentions('back to you @human', roster, {
    humanMentionId: '999',
  });
  assert.ok(withId.includes('<@999>'), '@human → configured human mention id');
  assert.ok(!withId.includes('@human'), '@human token consumed');

  const withoutId = renderNativeMentions('back to you @human', roster, {});
  assert.ok(withoutId.includes('@human'), '@human stays literal when unconfigured');
  assert.ok(!withoutId.includes('<@'), 'no native ping emitted without a human id');
});

// --- renderNativeMentions: unknown tokens -----------------------------------

test('renderNativeMentions leaves unknown @tokens as literal prose', () => {
  const text = 'check the @nightly build and @deploy pipeline';
  const rendered = renderNativeMentions(text, roster, {});
  assert.equal(rendered, text, 'no registered handle → unchanged');
  assert.ok(!rendered.includes('<@'), 'no native mentions emitted');
});

test('renderNativeMentions output uses real <@id> syntax, not literal @Handle', () => {
  const rendered = renderNativeMentions('@Ada @Bo', roster, {});
  assert.match(rendered, /<@111>/, 'contains native id for Ada');
  assert.match(rendered, /<@222>/, 'contains native id for Bo');
  assert.doesNotMatch(rendered, /@Ada|@Bo/, 'no literal handles remain');
});

// --- buildPreamble ----------------------------------------------------------

test('buildPreamble lists peers by @Handle excluding self', () => {
  const preamble = buildPreamble({ name: 'Design Room' }, ada, roster);
  assert.match(preamble, /You are @Ada in room "Design Room"/);
  assert.match(preamble, /@Bo/);
  assert.match(preamble, /@Cy/);
  assert.doesNotMatch(preamble, /Other participants:.*@Ada/, 'self not listed as a peer');
});

test('buildPreamble shows (none yet) when there are no peers', () => {
  const preamble = buildPreamble({ roomKey: 'p:c' }, ada, [ada]);
  assert.match(preamble, /\(none yet\)/);
});
