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
  const url = await fileUrl(bot, msg.voice.file_id);
  return {
    url,
    name: `voice-${msg.message_id}.ogg`,
    size: msg.voice.file_size ?? 0,
    contentType: msg.voice.mime_type ?? 'audio/ogg',
  };
}

export async function attachmentsFromMessage(
  bot: Bot,
  msg: TelegramMessage,
): Promise<IncomingAttachment[]> {
  const attachments: IncomingAttachment[] = [];

  if (msg.document) {
    const url = await fileUrl(bot, msg.document.file_id);
    attachments.push({
      url,
      name: msg.document.file_name ?? `document-${msg.message_id}`,
      size: msg.document.file_size ?? 0,
      contentType: msg.document.mime_type,
    });
  }

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo.reduce((a, b) =>
      (a.file_size ?? a.width * a.height) >= (b.file_size ?? b.width * b.height) ? a : b,
    );
    const url = await fileUrl(bot, largest.file_id);
    attachments.push({
      url,
      name: `photo-${msg.message_id}.jpg`,
      size: largest.file_size ?? 0,
      contentType: 'image/jpeg',
    });
  }

  if (msg.audio) {
    const url = await fileUrl(bot, msg.audio.file_id);
    attachments.push({
      url,
      name: msg.audio.file_name ?? `audio-${msg.message_id}`,
      size: msg.audio.file_size ?? 0,
      contentType: msg.audio.mime_type ?? 'audio/mpeg',
    });
  }

  if (msg.video) {
    const url = await fileUrl(bot, msg.video.file_id);
    attachments.push({
      url,
      name: msg.video.file_name ?? `video-${msg.message_id}.mp4`,
      size: msg.video.file_size ?? 0,
      contentType: msg.video.mime_type ?? 'video/mp4',
    });
  }

  return attachments;
}
