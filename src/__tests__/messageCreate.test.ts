import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageCreateHandler } from '../providers/discord/messageCreate';

function makeAttachments(items: any[] = []) {
  const filter = (predicate: (a: any) => boolean) => makeAttachments(items.filter(predicate));
  return {
    size: items.length,
    values: () => items.values(),
    filter,
  };
}

function makeMessage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    author: { bot: false, id: 'user-1', username: 'test-user' },
    member: { displayName: 'Test User' },
    guild: { id: 'guild-1' },
    content: 'hello',
    attachments: makeAttachments(),
    mentions: { users: { has: () => false } },
    channel: {
      id: 'thread-1',
      isThread: () => true,
      sendTyping: async () => undefined,
    },
    reply: async () => undefined,
    ...overrides,
  } as unknown;
}

function createDeps(enqueue: (...args: any[]) => void) {
  return {
    channelDb: { get: () => ({ agent_id: 'agent-1' }) as any },
    threadDb: {
      get: () => ({ thread_id: 'thread-1' }) as any,
      register: () => undefined,
    },
    getBotUserId: () => 'bot-1',
    enqueue,
    isVoiceMessage: () => true,
    isVoiceAttachment: () => false,
    transcribeVoiceAttachment: async () => '',
    isTranscriberAvailable: () => true,
    splitMessage: (text: string) => [text],
  };
}

test('handleMessageCreate ignores bot messages', async () => {
  let enqueued = 0;
  const handler = createMessageCreateHandler(
    createDeps(() => {
      enqueued += 1;
    }),
  );

  await handler(makeMessage({ author: { bot: true } }) as any);
  assert.equal(enqueued, 0);
});

test('handleMessageCreate ignores DMs', async () => {
  let enqueued = 0;
  const handler = createMessageCreateHandler(
    createDeps(() => {
      enqueued += 1;
    }),
  );

  await handler(makeMessage({ guild: null }) as any);
  assert.equal(enqueued, 0);
});

test('handleMessageCreate ignores messages with no text and no attachments', async () => {
  let enqueued = 0;
  const handler = createMessageCreateHandler(
    createDeps(() => {
      enqueued += 1;
    }),
  );

  await handler(makeMessage({ content: '   ', attachments: { size: 0, values: () => [] } }) as any);
  assert.equal(enqueued, 0);
});

test('handleMessageCreate allows attachment-only messages (no text)', async () => {
  let enqueued = 0;
  const handler = createMessageCreateHandler(
    createDeps(() => {
      enqueued += 1;
    }),
  );

  await handler(
    makeMessage({
      content: '',
      attachments: {
        size: 1,
        values: () => [{ url: 'https://example.com/file.png', name: 'file.png' }],
      },
    }) as any,
  );
  assert.equal(enqueued, 1);
});

test('handleMessageCreate ignores non-thread channels', async () => {
  let enqueued = 0;
  const handler = createMessageCreateHandler(
    createDeps(() => {
      enqueued += 1;
    }),
  );

  await handler(
    makeMessage({
      channel: {
        id: 'channel-1',
        isThread: () => false,
        threads: { create: async () => undefined },
      },
    }) as any,
  );
  assert.equal(enqueued, 0);
});

test('handleMessageCreate ignores unregistered threads', async () => {
  let enqueued = 0;
  const deps = createDeps(() => {
    enqueued += 1;
  });
  deps.threadDb.get = () => undefined;
  const handler = createMessageCreateHandler(deps);

  await handler(makeMessage() as any);
  assert.equal(enqueued, 0);
});

test('handleMessageCreate enqueues messages for registered threads', async () => {
  let enqueued = 0;
  const handler = createMessageCreateHandler(
    createDeps(() => {
      enqueued += 1;
    }),
  );

  await handler(makeMessage() as any);
  assert.equal(enqueued, 1);
});

test('handleMessageCreate enqueues messages for registered threads from the owner', async () => {
  let enqueued = 0;
  const deps = createDeps(() => {
    enqueued += 1;
  });
  deps.threadDb.get = () => ({ thread_id: 'thread-1', owner_user_id: 'user-1' }) as any;
  const handler = createMessageCreateHandler(deps);

  await handler(
    makeMessage({ author: { bot: false, id: 'user-1', username: 'owner-user' } }) as any,
  );
  assert.equal(enqueued, 1);
});

