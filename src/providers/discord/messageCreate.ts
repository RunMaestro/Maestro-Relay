import { Message, TextChannel, ThreadAutoArchiveDuration } from 'discord.js';
import { escapeMarkdown } from '@discordjs/formatters';
import type {
  EnqueueOptions,
  IncomingAttachment,
  IncomingMessage,
} from '../../core/types';
import {
  isTranscriberAvailable,
  transcribeVoiceAttachment,
} from '../../core/transcription';
import { splitMessage } from '../../core/splitMessage';
import { channelDb } from './channelsDb';
import { threadDb } from './threadsDb';
import { discordAttachmentToIncoming, isVoiceAttachment, isVoiceMessage } from './voice';

type Enqueue = (msg: IncomingMessage, options?: EnqueueOptions) => void;

export type MessageCreateDeps = {
  channelDb: Pick<typeof channelDb, 'get'>;
  threadDb: Pick<typeof threadDb, 'get' | 'register'>;
  getBotUserId: (message: Message) => string | undefined;
  enqueue: Enqueue;
  isVoiceMessage: typeof isVoiceMessage;
  isVoiceAttachment: typeof isVoiceAttachment;
  transcribeVoiceAttachment: typeof transcribeVoiceAttachment;
  isTranscriberAvailable: typeof isTranscriberAvailable;
  splitMessage: typeof splitMessage;
  logger?: Pick<Console, 'warn' | 'error'>;
};

function toIncoming(message: Message, attachmentSource?: IncomingAttachment[]): IncomingMessage {
  const attachments =
    attachmentSource ?? [...message.attachments.values()].map(discordAttachmentToIncoming);
  return {
    provider: 'discord',
    messageId: message.id,
    channelId: message.channel.id,
    authorId: message.author.id,
    authorName:
      message.member?.displayName ?? message.author.username ?? message.author.id,
    content: message.content,
    attachments,
    isThread: message.channel.isThread(),
    raw: message,
  };
}

