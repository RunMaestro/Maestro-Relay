import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  type GuildBasedChannel,
  type OverwriteResolvable,
} from 'discord.js';
import { maestro } from '../../../core/maestro';
import { channelDb, getChannelInfoForInteraction } from '../channelsDb';
import { threadDb } from '../threadsDb';
import { cleanupAgentFiles } from '../../../core/attachments';
import { clampFieldValue, clampTitle } from '../embed';
import { discordConfig } from '../config';
import { logger } from '../../../core/logger';

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
      )
      .addStringOption((opt) =>
        opt
          .setName('visibility')
          .setDescription('Who can see the channel (default: private)')
          .addChoices(
            { name: 'private — only you and the bot, then /agents grant', value: 'private' },
            { name: 'public — everyone in the server', value: 'public' },
          ),
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
    sub
      .setName('grant')
      .setDescription("(In an agent channel) Let someone see and use this agent's channel")
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The user to grant access to').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('revoke')
      .setDescription("(In an agent channel) Remove someone's access to this agent's channel")
      .addUserOption((opt) =>
        opt.setName('user').setDescription('The user to revoke access from').setRequired(true),
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
    const filtered = agents
      .filter((a) => a.name.toLowerCase().includes(focused) || a.id.toLowerCase().includes(focused))
      .sort((a, b) => a.name.localeCompare(b.name));
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
  } else if (sub === 'grant') {
    await handleAccess(interaction, 'grant');
  } else if (sub === 'revoke') {
    await handleAccess(interaction, 'revoke');
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

/**
 * Permission bits a participant needs in an agent channel: see it, read what
 * came before, and talk to the agent.
 */
const PARTICIPANT_BITS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
] as const;

function botId(interaction: ChatInputCommandInteraction): string {
  return interaction.client.user.id;
}

/**
 * Bits the bot grants itself on a channel it creates. Deliberately a subset of
 * the documented invite integer: Discord refuses an overwrite for a permission
 * the bot does not itself hold, so a bit listed here but absent from the invite
 * link turns `guild.channels.create()` into a 50013 and `/agents new` fails
 * outright. `ManageMessages` used to be here and was never used by anything.
 */
const BOT_CHANNEL_BITS = [
  ...PARTICIPANT_BITS,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
] as const;

/** Deny @everyone, allow the bot. Threads are included so replies stay reachable. */
function categoryOverwrites(everyoneId: string, botUserId: string): OverwriteResolvable[] {
  return [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botUserId, allow: [...BOT_CHANNEL_BITS] },
  ];
}

/**
 * Overwrites for `visibility:public`.
 *
 * Explicit rather than inherited. Passing `undefined` lets the channel take the
 * `Maestro Agents` category's overwrites, and a category created by an earlier
 * private `/agents new` denies `@everyone` ViewChannel — so a "public" channel
 * would be invisible to the server while the reply claimed the opposite.
 */
function publicChannelOverwrites(everyoneId: string, botUserId: string): OverwriteResolvable[] {
  return [
    { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel] },
    { id: botUserId, allow: [...BOT_CHANNEL_BITS] },
  ];
}

/** Category overwrites plus the person who ran `/agents new`. */
function channelOverwrites(
  everyoneId: string,
  botUserId: string,
  creatorId: string,
): OverwriteResolvable[] {
  const overwrites = categoryOverwrites(everyoneId, botUserId);
  if (creatorId !== botUserId) {
    overwrites.push({
      id: creatorId,
      allow: [...PARTICIPANT_BITS, PermissionFlagsBits.CreatePublicThreads],
    });
  }
  return overwrites;
}

/**
 * Who may re-key an agent channel.
 *
 * Without this, anyone who can see the channel can widen it: grant Bob so he
 * can help and Bob can grant Mallory a shell on the operator's machine. So
 * changing access needs a Discord-side channel-management permission, or
 * membership in the relay's explicit operator list.
 *
 * `setDefaultMemberPermissions` cannot express this — it applies to `/agents`
 * as a whole, which would also hide `/agents list` from everyone.
 */
function mayChangeAccess(interaction: ChatInputCommandInteraction): boolean {
  if (discordConfig.allowedUserIds.includes(interaction.user.id)) return true;
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return (
    perms.has(PermissionFlagsBits.ManageChannels) || perms.has(PermissionFlagsBits.ManageRoles)
  );
}