test('handleMessageCreate silently ignores registered thread messages from non-owner', async () => {
  let enqueued = 0;
  const deps = createDeps(() => {
    enqueued += 1;
  });
  deps.threadDb.get = () => ({ thread_id: 'thread-1', owner_user_id: 'owner-1' }) as any;
  const handler = createMessageCreateHandler(deps);

  await handler(
    makeMessage({ author: { bot: false, id: 'user-2', username: 'other-user' } }) as any,
  );
  assert.equal(enqueued, 0);
});

test('handleMessageCreate creates and registers a thread for bot mentions in registered channels', async () => {
  let enqueued = 0;
  const registerCalls: unknown[][] = [];
  const sentMessages: string[] = [];
  const deps = createDeps(() => {
    enqueued += 1;
  });
  deps.threadDb.register = (...args: unknown[]) => {
    registerCalls.push(args);
  };

  const handler = createMessageCreateHandler(deps as any);
  await handler(
    makeMessage({
      content: 'hello <@bot-1>',
      channel: {
        id: 'channel-1',
        isThread: () => false,
        threads: {
          create: async ({ name }: { name: string }) => {
            assert.ok(name.includes('Test-User'));
            return {
              id: 'thread-new-1',
              send: async (msg: string | { content?: string; files?: string[] }) => {
                const text = typeof msg === 'string' ? msg : (msg.content ?? '');
                sentMessages.push(text);
                return {
                  id: 'msg-forwarded',
                  content: text,
                  author: { id: 'user-1', username: 'test-user' },
                  member: { displayName: 'Test User' },
                  channel: { id: 'thread-new-1', isThread: () => true },
                  attachments: { size: 0, values: () => [] },
                };
              },
            };
          },
        },
      },
    }) as any,
  );

  assert.equal(enqueued, 1);
  assert.deepEqual(registerCalls, [['thread-new-1', 'channel-1', 'agent-1', 'user-1']]);
  assert.deepEqual(sentMessages, ['This thread is bound to <@user-1>.', 'hello']);
});

test('handleMessageCreate creates and registers a thread when mention metadata includes bot', async () => {
  const registerCalls: unknown[][] = [];
  const deps = createDeps(() => undefined);
  deps.threadDb.register = (...args: unknown[]) => {
    registerCalls.push(args);
  };
  const handler = createMessageCreateHandler(deps as any);

  await handler(
    makeMessage({
      author: { bot: false, id: 'user-42', username: 'alice' },
      mentions: { users: { has: (id: string) => id === 'bot-1' } },
      channel: {
        id: 'channel-1',
        isThread: () => false,
        threads: {
          create: async () => ({
            id: 'thread-new-2',
            send: async (msg: string | { content?: string; files?: string[] }) => {
              const text = typeof msg === 'string' ? msg : (msg.content ?? '');
              return { id: 'msg-fwd', content: text, attachments: { size: 0, values: () => [] } };
            },
          }),
        },
      },
    }) as any,
  );

  assert.deepEqual(registerCalls, [['thread-new-2', 'channel-1', 'agent-1', 'user-42']]);
});

test('handleMessageCreate forwards attachments as AttachmentPayload objects in mention-triggered threads', async () => {
  let enqueued = 0;
  let enqueuedMessage: any = null;
  const deps = createDeps((msg: any) => {
    enqueued += 1;
    enqueuedMessage = msg;
  });
  deps.threadDb.register = () => undefined;

  const handler = createMessageCreateHandler(deps as any);
  await handler(
    makeMessage({
      content: 'check this <@bot-1>',
      attachments: {
        size: 1,
        values: () => [{ url: 'https://cdn.discord.com/file.png', name: 'file.png', size: 500 }],
      },
      channel: {
        id: 'channel-1',
        isThread: () => false,
        threads: {
          create: async () => ({
            id: 'thread-att-1',
            send: async (msg: string | { content?: string; files?: unknown[] }) => {
              if (typeof msg !== 'string' && msg.files) {
                // Verify files are sent as AttachmentPayload objects, not bare URLs
                assert.ok(Array.isArray(msg.files));
                for (const f of msg.files) {
                  assert.ok(typeof f === 'object' && f !== null);
                  assert.ok('attachment' in (f as any), 'file should have attachment property');
                  assert.ok('name' in (f as any), 'file should have name property');
                }
              }
              return {
                id: 'msg-att-forwarded',
                content: typeof msg === 'string' ? msg : (msg.content ?? ''),
                author: { id: 'user-1', username: 'test-user' },
                member: { displayName: 'Test User' },
                channel: { id: 'thread-att-1', isThread: () => true },
                // Simulate discord.js: when sent with AttachmentPayload, the
                // returned message should have real attachments
                attachments: {
                  size: 1,
                  values: () => [
                    {
                      url: 'https://cdn.discord.com/reupload/file.png',
                      name: 'file.png',
                      size: 500,
                    },
                  ],
                },
              };
            },
          }),
        },
      },
    }) as any,
  );

  assert.equal(enqueued, 1);
  // The enqueued message should have real attachments (not empty)
  assert.ok(enqueuedMessage);
  assert.equal(enqueuedMessage.attachments.length, 1);
});

