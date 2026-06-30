import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { conversationRefsDb } from '../providers/teams/conversationRefsDb';

// Key off a unique conversation id so this test does not collide with other
// tests sharing the kernel DB. Cleaned up after the suite.
const CONV_ID = '__test_teams_refs_19:abc@thread.tacv2';

after(() => {
  conversationRefsDb.remove(CONV_ID);
});

test('upsert then get returns the parsed reference', () => {
  const ref = {
    bot: { id: 'bot-1', name: 'Maestro' },
    conversation: { id: CONV_ID },
    channelId: 'msteams',
  };
  conversationRefsDb.upsert(CONV_ID, ref, 'https://smba.example/teams/', 'tenant-1');

  const got = conversationRefsDb.get(CONV_ID);
  assert.ok(got);
  assert.deepEqual(got.reference, ref);
});

test('upsert again updates the stored reference', () => {
  const first = { conversation: { id: CONV_ID }, channelId: 'msteams', tag: 'first' };
  conversationRefsDb.upsert(CONV_ID, first, 'https://smba.example/teams/', 'tenant-1');

  const second = { conversation: { id: CONV_ID }, channelId: 'msteams', tag: 'second' };
  conversationRefsDb.upsert(CONV_ID, second, 'https://smba.example/v2/', 'tenant-2');

  const got = conversationRefsDb.get(CONV_ID);
  assert.ok(got);
  assert.deepEqual(got.reference, second);
});

test('upsert accepts a null tenant id', () => {
  const ref = { conversation: { id: CONV_ID } };
  assert.doesNotThrow(() => {
    conversationRefsDb.upsert(CONV_ID, ref, 'https://smba.example/teams/', null);
  });
  const got = conversationRefsDb.get(CONV_ID);
  assert.deepEqual(got?.reference, ref);
});

test('remove deletes the reference', () => {
  conversationRefsDb.upsert(
    CONV_ID,
    { conversation: { id: CONV_ID } },
    'https://smba.example/teams/',
    'tenant-1',
  );
  conversationRefsDb.remove(CONV_ID);
  assert.equal(conversationRefsDb.get(CONV_ID), undefined);
});

test('get returns undefined for an unknown conversation id', () => {
  assert.equal(conversationRefsDb.get('__test_teams_refs_does_not_exist'), undefined);
});