/**
 * `/agents grant` and `/agents revoke` — the key to the lock that
 * private-by-default creation puts on the door. Without these the operator has
 * to leave chat and edit channel permissions in the Discord UI by hand.
 */
async function handleAccess(
  interaction: ChatInputCommandInteraction,
  action: 'grant' | 'revoke',
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!mayChangeAccess(interaction)) {
    await interaction.editReply(
      `❌ You need **Manage Channels** or **Manage Roles** to ${action} access to an agent channel.\n` +
        '-# Being able to use a channel does not let you decide who else can.',
    );
    return;
  }

  // Thread-aware: agent conversations happen in owner-bound session threads, so
  // the natural place to run `/agents grant` is inside the thread you are in.
  const channelInfo = getChannelInfoForInteraction(interaction);
  if (!channelInfo) {
    await interaction.editReply(
      `❌ This is not an agent channel. Run \`/agents ${action}\` inside one.`,
    );
    return;
  }

  // A ThreadChannel carries no overwrites of its own; visibility is decided by
  // the parent agent channel, so that is what has to be edited.
  const here = interaction.channel;
  const channel = (here?.isThread() ? here.parent : here) as GuildBasedChannel | null;
  if (!channel || !('permissionOverwrites' in channel)) {
    await interaction.editReply('❌ This channel does not support permission overwrites.');
    return;
  }

  const target = interaction.options.getUser('user', true);
  if (target.id === botId(interaction)) {
    await interaction.editReply("❌ Refusing to change the bot's own access to this channel.");
    return;
  }

  try {
    if (action === 'grant') {
      await channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
      await interaction.editReply(
        `✅ <@${target.id}> can now see and use <#${channel.id}> ` +
          `(agent **${channelInfo.agent_name}**).`,
      );
    } else {
      await channel.permissionOverwrites.delete(target.id);
      await interaction.editReply(
        `✅ Removed <@${target.id}>'s channel-level access to <#${channel.id}>.\n` +
          `-# If they hold a role that grants **View Channel**, they can still see it.`,
      );
    }
  } catch (err) {
    void logger.error('discord/agents-access', `${action} failed: ${String(err)}`);
    await interaction.editReply(
      `❌ Could not ${action} access. The bot needs **Manage Roles** in this server.`,
    );
  }
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

  const isPrivate = (interaction.options.getString('visibility') ?? 'private') === 'private';

  // Find or create "Maestro Agents" category. A category created here is locked
  // to match: an agent channel is a shell on someone's machine, so the default
  // has to be closed. An existing category is left alone — the operator may
  // have arranged it deliberately, and the channel-level overwrite below is
  // what actually decides visibility either way.
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === 'Maestro Agents',
  );
  if (!category) {
    category = await guild.channels.create({
      name: 'Maestro Agents',
      type: ChannelType.GuildCategory,
      permissionOverwrites: isPrivate
        ? categoryOverwrites(guild.id, botId(interaction))
        : undefined,
    });
  }

  const channelName = `agent-${agent.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 100);
  const newChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Maestro agent: ${agent.name} (${agent.id}) | ${agent.toolType} | ${agent.cwd}`,
    // Set at creation, not patched afterwards: a channel that is public for even
    // a moment has already been seen by everyone watching the server.
    permissionOverwrites: isPrivate
      ? channelOverwrites(guild.id, botId(interaction), interaction.user.id)
      : publicChannelOverwrites(guild.id, botId(interaction)),
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
      `Type your messages there to chat with the agent.\n` +
      (isPrivate
        ? `-# Only you and the bot can see it. Use \`/agents grant\` in the channel to add someone.`
        : `-# ⚠️ This channel is visible to everyone in the server.`),
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
      statLines.push(`Tokens: ${stats.totalInputTokens ?? 0}↓ ${stats.totalOutputTokens ?? 0}↑`);
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
        logger.info('discord/disconnect', `Cleaned up files for agent ${agentId}`);
      }
    } catch (err) {
      void logger.error(
        'discord/disconnect',
        `Failed to clean up files for agent ${agentId}: ${String(err)}`,
      );
    }
  } else {
    logger.info(
      'discord/disconnect',
      `Skipping file cleanup for agent ${agentId} - ${otherChannels.length} other channel(s) and ${otherThreads.length} other thread(s) still active`,
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