test('handleMessageCreate ignores non-thread channel messages without bot mention', async () => {
  let created = 0;
  const deps = createDeps(() => undefined);
  const handler = createMessageCreateHandler(deps);

  await handler(
    makeMessage({
      content: 'hello there',
      channel: {
        id: 'channel-1',
        isThread: () => false,
        threads: {
          create: async () => {
            created += 1;
            return { id: 'thread-x', send: async () => undefined };
          },
        },
      },
    }) as any,
  );

  assert.equal(created, 0);
});

test('handleMessageCreate transcribes voice messages and enqueues transcription text', async () => {
  const enqueueCalls: unknown[][] = [];
  const replies: string[] = [];
  const reactions: string[] = [];
  const reactionUserRemovals: string[] = [];
  const deps = createDeps((...args: unknown[]) => {
    enqueueCalls.push(args);
  });
  deps.isVoiceAttachment = () => true;
  deps.transcribeVoiceAttachment = async () => 'hello from voice';

  const handler = createMessageCreateHandler(deps as any);
  await handler(
    makeMessage({
      content: '',
      attachments: makeAttachments([
        { url: 'https://cdn.discord.com/voice.ogg', name: 'voice.ogg' },
      ]),
      reply: async (msg: string | { content: string; allowedMentions?: unknown }) => {
        replies.push(typeof msg === 'string' ? msg : msg.content);
        return undefined;
      },
      react: async (emoji: string) => {
        reactions.push(emoji);
        return {
          users: {
            remove: async (userId: string) => {
              reactionUserRemovals.push(userId);
              return undefined;
            },
          },
        };
      },
    }) as any,
  );

  assert.equal(enqueueCalls.length, 1);
  assert.equal((enqueueCalls[0][1] as any).contentOverride, 'hello from voice');
  assert.equal((enqueueCalls[0][1] as any).attachmentsOverride.length, 0);
  assert.ok(reactions.includes('🎧'), 'should have 🎧 reaction');
  assert.ok(replies.some((r) => r.includes('🎧')), 'should have 🎧 in transcription reply');
  assert.deepEqual(
    reactionUserRemovals,
    ['bot-1'],
    'should remove only the bots own reaction (not all users)',
  );
});

test('handleMessageCreate preserves non-voice attachments when message mixes voice + files', async () => {
  const enqueueCalls: unknown[][] = [];
  const deps = createDeps((...args: unknown[]) => {
    enqueueCalls.push(args);
  });
  const voice = { url: 'https://cdn.discord.com/voice.ogg', name: 'voice.ogg' };
  const image = { url: 'https://cdn.discord.com/photo.png', name: 'photo.png' };
  (deps as any).isVoiceAttachment = (a: any) => a.name.endsWith('.ogg');
  deps.transcribeVoiceAttachment = async () => 'hello from voice';

  const handler = createMessageCreateHandler(deps as any);
  await handler(
    makeMessage({
      content: 'see attached',
      attachments: makeAttachments([voice, image]),
      reply: async () => undefined,
      react: async () => ({ users: { remove: async () => undefined } }),
    }) as any,
  );

  assert.equal(enqueueCalls.length, 1);
  const options = enqueueCalls[0][1] as any;
  assert.equal(
    options.attachmentsOverride.length,
    1,
    'voice attachment should be filtered out',
  );
  assert.equal(
    options.attachmentsOverride[0].name,
    image.name,
    'non-voice attachment should be preserved for the agent',
  );
  assert.equal(
    options.contentOverride,
    'see attached\n\nhello from voice',
    'content should combine original text with transcription',
  );
});

