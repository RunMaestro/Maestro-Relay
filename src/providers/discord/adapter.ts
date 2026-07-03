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
  PersonaIdentity,
  ReactionHandle,
} from '../../core/types';
import { maestro } from '../../core/maestro';
import { logger } from '../../core/logger';
import { checkTranscriptionDependencies } from '../../core/transcription';
import { AgentNotFoundError, RateLimitError } from '../../core/errors';
import { discordConfig } from './config';
import { channelDb } from './channelsDb';
import { threadDb } from './threadsDb';
import { createMessageCreateHandler } from './messageCreate';
import { createRoomMessageHandler } from './roomMessageCreate';
import { RoomGatewayManager } from './roomGateways';
import { TimeoutStallDetector } from './roomStall';
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
import * as room from './commands/room';

interface CommandModule {
  data: { name: string } & Pick<SlashCommandBuilder, 'toJSON'>;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

const COMMANDS: CommandModule[] = [health, agents, session, playbook, gist, notes, autoRun, room];

export class DiscordProvider implements BridgeProvider {
  readonly name = 'discord';
  private client: Client | null = null;
  private roomGateways: RoomGatewayManager | null = null;
  private roomStall: TimeoutStallDetector | null = null;
  /**
   * The room-aware `messageCreate` listener, retained so it can be re-bound at
   * runtime. Slot 0 (the primary bot) only receives it once it becomes a room
   * participant — `/room invite` can make that true after `start()` has already
   * run, so a re-bind after each `/room` command picks up the newly-participating
   * slot 0. `bindRoomListeners` is idempotent, so re-binding is safe.
   */
  private handleRoomMessage: ((message: import('discord.js').Message) => void | Promise<void>) | null =
    null;
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

