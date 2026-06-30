import { Bot } from 'grammy';
import type { ReactionTypeEmoji } from 'grammy/types';
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
import {
  isTranscriberAvailable,
  transcribeVoiceAttachment,
} from '../../core/transcription';
import { splitMessage } from '../../core/splitMessage';
import { channelDb as coreChannelDb } from '../../core/db';
import { maestro } from '../../core/maestro';
import { telegramConfig } from './config';
import { createMessageHandler } from './messageHandler';
import { topicDb } from './topicsDb';
import {
  attachmentsFromMessage,
  downloadVoice,
  isVoiceMessage,
} from './voice';

function parseChannelId(channelId: string): { chatId: string; threadId?: number } {
  const [chatId, topicStr] = channelId.split(':');
  if (!topicStr || !/^-?\d+$/.test(topicStr)) return { chatId };
  const threadId = Number(topicStr);
  if (!Number.isFinite(threadId)) return { chatId };
  return { chatId, threadId };
}

export class TelegramProvider implements BridgeProvider {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private ctx: KernelContext | null = null;
  private ready = false;
  private chatMode: 'forum' | 'dm' = 'dm';
  private agentNameCache = new Map<string, string>();

  async start(ctx: KernelContext): Promise<void> {
    this.ctx = ctx;
    const token = telegramConfig.token;
    const chatId = telegramConfig.chatId;
    const agentId = telegramConfig.agentId;

    const bot = new Bot(token);
    this.bot = bot;

    await bot.init();
    console.log(
      `[telegram] connected as @${bot.botInfo.username} (bound to agent ${agentId}, chat ${chatId})`,
    );

    const chat = await bot.api.getChat(chatId);
    this.chatMode =
      chat.type === 'supergroup' && chat.is_forum ? 'forum' : 'dm';
    console.log(`[telegram] chat mode: ${this.chatMode}`);
    if (this.chatMode === 'dm') {
      console.log(
        '[telegram] tip: enable forum topics on a supergroup for topic-per-session UX',
      );
    }

    const existing = coreChannelDb.get('telegram', chatId);
    if (!existing || existing.agent_id !== agentId) {
      let agentName = agentId;
      try {
        const agents = await maestro.listAgents();
        const match = agents.find((a) => a.id === agentId);
        if (match?.name) agentName = match.name;
      } catch (err) {
        console.warn(
          `[telegram] could not resolve agent name from maestro-cli; falling back to agent id (${(err as Error).message})`,
        );
      }
      if (existing && existing.agent_id !== agentId) {
        console.warn(
          `[telegram] bound channel ${chatId} was registered to agent ${existing.agent_id}; ` +
            `reconciling to ${agentId} (TELEGRAM_AGENT_ID changed). Forum topics from the previous binding are left in place but will no longer resolve.`,
        );
        coreChannelDb.remove('telegram', chatId);
      }
      coreChannelDb.register('telegram', chatId, agentId, agentName);
      console.log(
        `[telegram] registered bound channel ${chatId} → agent ${agentName} (${agentId})`,
      );
    }

    const handler = createMessageHandler({
      bot,
      boundChatId: chatId,
      boundAgentId: agentId,
      chatMode: this.chatMode,
      resolveAgentName: async () => (await this.resolveAgentName(agentId)) ?? agentId,
      allowedUserIds: telegramConfig.allowedUserIds,
      enqueue: (msg) => ctx.enqueue(msg),
      isVoiceMessage,
      downloadVoice,
      attachmentsFromMessage,
      transcribeVoiceAttachment,
      isTranscriberAvailable,
      logger: console,
    });
    bot.on('message', handler);

    // Long-polling runs forever; don't await, but surface failures.
    bot
      .start({
        onStart: () => {
          this.ready = true;
        },
      })
      .catch((err) => {
        this.ready = false;
        console.error('[telegram] long-polling stopped with error:', err);
      });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  resolveConversation(message: IncomingMessage): ConversationRecord | null {
    const { chatId, threadId } = parseChannelId(message.channelId);
    if (chatId !== telegramConfig.chatId) return null;

    if (this.chatMode === 'forum') {
      if (threadId === undefined) return null;
      const row = topicDb.get(chatId, threadId);
      if (!row) return null;
      return {
        agentId: row.agent_id,
        sessionId: row.session_id,
        readOnly: false,
        persistSession: (sid) => topicDb.updateSession(chatId, threadId, sid),
      };
    }

    const row = coreChannelDb.get('telegram', chatId);
    if (!row) return null;
    return {
      agentId: row.agent_id,
      sessionId: row.session_id,
      readOnly: row.read_only === 1,
      persistSession: (sid) => coreChannelDb.updateSession('telegram', chatId, sid),
    };
  }

  async send(target: ChannelTarget, msg: OutgoingMessage): Promise<void> {
    if (!this.bot) throw new Error('telegram bot not started');
    const { chatId, threadId } = parseChannelId(target.channelId);

    let text = msg.text;
    if (msg.mention && telegramConfig.mentionUserId) {
      text = `[mention requested for user ${telegramConfig.mentionUserId}]\n${text}`;
    }

    const parts = splitMessage(text, 4096);
    for (const part of parts) {
      await this.bot.api.sendMessage(
        chatId,
        part,
        threadId ? { message_thread_id: threadId } : {},
      );
    }
  }

  async findOrCreateAgentChannel(agentId: string): Promise<AgentChannelInfo> {
    if (!this.bot) throw new Error('telegram bot not started');
    if (agentId !== telegramConfig.agentId) {
      throw new Error(
        `Telegram bot is bound to agent ${telegramConfig.agentId}; cannot serve agent ${agentId}. ` +
          `Run a separate bridge instance for that agent.`,
      );
    }

    const agentName = (await this.resolveAgentName(agentId)) ?? agentId;

    if (this.chatMode === 'forum') {
      // Use the oldest topic for this agent *in the currently bound chat* as
      // the stable "default", or create one if none exist. Scoping to
      // telegramConfig.chatId prevents a stale row from a previous
      // TELEGRAM_CHAT_ID binding from being combined with the new chat id,
      // which would yield a (currentChat, oldTopicId) pair that doesn't
      // exist on Telegram.
      const topics = topicDb.getByAgentIdInChat(telegramConfig.chatId, agentId);
      let topicId: number;
      if (topics.length === 0) {
        const created = await this.bot.api.createForumTopic(
          telegramConfig.chatId,
          `${agentName} (default)`,
        );
        topicId = created.message_thread_id;
        topicDb.register(topicId, telegramConfig.chatId, agentId);
      } else {
        topicId = topics[0].topic_id;
      }
      return {
        channelId: `${telegramConfig.chatId}:${topicId}`,
        agentId,
        agentName,
      };
    }

    return {
      channelId: telegramConfig.chatId,
      agentId,
      agentName,
    };
  }

  private async resolveAgentName(agentId: string): Promise<string | null> {
    const cached = this.agentNameCache.get(agentId);
    if (cached) return cached;
    try {
      const agents = await maestro.listAgents();
      const match = agents.find((a) => a.id === agentId);
      if (match?.name) {
        this.agentNameCache.set(agentId, match.name);
        return match.name;
      }
      return null;
    } catch (err) {
      console.warn(
        `[telegram] resolveAgentName: maestro-cli unavailable (${(err as Error).message})`,
      );
      return null;
    }
  }

  async react(target: MessageTarget, emoji: string): Promise<ReactionHandle> {
    if (!this.bot) throw new Error('telegram bot not started');
    const { chatId } = parseChannelId(target.channelId);
    const messageId = Number(target.messageId);
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ]);
    } catch (err) {
      console.warn(`[telegram] setMessageReaction(${emoji}) failed:`, err);
    }
    return {
      remove: async () => {
        try {
          await this.bot!.api.setMessageReaction(chatId, messageId, []);
        } catch {
          /* gentle degradation */
        }
      },
    };
  }

  async sendTyping(target: ChannelTarget): Promise<void> {
    if (!this.bot) return;
    const { chatId, threadId } = parseChannelId(target.channelId);
    try {
      await this.bot.api.sendChatAction(
        chatId,
        'typing',
        threadId ? { message_thread_id: threadId } : {},
      );
    } catch {
      // best-effort; typing indicator is non-critical
    }
  }
}
