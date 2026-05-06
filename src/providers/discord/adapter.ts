import {
  AutocompleteInteraction,
  CategoryChannel,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  SendableChannels,
  SlashCommandBuilder,
} from 'discord.js';
import type {
  AgentChannelInfo,
  BridgeProvider,
  ChannelTarget,
  ConversationRecord,
  IncomingMessage,
  KernelContext,
  MessageTarget,
  OutgoingMessage,
  ReactionHandle,
} from '../../core/types';
import { maestro } from '../../core/maestro';
import { logger } from '../../core/logger';
import { checkTranscriptionDependencies } from '../../core/transcription';
import { discordConfig } from './config';
import { channelDb } from './channelsDb';
import { threadDb } from './threadsDb';
import { createMessageCreateHandler } from './messageCreate';
import {
  isVoiceMessage,
  isVoiceAttachment,
} from './voice';
import { transcribeVoiceAttachment, isTranscriberAvailable } from '../../core/transcription';
import { splitMessage } from '../../core/splitMessage';
import * as health from './commands/health';
import * as agents from './commands/agents';
import * as session from './commands/session';
import * as playbook from './commands/playbook';
import * as gist from './commands/gist';
import * as notes from './commands/notes';
import * as autoRun from './commands/auto-run';

interface CommandModule {
  data: { name: string } & Pick<SlashCommandBuilder, 'toJSON'>;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

const COMMANDS: CommandModule[] = [health, agents, session, playbook, gist, notes, autoRun];

export class DiscordProvider implements BridgeProvider {
  readonly name = 'discord';
  private client: Client | null = null;
  private pendingChannels = new Map<string, Promise<AgentChannelInfo>>();
  private pendingCategory: Promise<CategoryChannel> | null = null;

  async start(ctx: KernelContext): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.client = client;

    const commandsByName = new Map<string, CommandModule>(
      COMMANDS.map((c) => [c.data.name, c]),
    );

    client.once('ready', async (c) => {
      console.log(`[discord] logged in as ${c.user.tag}`);
      await checkTranscriptionDependencies();
    });

    client.on('interactionCreate', async (interaction: Interaction) => {
      const allowed = discordConfig.allowedUserIds;
      const isUnauthorized =
        allowed.length > 0 && !allowed.includes(interaction.user.id);

      if (interaction.isAutocomplete()) {
        if (isUnauthorized) {
          await interaction.respond([]);
          return;
        }
        const cmd = commandsByName.get(interaction.commandName);
        if (cmd?.autocomplete) {
          try {
            await cmd.autocomplete(interaction);
          } catch (err) {
            console.error('Autocomplete error:', err);
          }
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      if (isUnauthorized) {
        await interaction.reply({
          content: '❌ You are not authorized to use this bot.',
          ephemeral: true,
        });
        return;
      }

      const cmd = commandsByName.get(interaction.commandName);
      if (!cmd) return;
      try {
        await cmd.execute(interaction);
      } catch (err) {
        console.error('Command error:', err);
        const msg = { content: '❌ An error occurred.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(msg);
        } else {
          await interaction.reply(msg);
        }
      }
    });

    const handleMessageCreate = createMessageCreateHandler({
      channelDb,
      threadDb,
      getBotUserId: (message) => message.client.user?.id,
      enqueue: ctx.enqueue,
      isVoiceMessage,
      isVoiceAttachment,
      transcribeVoiceAttachment,
      isTranscriberAvailable,
      splitMessage,
      logger: console,
    });
    client.on('messageCreate', handleMessageCreate);

    await client.login(discordConfig.token);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  isReady(): boolean {
    return !!this.client?.isReady();
  }

  resolveConversation(message: IncomingMessage): ConversationRecord | null {
    if (message.isThread) {
      const threadInfo = threadDb.get(message.channelId);
      if (!threadInfo) return null;
      const channelInfo = channelDb.get(threadInfo.channel_id);
      if (!channelInfo) return null;
      return {
        agentId: threadInfo.agent_id,
        sessionId: threadInfo.session_id ?? null,
        readOnly: !!channelInfo.read_only,
        persistSession: (sessionId: string) => threadDb.updateSession(message.channelId, sessionId),
      };
    }

    const channelInfo = channelDb.get(message.channelId);
    if (!channelInfo) return null;
    return {
      agentId: channelInfo.agent_id,
      sessionId: channelInfo.session_id ?? null,
      readOnly: !!channelInfo.read_only,
      persistSession: (sessionId: string) =>
        channelDb.updateSession(message.channelId, sessionId),
    };
  }

  async send(target: ChannelTarget, msg: OutgoingMessage): Promise<void> {
    const channel = await this.fetchSendable(target.channelId);
    let text = msg.text;
    if (msg.mention && discordConfig.mentionUserId) {
      text = `<@${discordConfig.mentionUserId}> ${text}`;
    }
    await channel.send(text);
  }

  async react(target: MessageTarget, emoji: string): Promise<ReactionHandle> {
    const channel = await this.fetchSendable(target.channelId);
    const message = await channel.messages.fetch(target.messageId);
    const reaction = await message.react(emoji);
    const botUserId = this.client?.user?.id;
    return {
      remove: async () => {
        if (botUserId) {
          await reaction.users.remove(botUserId);
        } else {
          await reaction.remove();
        }
      },
    };
  }

  async sendTyping(target: ChannelTarget): Promise<void> {
    const channel = await this.fetchSendable(target.channelId);
    if ('sendTyping' in channel && typeof channel.sendTyping === 'function') {
      await channel.sendTyping();
    }
  }

  async findOrCreateAgentChannel(agentId: string): Promise<AgentChannelInfo> {
    const existing = channelDb.getByAgentId(agentId);
    if (existing) {
      return {
        channelId: existing.channel_id,
        agentId: existing.agent_id,
        agentName: existing.agent_name,
      };
    }

    const pending = this.pendingChannels.get(agentId);
    if (pending) return pending;

    const promise = (async () => {
      if (!this.client) throw new Error('Discord client not initialised');
      const allAgents = await maestro.listAgents();
      const agent = allAgents.find((a) => a.id === agentId);
      if (!agent) throw new Error(`Agent not found: ${agentId}`);

      const guild = await this.client.guilds.fetch(discordConfig.guildId);

      let category = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === 'Maestro Agents',
      );
      if (!category) {
        if (!this.pendingCategory) {
          this.pendingCategory = guild.channels.create({
            name: 'Maestro Agents',
            type: ChannelType.GuildCategory,
          });
        }
        try {
          category = await this.pendingCategory;
        } finally {
          this.pendingCategory = null;
        }
      }

      const channelName = `agent-${agent.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category!.id,
        topic: `Maestro agent: ${agent.name} (${agent.id}) | ${agent.toolType} | ${agent.cwd}`,
      });

      channelDb.register(channel.id, guild.id, agent.id, agent.name);

      return { channelId: channel.id, agentId: agent.id, agentName: agent.name };
    })();

    this.pendingChannels.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.pendingChannels.delete(agentId);
    }
  }

  private async fetchSendable(channelId: string): Promise<SendableChannels> {
    if (!this.client) throw new Error('Discord client not initialised');
    const fetched = await this.client.channels.fetch(channelId);
    if (!fetched?.isSendable()) {
      const err = new Error(`Channel ${channelId} is missing or not sendable`);
      void logger.error('discord/fetchSendable', err.message);
      throw err;
    }
    return fetched;
  }
}
