import type { Bot } from 'grammy';

export interface TelegramCommandContext {
  bot: Bot;
  chatId: string;
  threadId?: number;
  fromUserId: string;
  args: string[];
  rawText: string;
  boundAgentId: string;
  boundAgentName: string;
  chatMode: 'forum' | 'dm';
  reply: (text: string) => Promise<void>;
}

export interface TelegramCommandModule {
  command: string;
  description: string;
  execute: (ctx: TelegramCommandContext) => Promise<void>;
}
