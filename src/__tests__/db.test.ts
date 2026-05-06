import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { channelDb } from '../providers/discord/channelsDb';
import { threadDb } from '../providers/discord/threadsDb';

// Use unique IDs per test run to avoid cross-test contamination
let testId = 0;
function uid(prefix: string) {
  testId++;
  return `${prefix}-test-${testId}-${Date.now()}`;
}

// Track created IDs for cleanup
const createdChannels: string[] = [];
const createdThreads: string[] = [];

afterEach(() => {
  for (const id of createdThreads) {
    try {
      threadDb.remove(id);
    } catch {
      /* ignore */
    }
  }
  for (const id of createdChannels) {
    try {
      channelDb.remove(id);
    } catch {
      /* ignore */
    }
  }
  createdChannels.length = 0;
  createdThreads.length = 0;
});

// --- channelDb ---

test('channelDb.register and get round-trip', () => {
  const chId = uid('ch');
  const guildId = uid('guild');
  createdChannels.push(chId);

  channelDb.register(chId, guildId, 'agent-1', 'Agent One');
  const row = channelDb.get(chId);

  assert.ok(row);
  assert.equal(row.channel_id, chId);
  assert.equal(row.guild_id, guildId);
  assert.equal(row.agent_id, 'agent-1');
  assert.equal(row.agent_name, 'Agent One');
  assert.equal(row.session_id, null);
  assert.equal(typeof row.created_at, 'number');
});

test('channelDb.get returns undefined for unknown channel', () => {
  assert.equal(channelDb.get('nonexistent-channel'), undefined);
});

test('channelDb.getByAgentId returns the channel for a given agent', () => {
  const chId = uid('ch');
  const agentId = uid('agent');
  createdChannels.push(chId);

  channelDb.register(chId, 'guild-1', agentId, 'Test Agent');
  const row = channelDb.getByAgentId(agentId);

  assert.ok(row);
  assert.equal(row.channel_id, chId);
  assert.equal(row.agent_id, agentId);
});

test('channelDb.getByAgentId returns undefined for unknown agent', () => {
  assert.equal(channelDb.getByAgentId('nonexistent-agent'), undefined);
});

test('channelDb.updateSession sets the session_id', () => {
  const chId = uid('ch');
  createdChannels.push(chId);

  channelDb.register(chId, 'guild-1', 'agent-1', 'Agent');
  assert.equal(channelDb.get(chId)!.session_id, null);

  channelDb.updateSession(chId, 'sess-42');
  assert.equal(channelDb.get(chId)!.session_id, 'sess-42');

  channelDb.updateSession(chId, null);
  assert.equal(channelDb.get(chId)!.session_id, null);
});

test('channelDb.setReadOnly toggles the read_only flag', () => {
  const chId = uid('ch');
  createdChannels.push(chId);

  channelDb.register(chId, 'guild-1', 'agent-1', 'Agent');
  assert.equal(channelDb.get(chId)!.read_only, 0);

  channelDb.setReadOnly(chId, true);
  assert.equal(channelDb.get(chId)!.read_only, 1);

  channelDb.setReadOnly(chId, false);
  assert.equal(channelDb.get(chId)!.read_only, 0);
});

test('channelDb.remove deletes the channel', () => {
  const chId = uid('ch');
  createdChannels.push(chId);

  channelDb.register(chId, 'guild-1', 'agent-1', 'Agent');
  assert.ok(channelDb.get(chId));

  channelDb.remove(chId);
  assert.equal(channelDb.get(chId), undefined);
});

test('channelDb.listByAgentId returns all channels for an agent', () => {
  const agentId = uid('agent');
  const ch1 = uid('ch');
  const ch2 = uid('ch');
  createdChannels.push(ch1, ch2);

  channelDb.register(ch1, 'guild-1', agentId, 'Agent');
  channelDb.register(ch2, 'guild-2', agentId, 'Agent');

  const rows = channelDb.listByAgentId(agentId);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.channel_id === ch1));
  assert.ok(rows.some((r) => r.channel_id === ch2));
});

test('channelDb.listByAgentId returns empty array for unknown agent', () => {
  assert.deepEqual(channelDb.listByAgentId('no-such-agent'), []);
});

test('channelDb.listByGuild returns all channels for a guild', () => {
  const guildId = uid('guild');
  const ch1 = uid('ch');
  const ch2 = uid('ch');
  createdChannels.push(ch1, ch2);

  channelDb.register(ch1, guildId, 'agent-a', 'A');
  channelDb.register(ch2, guildId, 'agent-b', 'B');

  const rows = channelDb.listByGuild(guildId);
  assert.equal(rows.length, 2);
});

