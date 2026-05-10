import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../providers/telegram/messageHandler';
import { topicDb } from '../providers/telegram/topicsDb';
import { channelDb as coreChannelDb } from '../core/db';

const BOUND_CHAT = 'tg-chat-session-new';
const BOUND_AGENT = 'agent-session-new';

afterEach(() => {
  try {
    coreChannelDb.remove('telegram', BOUND_CHAT);
  } catch {
    /* ignore */
  }
  for (const row of topicDb.listByChat(BOUND_CHAT)) {
    try {
      topicDb.remove(BOUND_CHAT, row.topic_id);
    } catch {
      /* ignore */
    }
  }
});

type FakeBotApiCall = { method: string; args: unknown[] };

function makeFakeBot(opts: { newTopicId?: number } = {}) {
  const calls: FakeBotApiCall[] = [];
  const api = {
    createForumTopic: async (chatId: string, name: string) => {
      calls.push({ method: 'createForumTopic', args: [chatId, name] });
      return { message_thread_id: opts.newTopicId ?? 555, name };
    },
    sendMessage: async (chatId: string, text: string, options?: unknown) => {
      calls.push({ method: 'sendMessage', args: [chatId, text, options] });
      return { message_id: 1 };
    },
  };
  return { bot: { api } as any, calls };
}

function makeCtx(text: string, threadId?: number) {
  const message: Record<string, unknown> = {
    message_id: 42,
    text,
  };
  if (threadId !== undefined) {
    message.message_thread_id = threadId;
    message.is_topic_message = true;
  }
  return {
    message,
    from: { id: 7, is_bot: false, username: 'tester' },
    chat: { id: BOUND_CHAT, type: 'supergroup' },
  } as any;
}

function baseDeps(overrides: Partial<Parameters<typeof createMessageHandler>[0]>) {
  return {
    boundChatId: BOUND_CHAT,
    boundAgentId: BOUND_AGENT,
    chatMode: 'forum' as const,
    resolveAgentName: async () => 'My Agent',
    allowedUserIds: [],
    enqueue: () => undefined,
    isVoiceMessage: () => false,
    downloadVoice: async () => {
      throw new Error('not used');
    },
    attachmentsFromMessage: async () => [],
    transcribeVoiceAttachment: async () => '',
    isTranscriberAvailable: () => false,
    logger: { warn: () => undefined, error: () => undefined },
    ...overrides,
  } as Parameters<typeof createMessageHandler>[0];
}

test('forum mode: /new creates a topic, registers it, replies in topic, and skips enqueue', async () => {
  const { bot, calls } = makeFakeBot({ newTopicId: 901 });
  let enqueued = 0;
  const handler = createMessageHandler(
    baseDeps({ bot, enqueue: () => (enqueued += 1) }),
  );

  await handler(makeCtx('/new'));

  assert.equal(enqueued, 0, 'should not enqueue the slash command');
  const created = calls.find((c) => c.method === 'createForumTopic');
  assert.ok(created, 'should call createForumTopic');
  assert.equal((created!.args[0] as string), BOUND_CHAT);
  assert.match(created!.args[1] as string, /^My Agent session /);

  const sent = calls.find((c) => c.method === 'sendMessage');
  assert.ok(sent, 'should send a confirmation message');
  assert.equal(sent!.args[1], 'Started a new session in this topic. Send a message to begin.');
  assert.deepEqual(sent!.args[2], { message_thread_id: 901 });

  const row = topicDb.get(BOUND_CHAT, 901);
  assert.ok(row, 'created topic should be persisted');
  assert.equal(row!.agent_id, BOUND_AGENT);
});

test('forum mode: /session new also matches', async () => {
  const { bot, calls } = makeFakeBot({ newTopicId: 902 });
  const handler = createMessageHandler(baseDeps({ bot }));

  await handler(makeCtx('/session new'));

  const created = calls.find((c) => c.method === 'createForumTopic');
  assert.ok(created, '/session new should also trigger topic creation');
});

test('dm mode: /new clears the bound channel session and replies', async () => {
  coreChannelDb.register('telegram', BOUND_CHAT, BOUND_AGENT, 'My Agent');
  coreChannelDb.updateSession('telegram', BOUND_CHAT, 'old-session-123');
  assert.equal(coreChannelDb.get('telegram', BOUND_CHAT)!.session_id, 'old-session-123');

  const { bot, calls } = makeFakeBot();
  let enqueued = 0;
  const handler = createMessageHandler(
    baseDeps({ bot, chatMode: 'dm', enqueue: () => (enqueued += 1) }),
  );

  await handler(makeCtx('/new'));

  assert.equal(enqueued, 0, 'should not enqueue the slash command');
  const created = calls.find((c) => c.method === 'createForumTopic');
  assert.equal(created, undefined, 'should not create a forum topic in dm mode');

  const sent = calls.find((c) => c.method === 'sendMessage');
  assert.ok(sent);
  assert.equal(sent!.args[1], 'Started a new session. Send a message to begin.');

  assert.equal(coreChannelDb.get('telegram', BOUND_CHAT)!.session_id, null);
});

test('non-/new messages bypass session-new path', async () => {
  coreChannelDb.register('telegram', BOUND_CHAT, BOUND_AGENT, 'My Agent');

  const { bot, calls } = makeFakeBot();
  let enqueued = 0;
  const handler = createMessageHandler(
    baseDeps({ bot, chatMode: 'dm', enqueue: () => (enqueued += 1) }),
  );

  await handler(makeCtx('hello there'));

  assert.equal(enqueued, 1, 'normal message should be enqueued');
  assert.equal(calls.length, 0, 'no telegram api calls for normal message');
});

test('/news (similar prefix) is not treated as /new', async () => {
  coreChannelDb.register('telegram', BOUND_CHAT, BOUND_AGENT, 'My Agent');

  const { bot, calls } = makeFakeBot();
  let enqueued = 0;
  const handler = createMessageHandler(
    baseDeps({ bot, chatMode: 'dm', enqueue: () => (enqueued += 1) }),
  );

  await handler(makeCtx('/news today'));

  assert.equal(enqueued, 1, 'word-boundary on /new should let /news through');
  assert.equal(calls.length, 0);
});
