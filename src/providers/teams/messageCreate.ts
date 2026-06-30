import { TeamsActivityHandler, TurnContext } from 'botbuilder';
import type {
  IncomingAttachment,
  IncomingMessage,
  KernelContext,
} from '../../core/types';
import { conversationRefsDb } from './conversationRefsDb';
import { channelDb } from './channelsDb';
import { teamsConfig } from './config';
import { tryHandleCommand } from './commands';

/**
 * Inbound handling for the Microsoft Teams provider (Phase 1, DM/`personal`
 * scope only). This is the Teams analogue of `slack/messageCreate.ts`:
 * translate a platform turn into the kernel's `IncomingMessage` and enqueue it.
 */

/** Structural view of the bits of a Bot Framework activity we consume. */
interface TeamsActivityLike {
  id?: string;
  text?: string;
  serviceUrl?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation: { id: string; tenantId?: string };
  attachments?: Array<{
    contentUrl?: string;
    name?: string;
    contentType?: string;
    /**
     * Teams file-upload attachments (contentType
     * `application/vnd.microsoft.teams.file.download.info`) carry the binary
     * fetch URL here; `contentUrl` points at the SharePoint/OneDrive page.
     */
    content?: { downloadUrl?: string };
  }>;
}

/**
 * Map Teams attachments to the kernel's `IncomingAttachment` shape, skipping
 * entries without a downloadable `contentUrl`. Teams does not report a size on
 * the activity, so `size` is 0 (the attachment downloader treats it as unknown).
 */
export function mapAttachments(
  attachments: TeamsActivityLike['attachments'],
): IncomingAttachment[] {
  if (!attachments) return [];
  const out: IncomingAttachment[] = [];
  for (const att of attachments) {
    // Prefer the file-download URL (uploaded files), falling back to the
    // generic contentUrl for inline/link attachments.
    const url = att.content?.downloadUrl ?? att.contentUrl;
    if (!url) continue;
    out.push({
      url,
      name: att.name ?? '',
      size: 0,
      contentType: att.contentType,
    });
  }
  return out;
}

/**
 * Pure, SDK-free translation of a Teams activity into an `IncomingMessage`.
 * Takes the already-cleaned text (bot @mention stripped, trimmed) so it can be
 * unit-tested without the `botbuilder` runtime.
 */
export function translateActivity(
  activity: TeamsActivityLike,
  content: string,
): IncomingMessage {
  const authorId = activity.from?.aadObjectId ?? activity.from?.id ?? '';
  return {
    provider: 'teams',
    messageId: activity.id ?? activity.conversation.id,
    channelId: activity.conversation.id,
    authorId,
    authorName: activity.from?.name ?? authorId,
    content,
    attachments: mapAttachments(activity.attachments),
    isThread: false,
    raw: activity,
  };
}

/**
 * Bot Framework activity handler. Captures the conversation reference on every
 * turn (so proactive sends in TEAMS-04 can reach the chat), then translates and
 * enqueues user messages bound to a Maestro agent.
 */
export class MaestroTeamsBot extends TeamsActivityHandler {
  constructor(private readonly ctx: KernelContext) {
    super();

    this.onMessage(async (turnCtx, next) => {
      const activity = turnCtx.activity;

      // Phase 1 is DM/`personal` scope only. Group chats and team channels lack
      // the owner/thread isolation that shared contexts need, so ignore them
      // (defense-in-depth — the app manifest also only requests `personal`).
      const convType = activity.conversation?.conversationType;
      if (convType && convType !== 'personal') {
        await next();
        return;
      }

      // Always refresh the stored conversation reference.
      conversationRefsDb.upsert(
        activity.conversation.id,
        TurnContext.getConversationReference(activity),
        activity.serviceUrl,
        activity.conversation.tenantId ?? null,
      );

      const text = (
        TurnContext.removeRecipientMention(activity) ??
        activity.text ??
        ''
      ).trim();
      if (!text) {
        await next();
        return;
      }

      const userId =
        activity.from?.aadObjectId ?? activity.from?.id ?? '';

      if (await tryHandleCommand(turnCtx, text, userId)) {
        await next();
        return;
      }

      const binding = channelDb.get(activity.conversation.id);
      if (!binding) {
        await turnCtx.sendActivity(
          'This chat is not bound to a Maestro agent yet. Type `agents list` then `agents new <agent-id>`.',
        );
        await next();
        return;
      }

      const allowed = teamsConfig.allowedUserIds;
      if (allowed.length > 0 && !allowed.includes(userId)) {
        await next();
        return;
      }

      const message = translateActivity(
        activity as unknown as TeamsActivityLike,
        text,
      );
      this.ctx.enqueue(message);

      await next();
    });

    this.onMembersAdded(async (turnCtx, next) => {
      const activity = turnCtx.activity;
      conversationRefsDb.upsert(
        activity.conversation.id,
        TurnContext.getConversationReference(activity),
        activity.serviceUrl,
        activity.conversation.tenantId ?? null,
      );
      await turnCtx.sendActivity(
        'Maestro Relay is connected. Type `agents list` to begin.',
      );
      await next();
    });
  }
}