test('channelDb.listByGuild returns empty array for unknown guild', () => {
  assert.deepEqual(channelDb.listByGuild('no-such-guild'), []);
});

test('channelDb.register throws on duplicate channel_id', () => {
  const chId = uid('ch');
  createdChannels.push(chId);

  channelDb.register(chId, 'guild-1', 'agent-1', 'Agent');
  assert.throws(() => {
    channelDb.register(chId, 'guild-1', 'agent-2', 'Agent 2');
  });
});

// --- threadDb ---

test('threadDb.register and get round-trip', () => {
  const threadId = uid('thread');
  createdThreads.push(threadId);

  threadDb.register(threadId, 'channel-1', 'agent-1', 'user-1');
  const row = threadDb.get(threadId);

  assert.ok(row);
  assert.equal(row.thread_id, threadId);
  assert.equal(row.channel_id, 'channel-1');
  assert.equal(row.agent_id, 'agent-1');
  assert.equal(row.owner_user_id, 'user-1');
  assert.equal(row.session_id, null);
  assert.equal(typeof row.created_at, 'number');
});

test('threadDb.get returns undefined for unknown thread', () => {
  assert.equal(threadDb.get('nonexistent-thread'), undefined);
});

test('threadDb.updateSession sets the session_id', () => {
  const threadId = uid('thread');
  createdThreads.push(threadId);

  threadDb.register(threadId, 'channel-1', 'agent-1', 'user-1');
  assert.equal(threadDb.get(threadId)!.session_id, null);

  threadDb.updateSession(threadId, 'sess-99');
  assert.equal(threadDb.get(threadId)!.session_id, 'sess-99');

  threadDb.updateSession(threadId, null);
  assert.equal(threadDb.get(threadId)!.session_id, null);
});

test('threadDb.listByChannel returns threads ordered by created_at DESC', () => {
  const channelId = uid('ch');
  const t1 = uid('thread');
  const t2 = uid('thread');
  createdThreads.push(t1, t2);

  threadDb.register(t1, channelId, 'agent-1', 'user-1');
  threadDb.register(t2, channelId, 'agent-1', 'user-2');

  const rows = threadDb.listByChannel(channelId);
  assert.equal(rows.length, 2);
  // Most recent first
  assert.ok(rows[0].created_at >= rows[1].created_at);
});

test('threadDb.listByChannel returns empty array for unknown channel', () => {
  assert.deepEqual(threadDb.listByChannel('no-such-channel'), []);
});

test('threadDb.remove deletes the thread', () => {
  const threadId = uid('thread');
  createdThreads.push(threadId);

  threadDb.register(threadId, 'channel-1', 'agent-1', 'user-1');
  assert.ok(threadDb.get(threadId));

  threadDb.remove(threadId);
  assert.equal(threadDb.get(threadId), undefined);
});

test('threadDb.getByAgentId returns all threads for an agent', () => {
  const agentId = uid('agent');
  const t1 = uid('thread');
  const t2 = uid('thread');
  createdThreads.push(t1, t2);

  threadDb.register(t1, 'ch-1', agentId, 'user-1');
  threadDb.register(t2, 'ch-2', agentId, 'user-2');

  const rows = threadDb.getByAgentId(agentId);
  assert.equal(rows.length, 2);
});

test('threadDb.getByAgentId returns empty array for unknown agent', () => {
  assert.deepEqual(threadDb.getByAgentId('no-such-agent'), []);
});

test('threadDb.removeByChannel deletes all threads for a channel', () => {
  const channelId = uid('ch');
  const t1 = uid('thread');
  const t2 = uid('thread');
  createdThreads.push(t1, t2);

  threadDb.register(t1, channelId, 'agent-1', 'user-1');
  threadDb.register(t2, channelId, 'agent-1', 'user-2');
  assert.equal(threadDb.listByChannel(channelId).length, 2);

  threadDb.removeByChannel(channelId);
  assert.equal(threadDb.listByChannel(channelId).length, 0);
  assert.equal(threadDb.get(t1), undefined);
  assert.equal(threadDb.get(t2), undefined);
});

test('threadDb.register throws on duplicate thread_id', () => {
  const threadId = uid('thread');
  createdThreads.push(threadId);

  threadDb.register(threadId, 'ch-1', 'agent-1', 'user-1');
  assert.throws(() => {
    threadDb.register(threadId, 'ch-2', 'agent-2', 'user-2');
  });
});
