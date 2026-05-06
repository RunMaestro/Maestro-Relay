import { MessageFlags } from 'discord.js';
import type { Attachment, Message } from 'discord.js';
import { isVoiceContentType } from '../../core/transcription';
import type { IncomingAttachment } from '../../core/types';

/** Discord-specific: only treat a message as voice when the IsVoiceMessage flag is set. */
export function isVoiceMessage(message: Pick<Message, 'flags'>): boolean {
  return !!message.flags?.has(MessageFlags.IsVoiceMessage);
}

/** Discord-specific: filter to attachments that look like Discord voice payloads. */
export function isVoiceAttachment(attachment: Attachment): boolean {
  return isVoiceContentType(attachment.contentType ?? undefined, attachment.name);
}

export function discordAttachmentToIncoming(attachment: Attachment): IncomingAttachment {
  return {
    url: attachment.url,
    name: attachment.name,
    size: attachment.size,
    contentType: attachment.contentType ?? undefined,
  };
}
