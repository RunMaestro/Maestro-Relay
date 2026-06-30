import type { Bot } from 'grammy';
import type { Message as TelegramMessage } from 'grammy/types';
import type { IncomingAttachment } from '../../core/types';

/** Telegram-specific: a message is a voice message when the `voice` field is present. */
export function isVoiceMessage(msg: Pick<TelegramMessage, 'voice'>): boolean {
  return !!msg.voice;
}

async function fileUrl(bot: Bot, fileId: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error(`Telegram file ${fileId} returned no file_path`);
  }
  return `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
}

export async function downloadVoice(
  bot: Bot,
  msg: TelegramMessage,
): Promise<IncomingAttachment> {
  if (!msg.voice) {
    throw new Error('downloadVoice called on a message without a voice payload');
  }
  // Voice is consumed immediately by transcribeVoiceAttachment in the
  // messageHandler (before enqueue), so pre-resolving the URL is fine.
  const url = await fileUrl(bot, msg.voice.file_id);
  return {
    url,
    name: `voice-${msg.message_id}.ogg`,
    size: msg.voice.file_size ?? 0,
    contentType: msg.voice.mime_type ?? 'audio/ogg',
  };
}

/**
 * Build a deferred-URL `IncomingAttachment` for a Telegram file. The actual
 * `getFile` call is delayed until the kernel's `downloadAttachments` runs
 * via the `resolveUrl` callback. This avoids using a stale URL when the
 * per-conversation queue is backlogged behind long agent runs (Telegram
 * getFile URLs are only valid for ~1h).
 */
function lazyTelegramAttachment(
  bot: Bot,
  fileId: string,
  name: string,
  size: number,
  contentType: string | undefined,
): IncomingAttachment {
  return {
    url: '',
    name,
    size,
    contentType,
    resolveUrl: () => fileUrl(bot, fileId),
  };
}

export function attachmentsFromMessage(
  bot: Bot,
  msg: TelegramMessage,
): IncomingAttachment[] {
  const attachments: IncomingAttachment[] = [];

  if (msg.document) {
    attachments.push(
      lazyTelegramAttachment(
        bot,
        msg.document.file_id,
        msg.document.file_name ?? `document-${msg.message_id}`,
        msg.document.file_size ?? 0,
        msg.document.mime_type,
      ),
    );
  }

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo.reduce((a, b) =>
      (a.file_size ?? a.width * a.height) >= (b.file_size ?? b.width * b.height) ? a : b,
    );
    attachments.push(
      lazyTelegramAttachment(
        bot,
        largest.file_id,
        `photo-${msg.message_id}.jpg`,
        largest.file_size ?? 0,
        'image/jpeg',
      ),
    );
  }

  if (msg.audio) {
    attachments.push(
      lazyTelegramAttachment(
        bot,
        msg.audio.file_id,
        msg.audio.file_name ?? `audio-${msg.message_id}`,
        msg.audio.file_size ?? 0,
        msg.audio.mime_type ?? 'audio/mpeg',
      ),
    );
  }

  if (msg.video) {
    attachments.push(
      lazyTelegramAttachment(
        bot,
        msg.video.file_id,
        msg.video.file_name ?? `video-${msg.message_id}.mp4`,
        msg.video.file_size ?? 0,
        msg.video.mime_type ?? 'video/mp4',
      ),
    );
  }

  return attachments;
}
