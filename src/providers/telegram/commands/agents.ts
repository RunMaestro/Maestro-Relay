import { maestro } from '../../../core/maestro';
import type { TelegramCommandContext } from './types';

export const command = 'agents';
export const description = 'Show the bound agent and its details';

const BOUND_NOTICE =
  'This Telegram bot is bound to a single agent at install time. ' +
  'To bind a different agent, run a separate bridge instance.';

export async function execute(ctx: TelegramCommandContext): Promise<void> {
  const sub = ctx.args[0] ?? 'list';

  if (sub === 'list') {
    await handleList(ctx);
    return;
  }
  if (sub === 'show') {
    await handleShow(ctx);
    return;
  }
  if (sub === 'new' || sub === 'disconnect' || sub === 'readonly') {
    await ctx.reply(
      `⚠️ /agents ${sub} is not supported on Telegram.\n${BOUND_NOTICE}`,
    );
    return;
  }

  await ctx.reply(
    'Usage: /agents [list|show]\n' +
      '• list — show the bound agent\n' +
      '• show — show details, stats, recent activity',
  );
}

async function handleList(ctx: TelegramCommandContext): Promise<void> {
  let agents;
  try {
    agents = await maestro.listAgents();
  } catch (err) {
    await ctx.reply(`❌ Could not list agents: ${(err as Error).message}`);
    return;
  }

  const bound = agents.find((a) => a.id === ctx.boundAgentId);
  if (!bound) {
    await ctx.reply(
      `Bound agent ${ctx.boundAgentName} (${ctx.boundAgentId}) ` +
        `was not returned by maestro-cli list agents.\n${BOUND_NOTICE}`,
    );
    return;
  }

  await ctx.reply(
    `Bound agent: ${bound.name}\n` +
      `id: ${bound.id}\n` +
      `tool: ${bound.toolType}\n` +
      `cwd: ${bound.cwd}\n\n` +
      BOUND_NOTICE,
  );
}

async function handleShow(ctx: TelegramCommandContext): Promise<void> {
  let detail;
  try {
    detail = await maestro.showAgent(ctx.boundAgentId);
  } catch (err) {
    await ctx.reply(`❌ Could not load agent: ${(err as Error).message}`);
    return;
  }

  const lines: string[] = [
    `Agent: ${detail.name}`,
    `id: ${detail.id}`,
    `tool: ${detail.toolType}`,
    `cwd: ${detail.cwd}`,
  ];
  if (detail.groupName) lines.push(`group: ${detail.groupName}`);

  const stats = detail.stats;
  if (stats) {
    const statLines: string[] = [];
    if (typeof stats.historyEntries === 'number') {
      const ok = stats.successCount ?? 0;
      const fail = stats.failureCount ?? 0;
      statLines.push(`History: ${stats.historyEntries} entries (${ok} ok · ${fail} failed)`);
    }
    if (
      typeof stats.totalInputTokens === 'number' ||
      typeof stats.totalOutputTokens === 'number'
    ) {
      statLines.push(
        `Tokens: ${stats.totalInputTokens ?? 0}↓ ${stats.totalOutputTokens ?? 0}↑`,
      );
    }
    if (typeof stats.totalCost === 'number' && stats.totalCost > 0) {
      statLines.push(`Cost: $${stats.totalCost.toFixed(4)}`);
    }
    if (typeof stats.totalElapsedMs === 'number' && stats.totalElapsedMs > 0) {
      statLines.push(`Total elapsed: ${(stats.totalElapsedMs / 1000).toFixed(1)}s`);
    }
    if (statLines.length) {
      lines.push('', 'Stats:', ...statLines);
    }
  }

  if (detail.recentHistory && detail.recentHistory.length > 0) {
    lines.push('', 'Recent activity:');
    for (const h of detail.recentHistory.slice(0, 5)) {
      const when = new Date(h.timestamp).toLocaleString();
      const status = h.success === false ? '⚠️' : '•';
      const summary = (h.summary ?? '').slice(0, 90);
      lines.push(`${status} ${when} — ${summary}`);
    }
  }

  await ctx.reply(lines.join('\n'));
}
