import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { maestro } from '../../../core/maestro';
import { channelDb } from '../channelsDb';
import { threadDb } from '../threadsDb';
import { cleanupAgentFiles } from '../../../core/attachments';
import { clampFieldValue, clampTitle } from '../embed';
import { discordConfig } from '../config';

function missingBotScopeMessage(): string {
  return (
    '❌ The bot is not a member of this server. It was likely invited with only slash-command permissions.\n\n' +
    'Re-invite with both `bot` and `applications.commands` scopes:\n' +
    `https://discord.com/oauth2/authorize?client_id=${discordConfig.clientId}&scope=bot+applications.commands&permissions=11344`
  );
}

export const data = new SlashCommandBuilder()
  .setName('agents')
  .setDescription('Manage Maestro agents')
  .addSubcommand((sub) => sub.setName('list').setDescription('List all available agents'))
  .addSubcommand((sub) =>
    sub
      .setName('new')
      .setDescription('Create a dedicated channel for an agent')
      .addStringOption((opt) =>
        opt
          .setName('agent')
          .setDescription('Select an agent')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription("Show an agent's details, stats, and recent activity")
      .addStringOption((opt) =>
        opt
          .setName('agent')
          .setDescription('Select an agent')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('disconnect').setDescription('Remove this agent channel (deletes the channel)'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('readonly')
      .setDescription('Toggle read-only mode for this agent channel')
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Turn read-only on or off')
          .setRequired(true)
          .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
      ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();

  try {
    const agents = await maestro.listAgents();
    const filtered = agents.filter(
      (a) => a.name.toLowerCase().includes(focused) || a.id.toLowerCase().includes(focused),
    );
    await interaction.respond(
      filtered.slice(0, 25).map((a) => ({ name: `${a.name} (${a.toolType})`, value: a.id })),
    );
  } catch {
    await interaction.respond([]);
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    const msg = interaction.guildId
      ? missingBotScopeMessage()
      : 'This command must be used in a server.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    await handleList(interaction);
  } else if (sub === 'new') {
    await handleNew(interaction);
  } else if (sub === 'show') {
    await handleShow(interaction);
  } else if (sub === 'disconnect') {
    await handleDisconnect(interaction);
  } else if (sub === 'readonly') {
    await handleReadonly(interaction);
  }
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const agents = await maestro.listAgents();

  if (agents.length === 0) {
    await interaction.editReply('No agents found. Start an agent in Maestro first.');
    return;
  }

  const lines = agents.map((a) => `**${a.name}** · \`${a.id}\` · ${a.toolType}`);

  // Build a single embed; Discord limits description to 4096 chars and
  // total embed content to 6000 chars per message.  With compact one-line
  // entries (~60 chars each) this comfortably fits ~65 agents.
  const MAX_DESC = 4096;
  let description = '';
  let shown = 0;
  for (const line of lines) {
    const addition = description ? '\n' + line : line;
    if (description.length + addition.length > MAX_DESC) break;
    description += addition;
    shown++;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Maestro Agents')
    .setDescription(description);

  const footerParts: string[] = [];
  if (shown < agents.length) {
    footerParts.push(`Showing ${shown} of ${agents.length} agents`);
  }
  footerParts.push('Use /agents new <agent-id> to start a conversation');
  embed.setFooter({ text: footerParts.join(' · ') });

  await interaction.editReply({ embeds: [embed] });
}

async function handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const agentInput = interaction.options.getString('agent', true);
  const guild =
    interaction.guild ??
    (interaction.guildId
      ? await interaction.client.guilds.fetch(interaction.guildId).catch(() => null)
      : null);
  if (!guild) {
    await interaction.editReply(
      interaction.guildId ? missingBotScopeMessage() : 'This command must be used in a server.',
    );
    return;
  }

  const agents = await maestro.listAgents();
  const agent = agents.find(
    (a) => a.id === agentInput || a.id.startsWith(agentInput) || a.name === agentInput,
  );

  if (!agent) {
    await interaction.editReply(
      `❌ No agent found matching \`${agentInput}\`. Use \`/agents list\` to see available agents.`,
    );
    return;
  }

  // Find or create "Maestro Agents" category
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === 'Maestro Agents',
  );
  if (!category) {
    category = await guild.channels.create({
      name: 'Maestro Agents',
      type: ChannelType.GuildCategory,
    });
  }

  const channelName = `agent-${agent.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(
    0,
    100,
  );
  const newChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Maestro agent: ${agent.name} (${agent.id}) | ${agent.toolType} | ${agent.cwd}`,
  });
  if (!newChannel.isSendable()) {
    await interaction.editReply(
      '❌ Failed to create a sendable channel for the agent. Check bot permissions in this server.',
    );
    return;
  }
  const channel = newChannel;

  channelDb.register(channel.id, guild.id, agent.id, agent.name);

  await interaction.editReply(
    `✅ Created <#${channel.id}> for agent **${agent.name}**.\n` +
      `Type your messages there to chat with the agent.`,
  );

  await channel.send(
    `**${agent.name}** is ready.\n` +
      `Type any message here and it will be sent to this agent.\n` +
      `-# Agent: \`${agent.id}\` • ${agent.toolType} • \`${agent.cwd}\``,
  );
}

