import { App, ExpressReceiver, SocketModeReceiver } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type {
  AgentChannelInfo,
  BridgeProvider,
  ChannelTarget,
  ConversationRecord,
  IncomingMessage,
  KernelContext,
  MessageTarget,
  OutgoingMessage,
  ReactionHandle,
} from '../../core/types';
import { maestro } from '../../core/maestro';
import { logger } from '../../core/logger';
import { slackConfig } from './config';
import { channelDb } from './channelsDb';
import { conversationDb } from './conversationsDb';
import { createMessageHandler } from './messageCreate';
import * as health from './commands/health';
import * as agents from './commands/agents';
import * as session from './commands/session';

const UNICODE_TO_SLACK: Record<string, string> = {
  '⏳': 'hourglass_flowing_sand',
  '🎧': 'headphones',
  '✅': 'white_check_mark',
  '❌': 'x',
};

export function toSlackEmojiName(emoji: string): string {
  return UNICODE_TO_SLACK[emoji] ?? emoji;
}

/** Matches a Slack message timestamp: digits.digits */
export function isThreadTs(id: string): boolean {
  return /^\d+\.\d+$/.test(id);
}

/**
 * Build a Slack channel name for an agent.
 *
 * Format: `maestro-<sanitized-name>-<id-prefix>` capped at 80 chars.
 * The id-prefix (8 alphanumeric chars from agent.id) is what makes the
 * name unique — without it, two agents whose names normalize to the
 * same string would collapse to the same channel.
 */
export function buildAgentChannelName(agent: { id: string; name: string }): string {
  const sanitizedName = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
  const baseName = sanitizedName || 'agent';
  const idPrefix = agent.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const suffix = idPrefix ? `-${idPrefix}` : '';
  return `maestro-${baseName}${suffix}`.slice(0, 80);
}

/**
 * Build a fallback channel name when unarchive fails.
 *
 * Reserves space for the timestamp suffix BEFORE concatenation so a
 * full-length 80-char base doesn't have its suffix sliced away — that
 * would re-collide with the original name and trigger another
 * `name_taken`.
 */
export function buildFallbackChannelName(base: string, now: number = Date.now()): string {
  const suffix = `-${now.toString().slice(-6)}`;
  const maxBase = 80 - suffix.length;
  return `${base.slice(0, maxBase)}${suffix}`;
}

/** Slack `conversations.list` page shape we actually consume. */
type ConversationsListPage = {
  channels?: Array<{ id?: string; name?: string; is_archived?: boolean }>;
  response_metadata?: { next_cursor?: string };
};
type ConversationsLister = (args: { cursor?: string }) => Promise<ConversationsListPage>;

/**
 * Walk every page of `conversations.list` looking for a channel with
 * the given name. Workspaces with >1000 public channels would
 * otherwise miss matches on later pages and surface as `name_taken`
 * on create.
 */
