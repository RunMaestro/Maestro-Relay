import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  TextChannel,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { AgentChannel, channelDb } from '../channelsDb';
import { threadDb } from '../threadsDb';
import { maestro, MaestroSession } from '../../../core/maestro';

export const data = new SlashCommandBuilder()
  .setName('session')
  .setDescription('Manage session threads for this agent channel')
  .addSubcommand((sub) =>
    sub
      .setName('new')
      .setDescription('Create a new session thread for this agent')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Name for this session thread').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('List all session threads for this agent'),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === 'new') {
    await handleNew(interaction);
  } else if (sub === 'list') {
    await handleList(interaction);
  }
}

interface ResolvedAgentChannel {
  channelInfo: AgentChannel;
  parentChannel: TextChannel | null;
  parentChannelId: string;
}

async function resolveAgentChannel(
  interaction: ChatInputCommandInteraction,
): Promise<ResolvedAgentChannel | undefined> {
  let parentChannelId = interaction.channelId;
  let parentChannel: TextChannel | null = null;

  if (interaction.channel?.isThread()) {
    const parentId = interaction.channel.parentId;
    if (!parentId) {
      await interaction.reply({
        content: '❌ Could not resolve the parent channel for this thread.',
        ephemeral: true,
      });
      return undefined;
    }
    parentChannelId = parentId;
    const parent = interaction.channel.parent;
    if (parent?.isSendable() && 'threads' in parent) {
      parentChannel = parent as TextChannel;
    }
  } else if (interaction.channel?.isSendable() && 'threads' in interaction.channel) {
    parentChannel = interaction.channel as TextChannel;
  }

  const channelInfo = channelDb.get(parentChannelId);
  if (!channelInfo) {
    await interaction.reply({
      content: '❌ This channel is not connected to an agent. Use `/agents connect` first.',
      ephemeral: true,
    });
    return undefined;
  }

  return { channelInfo, parentChannel, parentChannelId };
}

async function handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
  const resolved = await resolveAgentChannel(interaction);
  if (!resolved) {
    return;
  }
  const { channelInfo, parentChannel, parentChannelId } = resolved;

  if (!parentChannel) {
    await interaction.reply({
      content: '❌ Could not access the parent agent channel.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  const providedName = interaction.options.getString('name');
  const threadName =
    providedName ??
    `Session ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  const thread = await parentChannel.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `Maestro session for agent ${channelInfo.agent_name}`,
  });

  threadDb.register(thread.id, parentChannelId, channelInfo.agent_id, interaction.user.id);

  await thread.send(
    `🤖 **${channelInfo.agent_name}** — ready for a new session.\nType your first message to begin. This thread is linked to a dedicated Maestro session.\nOnly <@${interaction.user.id}> can interact with the agent in this thread.`,
  );

  await interaction.editReply(
    `🧵 Session thread created: <#${thread.id}>\nChat with **${channelInfo.agent_name}** inside that thread.`,
  );
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const resolved = await resolveAgentChannel(interaction);
  if (!resolved) {
    return;
  }
  const { channelInfo, parentChannelId } = resolved;

  await interaction.deferReply({ ephemeral: true });

  const dbThreads = threadDb.listByChannel(parentChannelId);
  if (dbThreads.length === 0) {
    await interaction.editReply('No session threads yet. Use `/session new` to create one.');
    return;
  }

  let maestroSessions: MaestroSession[] = [];
  try {
    maestroSessions = await maestro.listSessions(channelInfo.agent_id);
  } catch {
    // fall through with empty list
  }

  const sessionMap = new Map<string, MaestroSession>(maestroSessions.map((s) => [s.sessionId, s]));

  const lines = dbThreads.map((t) => {
    const maestroInfo = sessionMap.get(t.session_id ?? '');
    const shortId = t.session_id ? t.session_id.slice(0, 8) : 'no session yet';
    const stats = maestroInfo
      ? `${maestroInfo.messageCount} msgs · $${maestroInfo.costUsd.toFixed(4)} · ${new Date(maestroInfo.modifiedAt).toLocaleDateString()}`
      : 'No messages yet';
    return `<#${t.thread_id}> — \`${shortId}\` · ${stats}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Sessions — ${channelInfo.agent_name}`)
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2)
    .setFooter({ text: 'Each thread is an independent Maestro session' });

  await interaction.editReply({ embeds: [embed] });
}
