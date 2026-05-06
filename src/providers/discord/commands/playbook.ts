import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { maestro } from '../../../core/maestro';
import { clampDescription, clampFieldValue, clampTitle } from '../embed';

export const data = new SlashCommandBuilder()
  .setName('playbook')
  .setDescription('Run and inspect Maestro playbooks')
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List available playbooks')
      .addStringOption((opt) =>
        opt
          .setName('agent')
          .setDescription('Filter to one agent')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('Show details for a playbook')
      .addStringOption((opt) =>
        opt
          .setName('playbook')
          .setDescription('Playbook to show')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('run')
      .setDescription('Run a playbook and post the result here')
      .addStringOption((opt) =>
        opt
          .setName('playbook')
          .setDescription('Playbook to run')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const value = focused.value.toLowerCase();

  try {
    if (focused.name === 'agent') {
      const agents = await maestro.listAgents();
      await interaction.respond(
        agents
          .filter(
            (a) => a.name.toLowerCase().includes(value) || a.id.toLowerCase().includes(value),
          )
          .slice(0, 25)
          .map((a) => ({ name: `${a.name} (${a.toolType})`, value: a.id })),
      );
      return;
    }

    if (focused.name === 'playbook') {
      const playbooks = await maestro.listPlaybooks();
      await interaction.respond(
        playbooks
          .filter(
            (p) => p.name.toLowerCase().includes(value) || p.id.toLowerCase().includes(value),
          )
          .slice(0, 25)
          .map((p) => ({
            name: `${p.name}${p.agentName ? ` (${p.agentName})` : ''}`.slice(0, 100),
            value: p.id,
          })),
      );
      return;
    }
  } catch {
    await interaction.respond([]);
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') return handleList(interaction);
  if (sub === 'show') return handleShow(interaction);
  if (sub === 'run') return handleRun(interaction);
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const agentId = interaction.options.getString('agent') ?? undefined;
  const playbooks = await maestro.listPlaybooks(agentId);

  if (playbooks.length === 0) {
    await interaction.editReply(
      agentId
        ? 'No playbooks found for that agent.'
        : 'No playbooks found. Create one in the Maestro app first.',
    );
    return;
  }

  const lines = playbooks.map((p) => {
    const owner = p.agentName ? ` · ${p.agentName}` : '';
    return `**${p.name}**${owner}\n\`${p.id}\` · ${p.documentCount} docs · ${p.taskCount} tasks`;
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
    .setTitle('Playbooks')
    .setDescription(description);

  if (shown < playbooks.length) {
    embed.setFooter({ text: `Showing ${shown} of ${playbooks.length}` });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleShow(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const playbookId = interaction.options.getString('playbook', true);

  let detail;
  try {
    detail = await maestro.showPlaybook(playbookId);
  } catch (err) {
    await interaction.editReply(`❌ Could not load playbook: ${(err as Error).message}`);
    return;
  }

  const docLines = detail.documents
    .slice(0, 15)
    .map((d) => `• \`${d.path}\` — ${d.completedCount}/${d.taskCount} tasks`);
  if (detail.documents.length > 15) {
    docLines.push(`… and ${detail.documents.length - 15} more`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(clampTitle(detail.name))
    .setDescription(clampDescription(detail.description || '_(no description)_'))
    .addFields(
      { name: 'ID', value: `\`${detail.id}\``, inline: true },
      {
        name: 'Tasks',
        value: `${detail.taskCount} (${detail.documentCount} docs)`,
        inline: true,
      },
    );

  if (detail.agentName) {
    embed.addFields({ name: 'Agent', value: clampFieldValue(detail.agentName), inline: true });
  }
  if (docLines.length) {
    embed.addFields({ name: 'Documents', value: clampFieldValue(docLines.join('\n')) });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleRun(interaction: ChatInputCommandInteraction): Promise<void> {
  // Public reply — playbook runs are interesting to the channel
  await interaction.deferReply();

  const playbookId = interaction.options.getString('playbook', true);

  let detail;
  try {
    detail = await maestro.showPlaybook(playbookId);
  } catch {
    detail = null;
  }
  const label = detail?.name ?? playbookId;

  await interaction.editReply(`▶️ Running playbook **${label}**…`);

  let event;
  try {
    event = await maestro.runPlaybook(playbookId);
  } catch (err) {
    await interaction.editReply(
      `❌ Playbook **${label}** failed: ${(err as Error).message.slice(0, 1500)}`,
    );
    return;
  }

  const lines: string[] = [
    event.success === false
      ? `⚠️ Playbook **${label}** finished with errors.`
      : `✅ Playbook **${label}** complete.`,
  ];
  if (typeof event.totalTasksCompleted === 'number') {
    lines.push(`Tasks completed: **${event.totalTasksCompleted}**`);
  }
  if (typeof event.totalElapsedMs === 'number') {
    const seconds = (event.totalElapsedMs / 1000).toFixed(1);
    lines.push(`Elapsed: ${seconds}s`);
  }
  if (typeof event.totalCost === 'number' && event.totalCost > 0) {
    lines.push(`Cost: $${event.totalCost.toFixed(4)}`);
  }
  if (event.summary) {
    const summary = String(event.summary).slice(0, 1500);
    lines.push('', summary);
  }

  await interaction.editReply(lines.join('\n'));
}
