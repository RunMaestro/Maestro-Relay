import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../core/queue';
import type {
  BridgeProvider,
  ConversationRecord,
  IncomingMessage,
  KernelContext,
} from '../core/types';

/**
 * Smoke test: verifies that a brand-new BridgeProvider implementation can drive
 * the kernel end-to-end (start → resolve conversation → send → react → typing)
 * without touching any Discord-specific code.
 */
test('a minimal MockProvider satisfies BridgeProvider and works with the kernel queue', async () => {
  const sent: { channelId: string; text: string; mention?: boolean }[] = [];
  const reacted: string[] = [];
  let typingPings = 0;
  let removedReactions = 0;

  const persistSession = mock.fn();
  const conv: ConversationRecord = {
    agentId: 'agent-1',
    sessionId: null,
    readOnly: false,
    persistSession,
  };

  const ctxRecord: { ctx: KernelContext | null } = { ctx: null };

  const mockProvider: BridgeProvider = {
    name: 'mock',
    async start(ctx) {
      ctxRecord.ctx = ctx;
    },
    async stop() {},
    isReady: () => true,
    resolveConversation: () => conv,
    send: async (target, msg) => {
      sent.push({ channelId: target.channelId, text: msg.text, mention: msg.mention });
    },
    findOrCreateAgentChannel: async (agentId) => ({
      channelId: 'mock-ch-1',
      agentId,
      agentName: 'Mock Agent',
    }),
    react: async (_target, emoji) => {
      reacted.push(emoji);
      return {
        remove: async () => {
          removedReactions += 1;
        },
      };
    },
    sendTyping: async () => {
      typingPings += 1;
    },
  };

  const queue = createQueue({
    maestro: {
      getAgentCwd: async () => null,
      send: async () => ({
        success: true,
        response: 'agent reply',
        sessionId: 'session-99',
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalCostUsd: 0.0001,
          contextUsagePercent: 1,
        },
      }),
    },
    getProvider: (name) => (name === 'mock' ? mockProvider : undefined),
    splitMessage: (text) => [text],
    logger: { error: () => {} },
  });

  await mockProvider.start({ enqueue: queue.enqueue, logger: { error: () => {} } });

  const message: IncomingMessage = {
    provider: 'mock',
    messageId: 'm1',
    channelId: 'mock-ch-1',
    authorId: 'u1',
    authorName: 'User',
    content: 'hello',
    attachments: [],
    isThread: false,
  };

  queue.enqueue(message);
  await new Promise((r) => setTimeout(r, 50));

  // Provider received the agent reply and the cost line
  assert.ok(sent.some((m) => m.text === 'agent reply'));
  assert.ok(sent.some((m) => m.text.includes('tokens')));

  // Reaction lifecycle ran
  assert.deepEqual(reacted, ['⏳']);
  assert.equal(removedReactions, 1);

  // At least one typing ping happened before the reply
  assert.ok(typingPings >= 1);

  // Session id was persisted from the maestro response
  assert.equal(persistSession.mock.callCount(), 1);
});
