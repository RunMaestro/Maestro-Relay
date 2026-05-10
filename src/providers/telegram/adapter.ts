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
import { telegramConfig } from './config';

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

    bot.on('message', async () => {
      // TG-03 fills this in.
    });

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
