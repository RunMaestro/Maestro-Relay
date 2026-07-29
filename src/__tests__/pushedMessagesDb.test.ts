import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../core/db';
import {
  PUSHED_MESSAGE_RETENTION_DAYS,
  pushedMessagesDb,
} from '../providers/discord/pushedMessagesDb';

let testId = 0;
function uid(prefix: string) {
  testId++;
  return `${prefix}-test-${testId}-${Date.now()}`;
}

const created: string[] = [];
function track(id: string) {
  created.push(id);
  return id;
}

afterEach(() => {
  for (const id of created) {
    try {
      db.prepare('DELETE FROM discord_pushed_messages WHERE message_id = ?').run(id);
    } catch {
      /* ignore */
    }
  }
  created.length = 0;
});

/** Backdate a row so retention can be exercised without waiting 30 days. */
function ageRow(messageId: string, days: number) {
  db.prepare('UPDATE discord_pushed_messages SET created_at = ? WHERE message_id = ?').run(
    Math.floor(Date.now() / 1000) - days * 24 * 60 * 60,
    messageId,
  );
}

test('pushedMessagesDb.record and get round-trip', () => {
  const msgId = track(uid('msg'));
  const chId = uid('ch');

  pushedMessagesDb.record(msgId, chId, 'agent-1', 'session-1');
  const row = pushedMessagesDb.get(msgId);

  assert.ok(row);
  assert.equal(row.message_id, msgId);
  assert.equal(row.channel_id, chId);
  assert.equal(row.agent_id, 'agent-1');
  assert.equal(row.session_id, 'session-1');
  assert.equal(typeof row.created_at, 'number');
});

test('pushedMessagesDb.record defaults session_id to null', () => {
  const msgId = track(uid('msg'));
  pushedMessagesDb.record(msgId, uid('ch'), 'agent-1');
  assert.equal(pushedMessagesDb.get(msgId)!.session_id, null);
});

test('pushedMessagesDb.record re-recording the same message id overwrites the binding', () => {
  const msgId = track(uid('msg'));
  pushedMessagesDb.record(msgId, 'ch-a', 'agent-a', 'session-a');
  pushedMessagesDb.record(msgId, 'ch-b', 'agent-b', 'session-b');

  const row = pushedMessagesDb.get(msgId)!;
  assert.equal(row.agent_id, 'agent-b');
  assert.equal(row.session_id, 'session-b');
});

test('pushedMessagesDb.get returns undefined for an unknown message', () => {
  assert.equal(pushedMessagesDb.get('no-such-message'), undefined);
});

test('pushedMessagesDb.purgeOlderThan drops aged rows and keeps fresh ones', () => {
  const oldId = track(uid('msg-old'));
  const freshId = track(uid('msg-fresh'));
  pushedMessagesDb.record(oldId, uid('ch'), 'agent-1', 'session-1');
  pushedMessagesDb.record(freshId, uid('ch'), 'agent-1', 'session-1');
  ageRow(oldId, PUSHED_MESSAGE_RETENTION_DAYS + 1);

  const removed = pushedMessagesDb.purgeOlderThan(PUSHED_MESSAGE_RETENTION_DAYS);

  assert.ok(removed >= 1);
  assert.equal(pushedMessagesDb.get(oldId), undefined);
  assert.ok(pushedMessagesDb.get(freshId), 'a fresh anchor must survive the purge');
});

test('pushedMessagesDb.purgeOlderThan keeps a row exactly at the retention edge', () => {
  const edgeId = track(uid('msg-edge'));
  pushedMessagesDb.record(edgeId, uid('ch'), 'agent-1', 'session-1');
  ageRow(edgeId, PUSHED_MESSAGE_RETENTION_DAYS - 1);

  pushedMessagesDb.purgeOlderThan(PUSHED_MESSAGE_RETENTION_DAYS);

  assert.ok(pushedMessagesDb.get(edgeId));
});

test('pushedMessagesDb.removeByChannel clears every anchor for a channel', () => {
  const chId = uid('ch');
  const a = track(uid('msg'));
  const b = track(uid('msg'));
  const other = track(uid('msg'));
  pushedMessagesDb.record(a, chId, 'agent-1', 'session-1');
  pushedMessagesDb.record(b, chId, 'agent-1', 'session-1');
  pushedMessagesDb.record(other, uid('ch-other'), 'agent-1', 'session-1');

  pushedMessagesDb.removeByChannel(chId);

  assert.equal(pushedMessagesDb.get(a), undefined);
  assert.equal(pushedMessagesDb.get(b), undefined);
  assert.ok(pushedMessagesDb.get(other), 'other channels are untouched');
});