test('handleMessageCreate forwards original message when transcriber dependencies are missing', async () => {
  const enqueueCalls: unknown[][] = [];
  const replies: string[] = [];
  const reactions: string[] = [];
  const deps = createDeps((...args: unknown[]) => {
    enqueueCalls.push(args);
  });
  deps.isVoiceAttachment = () => true;
  deps.isTranscriberAvailable = () => false;
  deps.transcribeVoiceAttachment = async () => {
    throw new Error('should not be called when transcriber is unavailable');
  };

  const handler = createMessageCreateHandler(deps as any);
  await handler(
    makeMessage({
      content: '',
      attachments: makeAttachments([
        { url: 'https://cdn.discord.com/voice.ogg', name: 'voice.ogg' },
      ]),
      reply: async (msg: string | { content: string; allowedMentions?: unknown }) => {
        replies.push(typeof msg === 'string' ? msg : msg.content);
        return undefined;
      },
      react: async (emoji: string) => {
        reactions.push(emoji);
        return { users: { remove: async () => undefined } };
      },
    }) as any,
  );

  assert.equal(enqueueCalls.length, 1, 'original message should be enqueued unchanged');
  assert.equal(enqueueCalls[0].length, 1, 'no override options should be passed in fallback');
  assert.equal(reactions.length, 0, 'no 🎧 reaction should be added when transcriber is unavailable');
  assert.ok(
    replies.some((r) => r.includes('Voice transcription is currently unavailable')),
    'user should see the unavailability advisory',
  );
});

test('handleMessageCreate does not transcribe a bare .ogg upload without the voice-message flag', async () => {
  const enqueueCalls: unknown[][] = [];
  const reactions: string[] = [];
  let transcribeCalled = false;
  const deps = createDeps((...args: unknown[]) => {
    enqueueCalls.push(args);
  });
  // The attachment looks like a voice file but the message lacks the
  // IsVoiceMessage flag — a regular .ogg upload, not a Discord voice message.
  deps.isVoiceMessage = () => false;
  deps.isVoiceAttachment = () => true;
  deps.transcribeVoiceAttachment = async () => {
    transcribeCalled = true;
    return 'should not happen';
  };

  const handler = createMessageCreateHandler(deps as any);
  await handler(
    makeMessage({
      content: 'here is some music',
      attachments: makeAttachments([
        { url: 'https://cdn.discord.com/song.ogg', name: 'song.ogg' },
      ]),
      reply: async () => undefined,
      react: async (emoji: string) => {
        reactions.push(emoji);
        return { users: { remove: async () => undefined } };
      },
    }) as any,
  );

  assert.equal(transcribeCalled, false, 'transcriber should not run for non-voice messages');
  assert.equal(reactions.length, 0, 'no 🎧 reaction for non-voice messages');
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].length, 1, 'should enqueue with no override options');
});

test('handleMessageCreate reports transcription failures and falls back to enqueueing original', async () => {
  let enqueued = 0;
  const replies: string[] = [];
  const reactions: string[] = [];
  const deps = createDeps(() => {
    enqueued += 1;
  });
  deps.isVoiceAttachment = () => true;
  deps.transcribeVoiceAttachment = async () => {
    throw new Error('boom');
  };

  const handler = createMessageCreateHandler(deps as any);
  await handler(
    makeMessage({
      attachments: makeAttachments([
        { url: 'https://cdn.discord.com/voice.ogg', name: 'voice.ogg' },
      ]),
      reply: async (msg: string | { content: string; allowedMentions?: unknown }) => {
        replies.push(typeof msg === 'string' ? msg : msg.content);
        return undefined;
      },
      react: async (emoji: string) => {
        reactions.push(emoji);
        return { users: { remove: async () => undefined } };
      },
    }) as any,
  );

  assert.equal(enqueued, 1, 'should enqueue original message as fallback on transcription error');
  assert.ok(reactions.includes('🎧'), 'should have 🎧 reaction even on failure');
  assert.ok(replies.some((r) => r.includes('Failed to transcribe this voice message')));
});
