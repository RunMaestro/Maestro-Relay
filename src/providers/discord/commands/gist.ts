import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { channelDb } from '../channelsDb';
import { maestro } from '../../../core/maestro';

export const data = new SlashCommandBuilder()
  .setName('gist')
  .setDescription("Publish this agent's session transcript as a GitHub gist")
  .addStringOption((opt) =>
    opt.setName('description').setDescription('Optional gist description').setRequired(false),
  )
  .addBooleanOption((opt) =>
    opt
      .setName('public')
      .setDescription('Make the gist public (default: private)')
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelInfo = channelDb.get(interaction.channelId);
  if (!channelInfo) {
    await interaction.reply({
      content: '❌ This channel is not connected to an agent. Use `/agents new` first.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const description = interaction.options.getString('description') ?? undefined;
  const isPublic = interaction.options.getBoolean('public') ?? false;

  let result;
  try {
    result = await maestro.createGist(channelInfo.agent_id, { description, isPublic });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`❌ Could not publish gist: ${message.slice(0, 1500)}`);
    return;
  }

  const visibility = isPublic ? 'public' : 'private';
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`📎 Gist published — ${channelInfo.agent_name}`)
    .setURL(result.url)
    .setDescription(`[Open gist](${result.url})\nVisibility: **${visibility}**`);

  await interaction.editReply({ embeds: [embed] });
}
