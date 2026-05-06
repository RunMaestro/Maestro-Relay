import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { maestro } from '../../../core/maestro';

export const data = new SlashCommandBuilder()
  .setName('health')
  .setDescription('Verify the Maestro CLI is installed and the bot is ready');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const installed = await maestro.isInstalled();
  if (!installed) {
    await interaction.editReply(
      '❌ `maestro-cli` not found. Please install Maestro and ensure it is in your PATH.\n' +
        'Visit https://maestro.sh for installation instructions.',
    );
    return;
  }

  let agentCount: number;
  try {
    agentCount = (await maestro.listAgents()).length;
  } catch (err) {
    await interaction.editReply(
      '⚠️ `maestro-cli` is installed, but failed to list agents. ' +
        'Make sure Maestro is running.\n```' +
        String(err) +
        '```',
    );
    return;
  }

  await interaction.editReply(
    `✅ Maestro CLI is healthy.\n` +
      `Found **${agentCount}** agent${agentCount !== 1 ? 's' : ''}. ` +
      `Use \`/agents\` to see them.`,
  );
}
