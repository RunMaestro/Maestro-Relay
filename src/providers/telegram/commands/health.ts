import { maestro } from '../../../core/maestro';
import type { TelegramCommandContext } from './types';

export const command = 'health';
export const description = 'Verify maestro-cli is reachable';

export async function execute(ctx: TelegramCommandContext): Promise<void> {
  const installed = await maestro.isInstalled();
  if (!installed) {
    await ctx.reply(
      '❌ maestro-cli not found. Install Maestro and ensure it is on PATH.\n' +
        'See https://maestro.sh for instructions.',
    );
    return;
  }

  let agentCount: number;
  try {
    agentCount = (await maestro.listAgents()).length;
  } catch (err) {
    await ctx.reply(
      `⚠️ maestro-cli is installed but failed to list agents. ` +
        `Make sure Maestro is running.\n${(err as Error).message}`,
    );
    return;
  }

  await ctx.reply(
    `✅ maestro-cli is healthy.\n` +
      `Found ${agentCount} agent${agentCount !== 1 ? 's' : ''}. ` +
      `Bound to ${ctx.boundAgentName} (${ctx.boundAgentId}).`,
  );
}
