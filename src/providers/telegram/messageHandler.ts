import type { Bot, Context as GrammyContext } from 'grammy';
import type { EnqueueOptions, IncomingAttachment, IncomingMessage } from '../../core/types';
import {
  isTranscriberAvailable,
  transcribeVoiceAttachment,
} from '../../core/transcription';
import { attachmentsFromMessage, downloadVoice, isVoiceMessage } from './voice';

type Enqueue = (msg: IncomingMessage, options?: EnqueueOptions) => void;

export type MessageHandlerDeps = {
  bot: Bot;
  boundChatId: string;
  boundAgentId: string;
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

      const threadId = message.message_thread_id;
      const isThread = !!message.is_topic_message && typeof threadId === 'number';
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
        attachments = await deps.attachmentsFromMessage(deps.bot, message);
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
