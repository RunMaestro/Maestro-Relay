import { maestro } from '../../../core/maestro';
import type { TelegramCommandContext } from './types';

export const command = 'notes';
export const description = "Director's Notes: AI synopsis or unified history";

export async function execute(ctx: TelegramCommandContext): Promise<void> {
  const sub = ctx.args[0];

  if (sub === 'synopsis') {
    await handleSynopsis(ctx);
    return;
  }
  if (sub === 'history') {
    await handleHistory(ctx);
    return;
  }

  await ctx.reply(
    'Usage: /notes [synopsis|history]\n' +
      '• synopsis [days] — AI synopsis of recent activity (slow)\n' +
      '• history [days] [limit] [filter] — recent unified history (filter: auto|user|cue)',
  );
}

function parseInteger(value: string | undefined, min: number, max: number): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const num = Number(value);
  if (num < min || num > max) return undefined;
  return num;
}

async function handleSynopsis(ctx: TelegramCommandContext): Promise<void> {
  const days = parseInteger(ctx.args[1], 1, 30);

  let result;
  try {
    result = await maestro.directorSynopsis({ days });
  } catch (err) {
    await ctx.reply(`❌ Synopsis failed: ${(err as Error).message.slice(0, 1500)}`);
    return;
  }

  const text = result.markdown ?? result.synopsis ?? result.text ?? '(empty synopsis)';
  const truncated = text.length > 3500 ? text.slice(0, 3500) + '\n\n…truncated' : text;
  const header = `🎬 Director's synopsis${days ? ` — last ${days}d` : ''}`;
  const footer =
    typeof result.entriesAnalyzed === 'number'
      ? `\n\nAnalyzed ${result.entriesAnalyzed} entries${
          typeof result.daysCovered === 'number' ? ` over ${result.daysCovered}d` : ''
        }`
      : '';
  await ctx.reply(`${header}\n\n${truncated}${footer}`);
}

async function handleHistory(ctx: TelegramCommandContext): Promise<void> {
  const days = parseInteger(ctx.args[1], 1, 30);
  const limit = parseInteger(ctx.args[2], 1, 50) ?? 20;
  const filterArg = ctx.args[3];
  const filter =
    filterArg === 'auto' || filterArg === 'user' || filterArg === 'cue' ? filterArg : undefined;

  let entries;
  try {
    entries = await maestro.directorHistory({ days, limit, filter });
  } catch (err) {
    await ctx.reply(
      `❌ History fetch failed: ${(err as Error).message.slice(0, 1500)}`,
    );
    return;
  }

  if (entries.length === 0) {
    await ctx.reply('No history entries in the requested window.');
    return;
  }

  const header = `📜 Director history${days ? ` — last ${days}d` : ''}`;
  const lines = entries.map((e) => {
    const when = e.timestamp ? new Date(e.timestamp).toLocaleString() : '—';
    const type = e.type ?? '?';
    const agent = e.agentName ? ` · ${e.agentName}` : '';
    const status = e.success === false ? '⚠️' : '•';
    const summary = (e.summary ?? '').slice(0, 100);
    return `${status} [${type}] ${when}${agent}\n${summary}`;
  });
  const body = lines.join('\n\n');
  const truncated = body.length > 3500 ? body.slice(0, 3500) + '\n\n…truncated' : body;
  await ctx.reply(`${header}\n\n${truncated}`);
}