async function handleShow(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const agentId = interaction.options.getString('agent', true);

  let detail;
  try {
    detail = await maestro.showAgent(agentId);
  } catch (err) {
    await interaction.editReply(`❌ Could not load agent: ${(err as Error).message}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(clampTitle(detail.name))
    .addFields(
      { name: 'ID', value: `\`${detail.id}\``, inline: false },
      { name: 'Tool', value: detail.toolType, inline: true },
      { name: 'Cwd', value: clampFieldValue(`\`${detail.cwd}\``), inline: false },
    );

  if (detail.groupName) {
    embed.addFields({ name: 'Group', value: clampFieldValue(detail.groupName), inline: true });
  }

  const stats = detail.stats;
  if (stats) {
    const statLines: string[] = [];
    if (typeof stats.historyEntries === 'number') {
      const ok = stats.successCount ?? 0;
      const fail = stats.failureCount ?? 0;
      statLines.push(`History: ${stats.historyEntries} entries (${ok} ok · ${fail} failed)`);
    }
    if (typeof stats.totalInputTokens === 'number' || typeof stats.totalOutputTokens === 'number') {
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
      embed.addFields({ name: 'Stats', value: clampFieldValue(statLines.join('\n')) });
    }
  }

  if (detail.recentHistory && detail.recentHistory.length > 0) {
    const recent = detail.recentHistory
      .slice(0, 5)
      .map((h) => {
        const when = new Date(h.timestamp).toLocaleString();
        const status = h.success === false ? '⚠️' : '•';
        const summary = (h.summary ?? '').slice(0, 90);
        return `${status} ${when} — ${summary}`;
      })
      .join('\n');
    embed.addFields({ name: 'Recent activity', value: clampFieldValue(recent) });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleReadonly(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelInfo = channelDb.get(interaction.channelId);
  if (!channelInfo) {
    await interaction.reply({ content: 'This channel is not an agent channel.', ephemeral: true });
    return;
  }

  const mode = interaction.options.getString('mode', true);
  const readOnly = mode === 'on';
  channelDb.setReadOnly(interaction.channelId, readOnly);

  const embed = new EmbedBuilder()
    .setColor(readOnly ? 0xf0b232 : 0x57f287)
    .setDescription(
      readOnly
        ? `📖 **${channelInfo.agent_name}** is now in **read-only** mode. The agent cannot modify files.`
        : `✏️ **${channelInfo.agent_name}** is back to **read-write** mode.`,
    );

  await interaction.reply({ embeds: [embed] });
}

async function handleDisconnect(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelInfo = channelDb.get(interaction.channelId);
  if (!channelInfo) {
    await interaction.reply({ content: 'This channel is not an agent channel.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `Disconnecting **${channelInfo.agent_name}**...`,
    ephemeral: true,
  });

  // Clean up downloaded files if this is the last channel for this agent
  // (also consider threads bound to other channels for the same agent)
  const agentId = channelInfo.agent_id;
  const otherChannels = channelDb
    .listByAgentId(agentId)
    .filter((c) => c.channel_id !== interaction.channelId);
  const otherThreads = threadDb
    .getByAgentId(agentId)
    .filter((t) => t.channel_id !== interaction.channelId);

  if (otherChannels.length === 0 && otherThreads.length === 0) {
    try {
      const agentCwd = await maestro.getAgentCwd(agentId);
      if (agentCwd) {
        await cleanupAgentFiles(agentCwd);
        console.log(`[disconnect] Cleaned up files for agent ${agentId}`);
      }
    } catch (err) {
      console.warn(`[disconnect] Failed to clean up files for agent ${agentId}:`, err);
    }
  } else {
    console.log(
      `[disconnect] Skipping file cleanup for agent ${agentId} — ${otherChannels.length} other channel(s) and ${otherThreads.length} other thread(s) still active`,
    );
  }

  // Remove channel and its threads from DB
  threadDb.removeByChannel(interaction.channelId);
  channelDb.remove(interaction.channelId);

  setTimeout(async () => {
    try {
      await interaction.channel?.delete();
    } catch {
      // Channel may already be gone
    }
  }, 2000);
}
