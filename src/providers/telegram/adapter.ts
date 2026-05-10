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
import {
  attachmentsFromMessage,
  downloadVoice,
  isVoiceMessage,
} from './voice';

function parseChannelId(channelId: string): { chatId: string; threadId?: number } {
  const [chatId, topicStr] = channelId.split(':');
  return topicStr ? { chatId, threadId: Number(topicStr) } : { chatId };
}

export class TelegramProvider implements BridgeProvider {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private ctx: KernelContext | null = null;
  private ready = false;
  private chatMode: 'forum' | 'dm' = 'dm';

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

    if (!coreChannelDb.get('telegram', chatId)) {
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
      coreChannelDb.register('telegram', chatId, agentId, agentName);
      console.log(
        `[telegram] registered bound channel ${chatId} → agent ${agentName} (${agentId})`,
      );
    }

    const handler = createMessageHandler({
      bot,
      boundChatId: chatId,
      boundAgentId: agentId,
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

    // Long-polling runs forever; do not await.
    void bot.start({
      onStart: () => {
        this.ready = true;
      },
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

  resolveConversation(_message: IncomingMessage): ConversationRecord | null {
    throw new Error('not implemented in TG-02');
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

  async findOrCreateAgentChannel(_agentId: string): Promise<AgentChannelInfo> {
    throw new Error('not implemented in TG-02');
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