export async function findChannelByName(
  list: ConversationsLister,
  name: string,
): Promise<{ id: string; is_archived: boolean } | null> {
  let cursor: string | undefined;
  do {
    const res = await list({ cursor });
    const match = res.channels?.find((ch) => ch.name === name);
    if (match?.id) {
      return { id: match.id, is_archived: !!match.is_archived };
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return null;
}

/**
 * Look up an existing Slack channel for an agent or create a fresh one.
 * Returns `{ channelId, isNew }`. If the channel exists but is archived,
 * tries to unarchive; if that fails, creates a new channel with a
 * `-<timestamp>` suffix to avoid `name_taken`.
 */
export async function findOrCreateSlackChannel(
  client: WebClient,
  agent: { id: string; name: string },
): Promise<{ channelId: string; isNew: boolean }> {
  const channelName = buildAgentChannelName(agent);

  let existing: { id: string; is_archived: boolean } | null = null;
  try {
    existing = await findChannelByName(
      (args) =>
        client.conversations.list({
          exclude_archived: false,
          types: 'public_channel',
          limit: 1000,
          cursor: args.cursor,
        }) as Promise<ConversationsListPage>,
      channelName,
    );
  } catch {
    // ignore — will fall through to create
  }

  if (existing && existing.is_archived) {
    try {
      await client.conversations.unarchive({ channel: existing.id });
      return { channelId: existing.id, isNew: false };
    } catch {
      // Unarchive failed (e.g. permissions, channel locked). Fall back
      // to a fresh timestamped channel — same trick the slash command
      // uses, mirrored here so HTTP-API-driven flows behave the same.
      const fallbackName = buildFallbackChannelName(channelName);
      const res = await client.conversations.create({
        name: fallbackName,
        is_private: false,
      });
      if (!res.channel?.id) {
        throw new Error(`Failed to create Slack channel for agent ${agent.id}`);
      }
      return { channelId: res.channel.id, isNew: true };
    }
  }

  if (existing) {
    return { channelId: existing.id, isNew: false };
  }

  const res = await client.conversations.create({ name: channelName, is_private: false });
  if (!res.channel?.id) {
    throw new Error(`Failed to create Slack channel for agent ${agent.id}`);
  }
  return { channelId: res.channel.id, isNew: true };
}

export class SlackProvider implements BridgeProvider {
  readonly name = 'slack';
  private app: App | null = null;
  private client: WebClient | null = null;
  private started = false;
  private pendingChannels = new Map<string, Promise<AgentChannelInfo>>();

  async start(ctx: KernelContext): Promise<void> {
    const socketModeToken = slackConfig.socketModeToken;
    let receiver: SocketModeReceiver | ExpressReceiver;

    if (socketModeToken) {
      receiver = new SocketModeReceiver({ appToken: socketModeToken });
    } else {
      receiver = new ExpressReceiver({
        signingSecret: slackConfig.signingSecret,
      });
    }

    const app = new App({
      token: slackConfig.token,
      receiver,
    });
    this.app = app;
    this.client = new WebClient(slackConfig.token);

    const handleMessage = createMessageHandler(ctx);

    // message events (thread replies only)
    app.event('message', async ({ event }) => {
      await handleMessage({ event: event as unknown as Record<string, unknown> });
    });

    // app_mention creates a new conversation thread
    app.event('app_mention', async ({ event, say }) => {
      const eventData = event as unknown as Record<string, unknown>;
      const text = String(eventData['text'] ?? '');
      const rawUser = eventData['user'];
      const channel = String(eventData['channel'] ?? '');

      if (!rawUser || typeof rawUser !== 'string') {
        await say('Could not identify the user. Please try again.');
        return;
      }
      const user = rawUser;

      const allowed = slackConfig.allowedUserIds;
      if (allowed.length > 0 && !allowed.includes(user)) {
        return;
      }

      const channelInfo = channelDb.get(channel);
      if (!channelInfo) {
        await say('This channel is not registered with an agent. Use `/agents new <agent-id>` to register one.');
        return;
      }

      // Strip all Slack user mentions before forwarding to the agent.
      // The bot's own mention is the trigger that brought us here, and
      // other users' mentions would just surface as opaque <@U123> tokens
      // to the agent — Slack still notifies those users via the original
      // message, so dropping them from the agent-bound text is safe.
      const cleanText = text.replace(/<@[^>]+>/g, '').trim();
      if (!cleanText) {
        await say('I received your mention, but no message. Please include a message.');
        return;
      }

      try {
        const result = await this.client!.chat.postMessage({
          channel,
          text: cleanText,
        });

        if (!result.ts) {
          await say('Failed to create conversation thread.');
          return;
        }

        const threadTs = result.ts;
        conversationDb.register(threadTs, channel, channelInfo.agent_id, user);

        // Enqueue the initial message from the mention
        const message: IncomingMessage = {
          provider: 'slack',
          messageId: threadTs,
          channelId: threadTs,
          authorId: user,
          authorName: user,
          content: cleanText,
          attachments: [],
          isThread: true,
          raw: eventData,
        };
        ctx.enqueue(message);
      } catch (err) {
        void logger.error('slack/app_mention', String(err));
        await say('Failed to create conversation thread.');
      }
    });

    // slash commands
    app.command('/health', async (args) => { await health.handle(args); });
    app.command('/agents', async (args) => { await agents.handle(args); });
    app.command('/session', async (args) => { await session.handle(args); });

    if (socketModeToken) {
      await app.start();
    } else {
      await app.start(slackConfig.port);
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this.client = null;
      this.started = false;
    }
  }

  isReady(): boolean {
    return this.started;
  }

  resolveConversation(message: IncomingMessage): ConversationRecord | null {
    if (message.isThread) {
      // channelId is the thread_ts for Slack thread messages
      const convo = conversationDb.get(message.channelId);
      if (!convo) return null;
      const channelInfo = channelDb.get(convo.channel_id);
      return {
        agentId: convo.agent_id,
        sessionId: convo.session_id ?? null,
        readOnly: !!(channelInfo?.read_only),
        persistSession: (sessionId: string) =>
          conversationDb.updateSession(message.channelId, sessionId),
      };
    }

    const channelInfo = channelDb.get(message.channelId);
    if (!channelInfo) return null;
    return {
      agentId: channelInfo.agent_id,
      sessionId: channelInfo.session_id ?? null,
      readOnly: !!channelInfo.read_only,
      persistSession: (sessionId: string) =>
        channelDb.updateSession(message.channelId, sessionId),
    };
  }

  async send(target: ChannelTarget, msg: OutgoingMessage): Promise<void> {
    if (!this.client) throw new Error('Slack client not initialised');

    let text = msg.text;
    if (msg.mention && slackConfig.mentionUserId) {
      text = `<@${slackConfig.mentionUserId}> ${text}`;
    }

    if (isThreadTs(target.channelId)) {
      // target is a thread_ts — look up parent channel
      const convo = conversationDb.get(target.channelId);
      if (!convo) {
        // The thread is orphaned — its row was likely removed when the
        // bound channel was disconnected, or the DB was reset. Log the
        // mismatch specifically so operators can distinguish it from
        // generic Slack/network errors before surfacing to the kernel.
        void logger.error('slack/send:orphan-thread', `thread_ts=${target.channelId}`);
        throw new Error(`No conversation found for thread_ts ${target.channelId}`);
      }
      await this.client.chat.postMessage({
        channel: convo.channel_id,
        thread_ts: target.channelId,
        text,
      });
    } else {
      await this.client.chat.postMessage({ channel: target.channelId, text });
    }
  }

  async react(target: MessageTarget, emoji: string): Promise<ReactionHandle> {
    if (!this.client) throw new Error('Slack client not initialised');

    // Resolve channel: target.channelId may be a thread_ts or a channel ID
    let channel: string;
    let timestamp: string;

    if (isThreadTs(target.channelId)) {
      const convo = conversationDb.get(target.channelId);
      if (!convo) {
        void logger.error('slack/react:orphan-thread', `thread_ts=${target.channelId}`);
        throw new Error(`No conversation found for thread_ts ${target.channelId}`);
      }
      channel = convo.channel_id;
      timestamp = target.messageId;
    } else {
      channel = target.channelId;
      timestamp = target.messageId;
    }

    const name = toSlackEmojiName(emoji);
    await this.client.reactions.add({ channel, timestamp, name });

    return {
      remove: async () => {
        if (!this.client) return;
        await this.client.reactions.remove({ channel, timestamp, name });
      },
    };
  }

  // Slack does not expose a per-user typing indicator via the Web API
  async sendTyping(_target: ChannelTarget): Promise<void> {
    // no-op
  }

  async findOrCreateAgentChannel(agentId: string): Promise<AgentChannelInfo> {
    const existing = channelDb.getByAgentId(agentId);
    if (existing) {
      return {
        channelId: existing.channel_id,
        agentId: existing.agent_id,
        agentName: existing.agent_name,
      };
    }

    const pending = this.pendingChannels.get(agentId);
    if (pending) return pending;

    const promise = (async () => {
      if (!this.client) throw new Error('Slack client not initialised');

      const allAgents = await maestro.listAgents();
      const agent = allAgents.find((a) => a.id === agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);

      const { channelId } = await findOrCreateSlackChannel(this.client, agent);
      channelDb.register(channelId, agent.id, agent.name);
      return { channelId, agentId: agent.id, agentName: agent.name };
    })();

    this.pendingChannels.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.pendingChannels.delete(agentId);
    }
  }
}
