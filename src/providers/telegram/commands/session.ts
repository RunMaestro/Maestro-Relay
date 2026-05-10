import { maestro, MaestroSession } from '../../../core/maestro';
import { channelDb as coreChannelDb } from '../../../core/db';
import { topicDb } from '../topicsDb';
import type { TelegramCommandContext } from './types';

export const command = 'session';
export const description = 'Manage agent sessions (new, list)';

export async function execute(ctx: TelegramCommandContext): Promise<void> {
  const sub = ctx.args[0] ?? 'list';

  if (sub === 'new') {
    await handleNew(ctx);
    return;
  }
  if (sub === 'list') {
    await handleList(ctx);
    return;
  }

  await ctx.reply(
    'Usage: /session [new|list]\n' +
      '• new — start a fresh session (forum: new topic; dm: clears current session)\n' +
      '• list — list known sessions for the bound agent',
  );
}

async function handleNew(ctx: TelegramCommandContext): Promise<void> {
  if (ctx.chatMode === 'forum') {
    const topicName = `${ctx.boundAgentName} session ${new Date()
      .toISOString()
      .slice(0, 16)}`;
    const created = await ctx.bot.api.createForumTopic(ctx.chatId, topicName);
    topicDb.register(created.message_thread_id, ctx.chatId, ctx.boundAgentId);
    await ctx.bot.api.sendMessage(
      ctx.chatId,
      'Started a new session in this topic. Send a message to begin.',
      { message_thread_id: created.message_thread_id },
    );
    return;
  }

  coreChannelDb.updateSession('telegram', ctx.chatId, null);
  await ctx.reply('Started a new session. Send a message to begin.');
}

async function handleList(ctx: TelegramCommandContext): Promise<void> {
  let maestroSessions: MaestroSession[] = [];
  try {
    maestroSessions = await maestro.listSessions(ctx.boundAgentId);
  } catch {
    // fall through with empty list
  }
  const sessionMap = new Map<string, MaestroSession>(
    maestroSessions.map((s) => [s.sessionId, s]),
  );

  if (ctx.chatMode === 'forum') {
    const topics = topicDb.listByChat(ctx.chatId);
    if (topics.length === 0) {
      await ctx.reply('No session topics yet. Use /session new to create one.');
      return;
    }
    const lines = topics.map((t) => {
      const info = sessionMap.get(t.session_id ?? '');
      const shortId = t.session_id ? t.session_id.slice(0, 8) : 'no session yet';
      const stats = info
        ? `${info.messageCount} msgs · $${info.costUsd.toFixed(4)} · ${new Date(
            info.modifiedAt,
          ).toLocaleDateString()}`
        : 'No messages yet';
      return `topic ${t.topic_id} — ${shortId} · ${stats}`;
    });
    await ctx.reply(`Sessions — ${ctx.boundAgentName}\n${lines.join('\n')}`);
    return;
  }

  // DM mode: single shared session
  const row = coreChannelDb.get('telegram', ctx.chatId);
  if (!row?.session_id) {
    await ctx.reply(
      `Single shared session for ${ctx.boundAgentName}. ` +
        `No session yet — send a message to start one.`,
    );
    return;
  }
  const info = sessionMap.get(row.session_id);
  const shortId = row.session_id.slice(0, 8);
  const stats = info
    ? `${info.messageCount} msgs · $${info.costUsd.toFixed(4)} · ${new Date(
        info.modifiedAt,
      ).toLocaleDateString()}`
    : 'No stats available';
  await ctx.reply(
    `Single shared session for ${ctx.boundAgentName}.\n${shortId} · ${stats}`,
  );
}