    const primaryReady = new Promise<void>((resolve) => {
      client.once('ready', async (c) => {
        logger.info('discord/ready', `logged in as ${c.user.tag}`);
        await checkTranscriptionDependencies();
        resolve();
      });
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
            await logger.error('discord/autocomplete', String(err));
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
        await logger.error('discord/command', `${interaction.commandName}: ${String(err)}`);
        const msg = { content: '❌ An error occurred.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(msg);
        } else {
          await interaction.reply(msg);
        }
      } finally {
        // A `/room` command (e.g. `invite`) may have just made slot 0 a room
        // participant. Re-bind so the primary client starts routing room chat;
        // `bindRoomListeners` is idempotent, so this is a no-op otherwise.
        if (interaction.commandName === 'room' && this.roomGateways && this.handleRoomMessage) {
          this.roomGateways.bindRoomListeners(this.handleRoomMessage);
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
      logger: ctx.logger,
    });
    client.on('messageCreate', handleMessageCreate);

    await client.login(discordConfig.token);

    // Bring up the multi-client room gateway pool once the primary is ready and
    // its bot user id is resolvable. With no room bots configured this just
    // registers slot 0, so a single-agent deployment is unaffected. A failing
    // pool bot is logged inside the manager and never blocks the primary bridge.
    await primaryReady;
    const roomGateways = new RoomGatewayManager({ logger: ctx.logger });
    this.roomGateways = roomGateways;
    try {
      await roomGateways.start(client);

      // Slot-0 dual-role separation: `interactionCreate` (the `/room` command
      // host) stays bound above on the primary client only; room bots register
      // no slash commands. The room chat listener is a *separate* binding,
      // attached per-client by the manager — always to pool clients, and to
      // slot 0 only when it is itself a room participant. It routes solely
      // through the kernel bus (`ctx.rooms`), so it can only bind once the bus
      // is wired (Phase 4); until then room bots log in but stay quiet.
      if (ctx.rooms) {
        // Stall detection is the honest best-effort floor for anything
        // reconnect-gap reconciliation cannot recover: if a routed mention gets
        // no follow-up, log it and post an `@human` notice into the room.
        const roomStall = new TimeoutStallDetector({
          logger: ctx.logger,
          onStall: async ({ channelId, addressee, timeoutMs }) => {
            try {
              const channel = await this.fetchSendable(channelId);
              await channel.send(
                `⚠️ @human — no response from @${addressee} in ${Math.round(timeoutMs / 1000)}s.`,
              );
            } catch (err) {
              await ctx.logger.error('discord/roomStall', `notice failed: ${String(err)}`);
            }
          },
        });
        this.roomStall = roomStall;

        const handleRoomMessage = createRoomMessageHandler({
          rooms: ctx.rooms,
          stall: roomStall,
          logger: ctx.logger,
        });
        this.handleRoomMessage = handleRoomMessage;
        roomGateways.bindRoomListeners(handleRoomMessage);
      }
    } catch (err) {
      await ctx.logger.error('discord/roomGateways', `failed to start room gateways: ${String(err)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.roomStall) {
      this.roomStall.clear();
      this.roomStall = null;
    }
    if (this.roomGateways) {
      await this.roomGateways.stop();
      this.roomGateways = null;
    }
    this.handleRoomMessage = null;
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
    try {
      await channel.send(text);
    } catch (err) {
      const rl = toRateLimitError(err);
      if (rl) throw rl;
      throw err;
    }
  }

  /**
   * Send under a distinct room persona (multi-agent rooms). Two identity
   * strategies coexist, gated on config (see the "Rooms — real bots vs. masking"
   * note in CLAUDE.md / AGENTS-providers.md):
   *
   * - **Real-bots path (room-bot slots configured).** Discord fronts a real bot
   *   account per persona: we pick the gateway client whose account is
   *   `identity.botUserId` (registered by the Phase-3 `RoomGatewayManager`) and
   *   post through it — no webhook, so personas can *natively* `@`-ping each
   *   other. Falls back to the primary client when no pool client matches
   *   (slot-0's own persona), so a missing pool never silently drops a reply.
   *
   * - **Masked-persona fallback (no room-bot pool configured).** The single
   *   primary bot mirrors every persona, prefixing the handle so readers can
   *   tell speakers apart. No native pinging — this is the documented
   *   masked-persona mode, mirroring how Slack/Teams mask one bot via
   *   `chat:write.customize`. Lets a user run rooms without provisioning N bots.
   *
   * The `sendAs` contract is identical to callers either way; only the transport
   * differs. `target.threadId` (when the room lives in a thread) takes
   * precedence over `channelId`; a Discord thread is itself a sendable channel.
   */
  async sendAs(
    target: ChannelTarget,
    identity: PersonaIdentity,
    msg: OutgoingMessage,
  ): Promise<void> {
    const realBotsConfigured = this.roomGateways?.hasRoomBots() ?? false;

    if (realBotsConfigured) {
      const client =
        (identity.botUserId
          ? this.roomGateways?.getClientForBotUserId(identity.botUserId)
          : undefined) ?? this.client;
      if (!client) throw new Error('Discord client not initialised');
      await this.postThrough(client, target, msg);
      return;
    }

    // No pool configured → documented masked-persona fallback on the primary
    // bot. Prefix the handle since a plain bot message (unlike a webhook) cannot
    // override its username per-message.
    if (!this.client) throw new Error('Discord client not initialised');
    await this.postThrough(this.client, target, msg, identity.name);
  }

  /**
   * Shared outbound for `sendAs`: fetch the target (thread over channel) via the
   * given client and post `msg.text`, applying the human `@`-mention prefix and,
   * in masked-persona mode, a `maskName` handle prefix. Rate-limit errors are
   * translated like `send()`.
   */
  private async postThrough(
    client: Client,
    target: ChannelTarget,
    msg: OutgoingMessage,
    maskName?: string,
  ): Promise<void> {
    const channel = await this.fetchSendableFrom(client, target.threadId ?? target.channelId);
    let text = msg.text;
    if (maskName) {
      text = `**${maskName}:** ${text}`;
    }
    if (msg.mention && discordConfig.mentionUserId) {
      text = `<@${discordConfig.mentionUserId}> ${text}`;
    }
    try {
      await channel.send(text);
    } catch (err) {
      const rl = toRateLimitError(err);
      if (rl) throw rl;
      throw err;
    }
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
      if (!agent) throw new AgentNotFoundError(agentId);

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
    return this.fetchSendableFrom(this.client, channelId);
  }

  private async fetchSendableFrom(
    client: Client,
    channelId: string,
  ): Promise<SendableChannels> {
    const fetched = await client.channels.fetch(channelId);
    if (!fetched?.isSendable()) {
      const err = new Error(`Channel ${channelId} is missing or not sendable`);
      void logger.error('discord/fetchSendable', err.message);
      throw err;
    }
    return fetched;
  }
}

/**
 * Translate a discord.js error into the kernel-level `RateLimitError`.
 *
 * discord.js surfaces rate limits through two shapes:
 * - `@discordjs/rest` `RateLimitError` with `status: 429` and `retryAfter` in ms
 * - `DiscordAPIError` with `status: 429` and no `retryAfter` (the API will
 *   respect the next `Retry-After` we send)
 *
 * Returns `null` when the error is not a rate-limit; the caller rethrows
 * the original error in that case.
 */
export function toRateLimitError(err: unknown): RateLimitError | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { status?: number; retryAfter?: number; name?: string };
  // `@discordjs/rest`'s RateLimitError carries a numeric `retryAfter` without a
  // `status`, so we accept either signal. Requiring `retryAfter` to be a number
  // avoids promoting unrelated errors that happen to carry a truthy property.
  if (e.status === 429 || typeof e.retryAfter === 'number') {
    return new RateLimitError(e.retryAfter ?? 1000, `Discord rate limited`);
  }
  return null;
}
