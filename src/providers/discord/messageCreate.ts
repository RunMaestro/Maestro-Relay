import { Message, TextChannel, ThreadAutoArchiveDuration } from 'discord.js';
import { escapeMarkdown } from '@discordjs/formatters';
import type {
  EnqueueOptions,
  IncomingAttachment,
  IncomingMessage,
  KernelLogger,
} from '../../core/types';
import {
  isTranscriberAvailable,
  transcribeVoiceAttachment,
} from '../../core/transcription';
import { logger as defaultLogger } from '../../core/logger';
import { splitMessage } from '../../core/splitMessage';
import { channelDb } from './channelsDb';
import { threadDb } from './threadsDb';
import { pushedMessagesDb } from './pushedMessagesDb';
import { discordAttachmentToIncoming, isVoiceAttachment, isVoiceMessage } from './voice';

type Enqueue = (msg: IncomingMessage, options?: EnqueueOptions) => void;

export type MessageCreateDeps = {
  channelDb: Pick<typeof channelDb, 'get'>;
  threadDb: Pick<typeof threadDb, 'get' | 'register' | 'adopt'>;
  pushedMessagesDb: Pick<typeof pushedMessagesDb, 'get'>;
  getBotUserId: (message: Message) => string | undefined;
  enqueue: Enqueue;
  isVoiceMessage: typeof isVoiceMessage;
  isVoiceAttachment: typeof isVoiceAttachment;
  transcribeVoiceAttachment: typeof transcribeVoiceAttachment;
  isTranscriberAvailable: typeof isTranscriberAvailable;
  splitMessage: typeof splitMessage;
  logger?: KernelLogger;
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

/**
 * Adopt-on-miss: bind a thread the bridge never created to the agent session
 * that produced the message the thread hangs off.
 *
 * When an agent pushes autonomously (`POST /api/send`) and a human starts a
 * thread on that message to answer it, the thread is unknown to
 * `discord_agent_threads` and the turn used to be dropped on the floor. Discord
 * gives such a thread the *same snowflake as its root message*, so the thread id
 * is a direct key into the push-anchor table: a hit means this thread is a reply
 * to that push, and it is registered on the spot with the pushed message's agent
 * and session. The turn then flows through the normal thread path and lands in
 * the originating session rather than a fresh one.
 *
 * Thread-only by design (v1): an *inline* reply stays in the parent channel, and
 * routing it to the push's session would make the windup session and ordinary
 * channel traffic share one queue key (`core/queue.ts` keys on channel id).
 *
 * Inheriting the push's *session* is gated on the anchor's `owner_user_id`,
 * because continuing a session means reading and extending its context:
 *
 * - replier **is** the anchor's owner → inherit `session_id`, the full
 *   "answer the push" path;
 * - anchor has **no** owner (no `userId` on the push, no configured mention
 *   user) → adopt into a *fresh* session, so the turn still reaches the right
 *   agent but carries none of the pushed session's context;
 * - replier is **someone else** → refuse. The thread stays unbound so its
 *   rightful owner can still claim it, and the bystander keeps the pre-existing
 *   route to the agent: @-mention it in the channel for a session of their own.
 *
 * Without that gate any member able to open a thread on an agent push could
 * take over the referenced session, which is strictly more than the mention
 * path (a fresh session) ever granted them.
 *
 * The adopting thread binds to whoever replied first, matching the ownership
 * rule for mention-created threads. Returns the registered row, or `undefined`
 * when there is no anchor (the normal "unregistered thread" case).
 */
function adoptPushedThread(
  deps: MessageCreateDeps,
  log: KernelLogger,
  message: Message,
): ReturnType<MessageCreateDeps['threadDb']['get']> {
  const threadId = message.channel.id;
  const anchor = deps.pushedMessagesDb.get(threadId);
  if (!anchor) return undefined;

  // A thread's snowflake equals its root message's, so a hit already implies the
  // right channel; assert it anyway rather than binding a thread to an agent
  // channel it does not live under.
  const parentId = (message.channel as { parentId?: string | null }).parentId;
  if (parentId && parentId !== anchor.channel_id) {
    log.warn(
      'messageCreate/adopt',
      `thread ${threadId} parent ${parentId} != anchor channel ${anchor.channel_id}, ignoring`,
    );
    return undefined;
  }

  const anchorOwner = anchor.owner_user_id?.trim() || null;
  if (anchorOwner && anchorOwner !== message.author.id) {
    log.warn(
      'messageCreate/adopt',
      `thread ${threadId} reply from ${message.author.id} != anchor owner ${anchorOwner}, refusing session handover`,
    );
    return undefined;
  }
  // Only a vetted owner inherits the pushed session; an unowned anchor still
  // routes to the agent, but in a session of its own.
  const inheritedSession = anchorOwner ? anchor.session_id : null;

  try {
    deps.threadDb.adopt(
      threadId,
      anchor.channel_id,
      anchor.agent_id,
      message.author.id,
      inheritedSession,
    );
  } catch (err) {
    void log.error('messageCreate/adopt', `failed to adopt thread ${threadId}: ${String(err)}`);
    return undefined;
  }

  log.info(
    'messageCreate/adopt',
    `adopted thread ${threadId} → agent ${anchor.agent_id} session ${inheritedSession ?? 'new'}`,
  );
  // Re-read rather than synthesizing the row: `adopt` is INSERT OR IGNORE, so a
  // concurrent first reply may have won and its binding is the one in force.
  return deps.threadDb.get(threadId);
}

export function createMessageCreateHandler(deps: MessageCreateDeps) {
  const log: KernelLogger = deps.logger ?? defaultLogger;

  return async function handleMessageCreate(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.system) return;
    if (!message.guild) return;

    if (!message.content.trim() && message.attachments.size === 0) return;

    const botUserId = deps.getBotUserId(message);
    if (!botUserId) {
      log.warn('messageCreate', 'bot user ID missing, skipping message handling');
      return;
    }

    if (!message.channel.isThread()) {
      const channelInfo = deps.channelDb.get(message.channel.id);
      if (!channelInfo) {
        log.debug('messageCreate/mention', `channel ${message.channel.id} not registered, ignoring`);
        return;
      }

      const mentionedByUser = message.mentions.users.has(botUserId);
      const botRoleId = message.guild?.members?.me?.roles.botRole?.id;
      const mentionedByRole = !!(botRoleId && message.mentions.roles?.has(botRoleId));
      const mentionedByContent =
        message.content.includes(`<@${botUserId}>`) ||
        message.content.includes(`<@!${botUserId}>`) ||
        (!!botRoleId && message.content.includes(`<@&${botRoleId}>`));
      log.debug(
        'messageCreate/mention',
        `botUserId=${botUserId} botRoleId=${botRoleId} user=${mentionedByUser} role=${mentionedByRole} content=${mentionedByContent} raw=${JSON.stringify(message.content)}`,
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
        await log.error('messageCreate/thread', `failed to create thread for mention: ${String(err)}`);
        try {
          await message.reply('❌ Failed to create a thread for this mention.');
        } catch {
          /* reply may fail */
        }
      }
      return;
    }

    const threadInfo =
      deps.threadDb.get(message.channel.id) ?? adoptPushedThread(deps, log, message);
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
        log.warn(
          'messageCreate/transcription',
          `failed to send ${failedReplies.length} transcription reply part(s)`,
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

      await log.error('messageCreate/transcription', `failed to transcribe voice message: ${String(err)}`);
      try {
        await message.reply({
          content:
            '❌ Failed to transcribe this voice message. Message forwarded without transcription.',
          allowedMentions: { parse: [] },
        });
      } catch (replyErr) {
        await log.error('messageCreate/transcription', `failed to send transcription error reply: ${String(replyErr)}`);
      }
      deps.enqueue(toIncoming(message));
    }
  };
}
