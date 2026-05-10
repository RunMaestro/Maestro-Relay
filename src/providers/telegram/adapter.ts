import { Bot } from 'grammy';
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
import { telegramConfig } from './config';
import { createMessageHandler } from './messageHandler';
import {
  attachmentsFromMessage,
  downloadVoice,
  isVoiceMessage,
} from './voice';

export class TelegramProvider implements BridgeProvider {
  readonly name = 'telegram';
  private bot: Bot | null = null;
  private ctx: KernelContext | null = null;
  private ready = false;

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

  async send(_target: ChannelTarget, _msg: OutgoingMessage): Promise<void> {
    throw new Error('not implemented in TG-02');
  }

  async findOrCreateAgentChannel(_agentId: string): Promise<AgentChannelInfo> {
    throw new Error('not implemented in TG-02');
  }

  async react(_target: MessageTarget, _emoji: string): Promise<ReactionHandle> {
    return { remove: async () => {} };
  }

  async sendTyping(_target: ChannelTarget): Promise<void> {
    return;
  }
}
