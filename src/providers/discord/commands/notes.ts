import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { maestro } from '../../../core/maestro';

export const data = new SlashCommandBuilder()
  .setName('notes')
  .setDescription("Director's Notes: AI synopsis or unified history across agents")
  .addSubcommand((sub) =>
    sub
      .setName('synopsis')
      .setDescription('AI-generated synopsis of recent activity (slow — runs the LLM)')
      .addIntegerOption((opt) =>
        opt
          .setName('days')
          .setDescription('Lookback period in days')
          .setMinValue(1)
          .setMaxValue(30)
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('history')
      .setDescription('Recent unified history entries')
      .addIntegerOption((opt) =>
        opt
          .setName('days')
          .setDescription('Lookback period in days')
          .setMinValue(1)
          .setMaxValue(30)
          .setRequired(false),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('limit')
          .setDescription('Max entries to show (default 20)')
          .setMinValue(1)
          .setMaxValue(50)
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName('filter')
          .setDescription('Entry type filter')
          .setRequired(false)
          .addChoices(
            { name: 'auto', value: 'auto' },
            { name: 'user', value: 'user' },
            { name: 'cue', value: 'cue' },
          ),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'synopsis') return handleSynopsis(interaction);
  if (sub === 'history') return handleHistory(interaction);
}

async function handleSynopsis(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const days = interaction.options.getInteger('days') ?? undefined;

  let result;
  try {
    result = await maestro.directorSynopsis({ days });
  } catch (err) {
    await interaction.editReply(
      `❌ Synopsis failed: ${(err as Error).message.slice(0, 1500)}`,
    );
    return;
  }

  const text = result.markdown ?? result.synopsis ?? result.text ?? '_(empty synopsis)_';
  const truncated = text.length > 4000 ? text.slice(0, 4000) + '\n\n_…truncated_' : text;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎬 Director's synopsis${days ? ` — last ${days}d` : ''}`)
    .setDescription(truncated);

  if (typeof result.entriesAnalyzed === 'number') {
    embed.setFooter({
      text: `Analyzed ${result.entriesAnalyzed} entries${
        typeof result.daysCovered === 'number' ? ` over ${result.daysCovered}d` : ''
      }`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleHistory(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const days = interaction.options.getInteger('days') ?? undefined;
  const limit = interaction.options.getInteger('limit') ?? 20;
  const filter = interaction.options.getString('filter') as
    | 'auto'
    | 'user'
    | 'cue'
    | null;

  let entries;
  try {
    entries = await maestro.directorHistory({
      days,
      limit,
      filter: filter ?? undefined,
    });
  } catch (err) {
    await interaction.editReply(
      `❌ History fetch failed: ${(err as Error).message.slice(0, 1500)}`,
    );
    return;
  }

  if (entries.length === 0) {
    await interaction.editReply('No history entries in the requested window.');
    return;
  }

  const lines = entries.map((e) => {
    const when = e.timestamp ? new Date(e.timestamp).toLocaleString() : '—';
    const type = e.type ?? '?';
    const agent = e.agentName ? ` · ${e.agentName}` : '';
    const status = e.success === false ? '⚠️' : '•';
    const summary = (e.summary ?? '').slice(0, 100);
    return `${status} \`${type}\` ${when}${agent}\n${summary}`;
  });

  const MAX_DESC = 4096;
  let description = '';
  let shown = 0;
  for (const line of lines) {
    const addition = description ? '\n\n' + line : line;
    if (description.length + addition.length > MAX_DESC) break;
    description += addition;
    shown++;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📜 Director history${days ? ` — last ${days}d` : ''}`)
    .setDescription(description);

  if (shown < entries.length) {
    embed.setFooter({ text: `Showing ${shown} of ${entries.length}` });
  }

  await interaction.editReply({ embeds: [embed] });
}
