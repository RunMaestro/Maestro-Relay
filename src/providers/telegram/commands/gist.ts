import { maestro } from '../../../core/maestro';
import type { TelegramCommandContext } from './types';

export const command = 'gist';
export const description = "Publish this agent's session transcript as a GitHub gist";

export async function execute(ctx: TelegramCommandContext): Promise<void> {
  let isPublic = false;
  const descriptionParts: string[] = [];
  for (const arg of ctx.args) {
    if (arg === '--public' || arg === '-p') {
      isPublic = true;
    } else {
      descriptionParts.push(arg);
    }
  }
  const gistDescription = descriptionParts.length ? descriptionParts.join(' ') : undefined;

  let result;
  try {
    result = await maestro.createGist(ctx.boundAgentId, {
      description: gistDescription,
      isPublic,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Could not publish gist: ${message.slice(0, 1500)}`);
    return;
  }

  const visibility = isPublic ? 'public' : 'private';
  await ctx.reply(
    `📎 Gist published — ${ctx.boundAgentName}\n` +
      `${result.gistUrl}\n` +
      `Visibility: ${visibility}`,
  );
}
