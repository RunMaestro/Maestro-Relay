import test from 'node:test';
import assert from 'node:assert/strict';
import { topicDb } from '../providers/telegram/topicsDb';
import { db } from '../core/db';

test('topicDb.getByAgentIdInChat returns only rows for the given chat', () => {
  db.prepare('DELETE FROM telegram_agent_topics WHERE agent_id = ?').run('test-scoped-agent');
  topicDb.register(101, 'chat-A', 'test-scoped-agent');
  topicDb.register(102, 'chat-A', 'test-scoped-agent');
  topicDb.register(201, 'chat-B', 'test-scoped-agent');

  const aOnly = topicDb.getByAgentIdInChat('chat-A', 'test-scoped-agent');
  assert.equal(aOnly.length, 2);
  assert.deepEqual(
    aOnly.map((r) => r.topic_id).sort(),
    [101, 102],
    'must include only chat-A rows',
  );

  const bOnly = topicDb.getByAgentIdInChat('chat-B', 'test-scoped-agent');
  assert.equal(bOnly.length, 1);
  assert.equal(bOnly[0].topic_id, 201);

  const cOnly = topicDb.getByAgentIdInChat('chat-C', 'test-scoped-agent');
  assert.equal(cOnly.length, 0, 'unknown chat returns empty');

  // getByAgentId still returns everything across chats
  const all = topicDb.getByAgentId('test-scoped-agent');
  assert.equal(all.length, 3);

  db.prepare('DELETE FROM telegram_agent_topics WHERE agent_id = ?').run('test-scoped-agent');
});

test('topicDb.getByAgentIdInChat orders ascending by created_at (default topic is oldest)', () => {
  db.prepare('DELETE FROM telegram_agent_topics WHERE agent_id = ?').run('test-order-agent');
  topicDb.register(700, 'chat-X', 'test-order-agent');
  // Wait a tick so created_at differs (better-sqlite3 + Date.now in ms)
  const start = Date.now();
  while (Date.now() === start) {
    /* tight spin */
  }
  topicDb.register(800, 'chat-X', 'test-order-agent');

  const topics = topicDb.getByAgentIdInChat('chat-X', 'test-order-agent');
  assert.equal(topics.length, 2);
  assert.equal(topics[0].topic_id, 700, 'oldest topic must come first');
  assert.equal(topics[1].topic_id, 800);

  db.prepare('DELETE FROM telegram_agent_topics WHERE agent_id = ?').run('test-order-agent');
});