export function createMessageCreateHandler(deps: MessageCreateDeps) {
  return async function handleMessageCreate(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.guild) return;

    if (!message.content.trim() && message.attachments.size === 0) return;

    const botUserId = deps.getBotUserId(message);
    if (!botUserId) {
      const warn = deps.logger?.warn ?? console.warn;
      warn('messageCreate: bot user ID missing, skipping message handling');
      return;
    }

    if (!message.channel.isThread()) {
      const channelInfo = deps.channelDb.get(message.channel.id);
      if (!channelInfo) {
        console.debug(`[mention] channel ${message.channel.id} not registered, ignoring`);
        return;
      }

      const mentionedByUser = message.mentions.users.has(botUserId);
      const botRoleId = message.guild?.members?.me?.roles.botRole?.id;
      const mentionedByRole = !!(botRoleId && message.mentions.roles?.has(botRoleId));
      const mentionedByContent =
        message.content.includes(`<@${botUserId}>`) ||
        message.content.includes(`<@!${botUserId}>`) ||
        (!!botRoleId && message.content.includes(`<@&${botRoleId}>`));
      console.debug(
        `[mention] botUserId=${botUserId} botRoleId=${botRoleId} user=${mentionedByUser} role=${mentionedByRole} content=${mentionedByContent} raw=${JSON.stringify(message.content)}`,
      );
      if (!mentionedByUser && !mentionedByRole && !mentionedByContent) return;

      try {
        const authorName =
          message.member?.displayName ?? message.author.username ?? message.author.id;
        const safeAuthorName = authorName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const threadName = `${safeAuthorName || 'user'}-${timestamp}`.slice(0, 100);

        const thread = await (message.channel as TextChannel).threads.create({
          name: threadName,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
          reason: `Mention-triggered thread for ${message.author.id}`,
        });

        deps.threadDb.register(
          thread.id,
          message.channel.id,
          channelInfo.agent_id,
          message.author.id,
        );
        await thread.send(`This thread is bound to <@${message.author.id}>.`);

        const mentionPattern = botRoleId
          ? new RegExp(`<@!?${botUserId}>|<@&${botRoleId}>`, 'g')
          : new RegExp(`<@!?${botUserId}>`, 'g');
        const cleanContent = message.content.replace(mentionPattern, '').trim();
        if (cleanContent || message.attachments.size > 0) {
          const files = [...message.attachments.values()].map((a) => ({
            attachment: a.url,
            name: a.name,
          }));
          const threadMessage = await thread.send({
            content: cleanContent || undefined,
            files: files.length > 0 ? files : undefined,
          });
          deps.enqueue(toIncoming(threadMessage));
        }
      } catch (err) {
        const log = deps.logger?.error ?? console.error;
        log('messageCreate: failed to create thread for mention:', err);
        try {
          await message.reply('❌ Failed to create a thread for this mention.');
        } catch {
          /* reply may fail */
        }
      }
      return;
    }

    const threadInfo = deps.threadDb.get(message.channel.id);
    if (!threadInfo) return;

    const ownerUserId = threadInfo.owner_user_id?.trim();
    if (ownerUserId && ownerUserId !== message.author.id) return;

    if (!deps.isVoiceMessage(message)) {
      deps.enqueue(toIncoming(message));
      return;
    }

    const voiceAttachments = [...message.attachments.values()].filter((attachment) =>
      deps.isVoiceAttachment(attachment),
    );
    if (voiceAttachments.length === 0) {
      deps.enqueue(toIncoming(message));
      return;
    }

    if (!deps.isTranscriberAvailable()) {
      try {
        await message.reply({
          content:
            '⚠️ Voice transcription is currently unavailable (missing ffmpeg, whisper-cli, or model file). Message forwarded without transcription.',
          allowedMentions: { parse: [] },
        });
      } catch {
        /* reply may fail */
      }
      deps.enqueue(toIncoming(message));
      return;
    }

    let reaction: Awaited<ReturnType<typeof message.react>> | undefined;
    try {
      reaction = await message.react('🎧');
    } catch {
      /* reaction failure is non-fatal */
    }

    try {
      const transcriptions: string[] = [];
      for (const attachment of voiceAttachments) {
        const transcription = await deps.transcribeVoiceAttachment(
          discordAttachmentToIncoming(attachment),
        );
        transcriptions.push(
          voiceAttachments.length === 1
            ? transcription
            : `**${escapeMarkdown(attachment.name)}**\n${transcription}`,
        );
      }

      const transcriptionText = transcriptions.join('\n\n');
      const replyResults = await Promise.allSettled(
        deps
          .splitMessage(`🎧 ${transcriptionText}`)
          .map((part) => message.reply({ content: part, allowedMentions: { parse: [] } })),
      );
      const failedReplies = replyResults.filter((result) => result.status === 'rejected');
      if (failedReplies.length > 0) {
        const logWarn = deps.logger?.warn ?? console.warn;
        logWarn(
          `messageCreate: failed to send ${failedReplies.length} transcription reply part(s)`,
        );
      }

      try {
        await reaction?.users.remove(botUserId);
      } catch {
        /* ignore cleanup */
      }

      const contentOverride = [message.content.trim(), transcriptionText]
        .filter(Boolean)
        .join('\n\n');
      const nonVoice = [...message.attachments.values()]
        .filter((attachment) => !deps.isVoiceAttachment(attachment))
        .map(discordAttachmentToIncoming);
      deps.enqueue(toIncoming(message), {
        contentOverride,
        attachmentsOverride: nonVoice,
      });
    } catch (err) {
      try {
        await reaction?.users.remove(botUserId);
      } catch {
        /* ignore cleanup */
      }

      const log = deps.logger?.error ?? console.error;
      log('messageCreate: failed to transcribe voice message:', err);
      try {
        await message.reply({
          content:
            '❌ Failed to transcribe this voice message. Message forwarded without transcription.',
          allowedMentions: { parse: [] },
        });
      } catch (replyErr) {
        const logErr = deps.logger?.error ?? console.error;
        logErr('messageCreate: failed to send transcription error reply:', replyErr);
      }
      deps.enqueue(toIncoming(message));
    }
  };
}
