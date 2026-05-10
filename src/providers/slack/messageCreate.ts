import type { KernelContext, IncomingMessage } from '../../core/types';
import { conversationDb } from './conversationsDb';

/**
 * Factory that returns a handler for Slack `message` events.
 * Only processes threaded replies to registered conversations.
 */
export function createMessageHandler(ctx: KernelContext) {
  return async function handleMessage(args: {
    event: Record<string, unknown>;
  }): Promise<void> {
    const event = args.event;

    // Ignore bot messages and empty messages
    if (event['bot_id'] || !String(event['text'] ?? '').trim()) {
      return;
    }

    const threadTs = event['thread_ts'] as string | undefined;
    const text = event['text'] as string;
    const user = event['user'] as string | undefined;
    const channel = event['channel'] as string;
    const ts = event['ts'] as string;

    // Only process messages inside known threads
    if (!threadTs) {
      return;
    }

    const convo = conversationDb.get(threadTs);
    if (!convo) {
      return;
    }

    // Only the thread owner can interact
    if (convo.owner_user_id && convo.owner_user_id !== user) {
      return;
    }

    const message: IncomingMessage = {
      provider: 'slack',
      messageId: ts,
      channelId: threadTs,
      authorId: user ?? '',
      authorName: user ?? '',
      content: text,
      attachments: [],
      isThread: true,
      raw: event,
    };

    ctx.enqueue(message);
  };
}
