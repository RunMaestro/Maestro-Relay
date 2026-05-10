import { maestro, MaestroPlaybook } from '../../../core/maestro';
import type { TelegramCommandContext } from './types';

export const command = 'playbook';
export const description = 'Run and inspect Maestro playbooks';

const pendingSelections = new Map<string, { playbooks: MaestroPlaybook[]; action: 'show' | 'run' }>();

function selectionKey(ctx: TelegramCommandContext): string {
  return `${ctx.chatId}:${ctx.threadId ?? 0}:${ctx.fromUserId}`;
}

export async function execute(ctx: TelegramCommandContext): Promise<void> {
  const sub = ctx.args[0];

  if (sub === 'list') {
    await handleList(ctx);
    return;
  }
  if (sub === 'show') {
    await handleShow(ctx);
    return;
  }
  if (sub === 'run') {
    await handleRun(ctx);
    return;
  }

  // No subcommand: try resolving as a numeric reply to a previous list
  if (sub && /^\d+$/.test(sub)) {
    await handleNumberReply(ctx, Number(sub));
    return;
  }

  await ctx.reply(
    'Usage: /playbook [list|show <id>|run <id>]\n' +
      '• list — list available playbooks\n' +
      '• show <id-or-number> — show playbook details\n' +
      '• run <id-or-number> — run a playbook and post the result',
  );
}

async function handleList(ctx: TelegramCommandContext): Promise<void> {
  let playbooks: MaestroPlaybook[];
  try {
    playbooks = await maestro.listPlaybooks();
  } catch (err) {
    await ctx.reply(`❌ Could not list playbooks: ${(err as Error).message}`);
    return;
  }

  if (playbooks.length === 0) {
    await ctx.reply('No playbooks found. Create one in the Maestro app first.');
    return;
  }

  const lines = playbooks.map((p, idx) => {
    const owner = p.agentName ? ` · ${p.agentName}` : '';
    return `${idx + 1}. ${p.name}${owner}\n   ${p.id} · ${p.documentCount} docs · ${p.taskCount} tasks`;
  });
  await ctx.reply(
    `Playbooks:\n${lines.join('\n')}\n\n` +
      'Reply with /playbook show <number> or /playbook run <number>.',
  );
  pendingSelections.set(selectionKey(ctx), { playbooks, action: 'run' });
}

async function handleShow(ctx: TelegramCommandContext): Promise<void> {
  const playbookId = await resolvePlaybookId(ctx, ctx.args.slice(1));
  if (!playbookId) return;

  let detail;
  try {
    detail = await maestro.showPlaybook(playbookId);
  } catch (err) {
    await ctx.reply(`❌ Could not load playbook: ${(err as Error).message}`);
    return;
  }

  const lines: string[] = [
    `Playbook: ${detail.name}`,
    `id: ${detail.id}`,
    `description: ${detail.description || '(none)'}`,
    `tasks: ${detail.taskCount} (${detail.documentCount} docs)`,
  ];
  if (detail.agentName) lines.push(`agent: ${detail.agentName}`);

  if (detail.documents.length) {
    lines.push('', 'Documents:');
    for (const d of detail.documents.slice(0, 15)) {
      lines.push(`• ${d.path} — ${d.completedCount}/${d.taskCount} tasks`);
    }
    if (detail.documents.length > 15) {
      lines.push(`… and ${detail.documents.length - 15} more`);
    }
  }
  await ctx.reply(lines.join('\n'));
}

async function handleRun(ctx: TelegramCommandContext): Promise<void> {
  const playbookId = await resolvePlaybookId(ctx, ctx.args.slice(1));
  if (!playbookId) return;

  let detail;
  try {
    detail = await maestro.showPlaybook(playbookId);
  } catch {
    detail = null;
  }
  const label = detail?.name ?? playbookId;
  await ctx.reply(`▶️ Running playbook ${label}…`);

  let event;
  try {
    event = await maestro.runPlaybook(playbookId);
  } catch (err) {
    await ctx.reply(
      `❌ Playbook ${label} failed: ${(err as Error).message.slice(0, 1500)}`,
    );
    return;
  }

  const lines: string[] = [
    event.success === false
      ? `⚠️ Playbook ${label} finished with errors.`
      : `✅ Playbook ${label} complete.`,
  ];
  if (typeof event.totalTasksCompleted === 'number') {
    lines.push(`Tasks completed: ${event.totalTasksCompleted}`);
  }
  if (typeof event.totalElapsedMs === 'number') {
    lines.push(`Elapsed: ${(event.totalElapsedMs / 1000).toFixed(1)}s`);
  }
  if (typeof event.totalCost === 'number' && event.totalCost > 0) {
    lines.push(`Cost: $${event.totalCost.toFixed(4)}`);
  }
  if (event.summary) {
    lines.push('', String(event.summary).slice(0, 1500));
  }
  await ctx.reply(lines.join('\n'));
}

async function resolvePlaybookId(
  ctx: TelegramCommandContext,
  args: string[],
): Promise<string | null> {
  const arg = args[0];
  if (!arg) {
    await ctx.reply(
      'Missing playbook id. Use /playbook list first, then run /playbook run <number-or-id>.',
    );
    return null;
  }

  if (/^\d+$/.test(arg)) {
    const pending = pendingSelections.get(selectionKey(ctx));
    if (!pending) {
      await ctx.reply(
        'No recent /playbook list to pick from. Run /playbook list first.',
      );
      return null;
    }
    const idx = Number(arg) - 1;
    if (idx < 0 || idx >= pending.playbooks.length) {
      await ctx.reply(`Number out of range. Pick 1-${pending.playbooks.length}.`);
      return null;
    }
    return pending.playbooks[idx].id;
  }
  return arg;
}

async function handleNumberReply(
  ctx: TelegramCommandContext,
  num: number,
): Promise<void> {
  const pending = pendingSelections.get(selectionKey(ctx));
  if (!pending) {
    await ctx.reply(
      'No recent /playbook list to pick from. Run /playbook list first.',
    );
    return;
  }
  const idx = num - 1;
  if (idx < 0 || idx >= pending.playbooks.length) {
    await ctx.reply(`Number out of range. Pick 1-${pending.playbooks.length}.`);
    return;
  }
  // Re-dispatch as a run with the selected id
  const newCtx: TelegramCommandContext = {
    ...ctx,
    args: ['run', pending.playbooks[idx].id],
  };
  await handleRun(newCtx);
}
