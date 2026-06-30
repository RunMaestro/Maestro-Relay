import type { Bot, Context as GrammyContext } from 'grammy';
import type { EnqueueOptions, IncomingAttachment, IncomingMessage } from '../../core/types';
import {
  isTranscriberAvailable,
  transcribeVoiceAttachment,
} from '../../core/transcription';
import { dispatchCommand } from './commands';
import { attachmentsFromMessage, downloadVoice, isVoiceMessage } from './voice';

type Enqueue = (msg: IncomingMessage, options?: EnqueueOptions) => void;

export type MessageHandlerDeps = {
  bot: Bot;
  boundChatId: string;
  boundAgentId: string;
  chatMode: 'forum' | 'dm';
  resolveAgentName: () => Promise<string>;
  allowedUserIds: string[];
  enqueue: Enqueue;
  isVoiceMessage: typeof isVoiceMessage;
  downloadVoice: typeof downloadVoice;
  attachmentsFromMessage: typeof attachmentsFromMessage;
  transcribeVoiceAttachment: typeof transcribeVoiceAttachment;
  isTranscriberAvailable: typeof isTranscriberAvailable;
  logger?: Pick<Console, 'warn' | 'error'>;
};

export function createMessageHandler(deps: MessageHandlerDeps) {
  return async function handleMessage(ctx: GrammyContext): Promise<void> {
    try {
      const message = ctx.message;
      const from = ctx.from;
      const chat = ctx.chat;
      if (!message || !from || !chat) return;

      if (from.is_bot) return;

      if (String(chat.id) !== deps.boundChatId) return;

      if (
        deps.allowedUserIds.length > 0 &&
        !deps.allowedUserIds.includes(String(from.id))
      ) {
        return;
      }

      const text = message.text ?? '';
      const threadId = message.message_thread_id;
      const isThread = !!message.is_topic_message && typeof threadId === 'number';
      // In forum supergroups the "General" topic has no `message_thread_id`
      // and is_topic_message is false. Topic-scoped messages have both set.
      // We only route topic-scoped messages to maestro; General-feed messages
      // are ignored (use `/session new` from anywhere to spawn a topic).
      const isForumGeneralFeed =
        deps.chatMode === 'forum' && !isThread;

      if (text.trimStart().startsWith('/')) {
        const boundAgentName = await deps.resolveAgentName();
        const reply = async (replyText: string) => {
          await deps.bot.api.sendMessage(
            deps.boundChatId,
            replyText,
            isThread && threadId !== undefined
              ? { message_thread_id: threadId }
              : {},
          );
        };
        const handled = await dispatchCommand(text, {
          bot: deps.bot,
          chatId: deps.boundChatId,
          threadId: isThread ? threadId : undefined,
          fromUserId: String(from.id),
          boundAgentId: deps.boundAgentId,
          boundAgentName,
          chatMode: deps.chatMode,
          reply,
        });
        if (handled) return;
      }

      // Drop non-command General-feed messages with a visible warning rather
      // than failing silently downstream in resolveConversation. Users can
      // start a topic via `/session new` (handled above before this point).
      if (isForumGeneralFeed) {
        const trimmed = (text || message.caption || '').trim();
        if (trimmed.length > 0) {
          const log = deps.logger?.warn ?? console.warn;
          log(
            `[telegram] ignoring message in supergroup General feed (chat=${chat.id}) — start a topic with /session new to chat with the agent`,
          );
        }
        return;
      }

      const channelId = isThread ? `${chat.id}:${threadId}` : `${chat.id}`;

      let content = message.text ?? message.caption ?? '';
      let attachments: IncomingAttachment[] = [];

      if (deps.isVoiceMessage(message) && deps.isTranscriberAvailable()) {
        const voiceAttachment = await deps.downloadVoice(deps.bot, message);
        try {
          const transcription = await deps.transcribeVoiceAttachment(voiceAttachment);
          content = transcription;
        } catch (err) {
          const log = deps.logger?.error ?? console.error;
          log('[telegram] voice transcription failed:', err);
          attachments = [voiceAttachment];
        }
      } else {
        attachments = deps.attachmentsFromMessage(deps.bot, message);
      }

      const authorName =
        from.username ?? from.first_name ?? String(from.id);

      const incoming: IncomingMessage = {
        provider: 'telegram',
        messageId: String(message.message_id),
        channelId,
        authorId: String(from.id),
        authorName,
        content,
        attachments,
        isThread,
        raw: ctx,
      };

      deps.enqueue(incoming);
    } catch (err) {
      const log = deps.logger?.error ?? console.error;
      log('[telegram] messageHandler', err);
    }
  };
}
