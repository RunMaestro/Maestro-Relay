/**
 * The `/room` control surface (Phase 6) — hosted on the primary bot (slot 0).
 *
 * `/room` drives the multi-agent room lifecycle: create a room, invite agents
 * (each rendered by a real pool bot), and steer it (pause/resume/stop/reset/
 * budget/status). The command mirrors the `agents.ts` handler pattern: a single
 * `SlashCommandBuilder` with subcommands, a shared agent resolver, and ephemeral
 * replies.
 *
 * All room state lives in the provider-agnostic kernel (`roomsDb`); this file is
 * only the Discord slash-command seam. The bot-slot pool (persona name/avatar per
 * slot) comes from `loadRoomBots()` — the same pure config loader the gateway
 * manager consumes — so invite/status stay in lock-step with the running pool.
 *
 * The two deltas over the baseline command set:
 *  - **`invite` honors the global agent→bot binding**: an already-bound agent
 *    reuses its slot everywhere; a first bind allocates the next free slot and
 *    writes the binding; an explicit slot that contradicts a standing binding is
 *    rejected (pointed at `/room rebind`); no free slot on a first bind surfaces
 *    the Phase 5 onboarding-checklist error.
 *  - **`rebind`** is the only sanctioned way to change that global binding.
 *
 * `status` NEVER prints tokens — only handle, bot persona, status, spend/budget,
 * and the burst turn counter.
 */

import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';
import { maestro } from '../../../core/maestro';
import type { MaestroAgent } from '../../../core/maestro';
import { roomsDb, SlotConflictError } from '../../../core/room/roomsDb';
import type { RoomStatus } from '../../../core/room/roomsDb';
import {
  loadRoomBots,
  NO_FREE_ROOM_BOT_SLOT_ERROR,
  type RoomBotIdentity,
} from '../roomBots';
import { PRIMARY_SLOT } from '../roomGateways';

const PROVIDER = 'discord';

/** Build `${provider}:${channelId}` — the kernel's room-key encoding. */
function roomKeyFor(channelId: string): string {
  return `${PROVIDER}:${channelId}`;
}

/** Resolve a slug/id/name against the live agent list (mirrors `agents.ts`). */
async function resolveAgent(input: string): Promise<MaestroAgent | undefined> {
  const agents = await maestro.listAgents();
  return agents.find(
    (a) => a.id === input || a.id.startsWith(input) || a.name === input,
  );
}

/** The configured pool bot for a slot, or undefined if the slot is unknown. */
function identityForSlot(slot: string): RoomBotIdentity | undefined {
  return loadRoomBots().find((b) => b.slot === slot);
}

/**
 * A slot usable as a room persona: the primary bot (slot 0, always registered by
 * the gateway manager and supported as a participant by the room listener) or
 * any configured pool slot. Slot 0 has no pool persona config, so callers fall
 * back to the agent's own name as its handle.
 */
function isUsableSlot(slot: string): boolean {
  return slot === PRIMARY_SLOT || identityForSlot(slot) !== undefined;
}

export const data = new SlashCommandBuilder()
  .setName('room')
  .setDescription('Manage a multi-agent room')
  // `/room` mutates global room state and `/room invite` spends money (each bot
  // turn has a cost). Gate the whole command group to server administrators —
  // Discord's default member permissions are command-level, not per-subcommand,
  // so the money-spending subcommands are covered by gating the group. Server
  // owners can still grant finer access via Server Settings → Integrations.
  // NOTE: requires re-running `npm run deploy-commands` to take effect.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub.setName('new').setDescription('Create a room bound to this channel'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('invite')
      .setDescription('Invite an agent into this room (binds it to a real bot)')
      .addStringOption((opt) =>
        opt
          .setName('agent')
          .setDescription('Select an agent')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('slot')
          .setDescription('Bot slot to bind (defaults to the next free slot)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rebind')
      .setDescription("Change an agent's global bot persona (applies everywhere)")
      .addStringOption((opt) =>
        opt
          .setName('agent')
          .setDescription('Select an agent')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt.setName('slot').setDescription('New bot slot').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('kick')
      .setDescription('Remove an agent from this room (frees its slot)')
      .addStringOption((opt) =>
        opt
          .setName('agent')
          .setDescription('Select an agent')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('pause').setDescription('Pause all bots in this room'))
  .addSubcommand((sub) => sub.setName('resume').setDescription('Resume this room'))
  .addSubcommand((sub) => sub.setName('stop').setDescription('Halt this room'))
  .addSubcommand((sub) =>
    sub.setName('reset').setDescription('Clear sessions and reset the turn counter'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('budget')
      .setDescription('Set the room cost cap in USD')
      .addNumberOption((opt) =>
        opt
          .setName('usd')
          .setDescription('Budget in USD (0 clears the cap)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show participants, status, spend, and turn count'),
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
    await interaction.reply({
      content: 'This command must be used in a server.',
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'new':
      return handleNew(interaction);
    case 'invite':
      return handleInvite(interaction);
    case 'rebind':
      return handleRebind(interaction);
    case 'kick':
      return handleKick(interaction);
    case 'pause':
      return handleStatusChange(interaction, 'paused');
    case 'resume':
      return handleStatusChange(interaction, 'active');
    case 'stop':
      return handleStatusChange(interaction, 'halted');
    case 'reset':
      return handleReset(interaction);
    case 'budget':
      return handleBudget(interaction);
    case 'status':
      return handleStatus(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  if (roomsDb.isRoom(PROVIDER, channelId)) {
    await interaction.reply({
      content: '⚠️ This channel is already a room. Use `/room status` or `/room invite`.',
      ephemeral: true,
    });
    return;
  }

  roomsDb.createRoom({ roomKey: roomKeyFor(channelId), provider: PROVIDER, channelId });
  await interaction.reply({
    content:
      '✅ Room created for this channel. Use `/room invite <agent>` to add agents — each ' +
      'is rendered by a real bot and can `@`-ping the others.',
    ephemeral: true,
  });
}

async function handleInvite(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const room = roomsDb.getRoomByChannel(PROVIDER, interaction.channelId);
  if (!room) {
    await interaction.editReply('❌ This channel is not a room. Run `/room new` first.');
    return;
  }

  const agentInput = interaction.options.getString('agent', true);
  const agent = await resolveAgent(agentInput);
  if (!agent) {
    await interaction.editReply(
      `❌ No agent found matching \`${agentInput}\`. Use \`/agents list\` to see available agents.`,
    );
    return;
  }

  const explicitSlot = interaction.options.getString('slot') ?? null;
  const binding = roomsDb.getAgentBinding(agent.id);

  // Decide the slot: reuse a standing global binding, honor an explicit request
  // (rejecting one that contradicts the binding), else allocate the next free slot.
  let slot: string;
  if (binding !== null) {
    if (explicitSlot !== null && explicitSlot !== binding) {
      await interaction.editReply(
        `❌ Agent **${agent.name}** is globally bound to bot slot \`${binding}\`, not \`${explicitSlot}\`. ` +
          'Use `/room rebind` to deliberately change its persona everywhere.',
      );
      return;
    }
    slot = binding;
  } else if (explicitSlot !== null) {
    if (!isUsableSlot(explicitSlot)) {
      await interaction.editReply(
        `❌ Bot slot \`${explicitSlot}\` is not a configured room bot. ${NO_FREE_ROOM_BOT_SLOT_ERROR}`,
      );
      return;
    }
    slot = explicitSlot;
  } else {
    const configuredSlots = loadRoomBots().map((b) => b.slot);
    const free = roomsDb.allocateFreeSlot(room.room_key, configuredSlots);
    if (free === null) {
      await interaction.editReply(`❌ ${NO_FREE_ROOM_BOT_SLOT_ERROR}`);
      return;
    }
    slot = free;
  }

  const identity = identityForSlot(slot);
  // The persona name IS the room handle (one bot = one persona = one handle).
  const handle = identity?.name ?? agent.name;

  try {
    roomsDb.addParticipant({
      roomKey: room.room_key,
      agentId: agent.id,
      handle,
      avatarUrl: identity?.avatarUrl ?? null,
      botSlot: slot,
    });
  } catch (err) {
    if (err instanceof SlotConflictError) {
      await interaction.editReply(`❌ ${err.message}`);
      return;
    }
    throw err;
  }

  await interaction.editReply(
    `✅ Invited **${agent.name}** as **@${handle}** (bot slot \`${slot}\`).` +
      (binding === null ? ' Bound this persona to the agent everywhere.' : ''),
  );
}

async function handleRebind(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const agentInput = interaction.options.getString('agent', true);
  const slot = interaction.options.getString('slot', true);
  const agent = await resolveAgent(agentInput);
  if (!agent) {
    await interaction.editReply(
      `❌ No agent found matching \`${agentInput}\`. Use \`/agents list\` to see available agents.`,
    );
    return;
  }

  if (!isUsableSlot(slot)) {
    await interaction.editReply(
      `❌ Bot slot \`${slot}\` is not a configured room bot. ${NO_FREE_ROOM_BOT_SLOT_ERROR}`,
    );
    return;
  }
  // Slot 0 (primary bot) has no pool persona config → fall back to the agent's name.
  const identity = identityForSlot(slot);
  const handle = identity?.name ?? agent.name;
  const avatarUrl = identity?.avatarUrl ?? null;

  try {
    // Propagate the new persona's handle + avatar (not just the slot) to every
    // participant row so the preamble and `@Handle` addressing follow the rebind.
    roomsDb.rebindAgent(agent.id, slot, handle, avatarUrl);
  } catch (err) {
    if (err instanceof SlotConflictError) {
      await interaction.editReply(`❌ ${err.message}`);
      return;
    }
    throw err;
  }

  await interaction.editReply(
    `✅ Rebound **${agent.name}** to bot slot \`${slot}\` (**@${handle}**). ` +
      '⚠️ This changes the persona in **every** room the agent is in.',
  );
}

async function handleKick(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const room = roomsDb.getRoomByChannel(PROVIDER, interaction.channelId);
  if (!room) {
    await interaction.editReply('❌ This channel is not a room.');
    return;
  }

  const agentInput = interaction.options.getString('agent', true);
  const agent = await resolveAgent(agentInput);
  if (!agent) {
    await interaction.editReply(
      `❌ No agent found matching \`${agentInput}\`. Use \`/room status\` to see participants.`,
    );
    return;
  }

  const participant = roomsDb.getParticipant(room.room_key, agent.id);
  if (!participant) {
    await interaction.editReply(`❌ **${agent.name}** is not a participant of this room.`);
    return;
  }

  roomsDb.removeParticipant(room.room_key, agent.id);
  await interaction.editReply(
    `✅ Removed **${agent.name}** from this room; bot slot \`${participant.bot_slot ?? '—'}\` is free again.`,
  );
}

async function handleStatusChange(
  interaction: ChatInputCommandInteraction,
  status: RoomStatus,
): Promise<void> {
  const room = roomsDb.getRoomByChannel(PROVIDER, interaction.channelId);
  if (!room) {
    await interaction.reply({ content: '❌ This channel is not a room.', ephemeral: true });
    return;
  }

  roomsDb.setStatus(room.room_key, status);
  const label =
    status === 'active' ? '▶️ resumed' : status === 'paused' ? '⏸️ paused' : '🛑 halted';
  await interaction.reply({
    content: `Room ${label}. All bots read this state before replying.`,
    ephemeral: true,
  });
}

async function handleReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = roomsDb.getRoomByChannel(PROVIDER, interaction.channelId);
  if (!room) {
    await interaction.reply({ content: '❌ This channel is not a room.', ephemeral: true });
    return;
  }

  roomsDb.clearSessions(room.room_key);
  roomsDb.resetTurnCount(room.room_key);
  roomsDb.resetLifetimeTurnCount(room.room_key);
  // Reactivate the room. A room halted by a turn/budget brake stays `halted`,
  // and the bus drops turns for any non-active room — so without this a `/room
  // reset` would clear the counters but leave the room dead, forcing the user to
  // additionally guess `/room resume`. Reset is the "unstick and start over"
  // action, so it returns the room to `active` in lock-step with the counters.
  roomsDb.setStatus(room.room_key, 'active');
  await interaction.reply({
    content:
      '🔄 Cleared all participant sessions, reset the burst + lifetime turn counters, ' +
      'and reactivated the room.',
    ephemeral: true,
  });
}

async function handleBudget(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = roomsDb.getRoomByChannel(PROVIDER, interaction.channelId);
  if (!room) {
    await interaction.reply({ content: '❌ This channel is not a room.', ephemeral: true });
    return;
  }

  const usd = interaction.options.getNumber('usd', true);
  if (usd < 0) {
    await interaction.reply({ content: '❌ Budget cannot be negative.', ephemeral: true });
    return;
  }

  // 0 clears the cap (unlimited); any positive value sets it.
  const budget = usd === 0 ? null : usd;
  roomsDb.setBudget(room.room_key, budget);
  await interaction.reply({
    content:
      budget === null
        ? '💸 Budget cap cleared — this room is now uncapped.'
        : `💸 Budget cap set to $${budget.toFixed(2)}.`,
    ephemeral: true,
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const room = roomsDb.getRoomByChannel(PROVIDER, interaction.channelId);
  if (!room) {
    await interaction.reply({ content: '❌ This channel is not a room.', ephemeral: true });
    return;
  }

  const participants = roomsDb.getParticipants(room.room_key);
  const budgetLabel =
    room.budget_usd === null ? 'uncapped' : `$${room.budget_usd.toFixed(2)}`;

  // NEVER print tokens — only spend, budget, and the burst turn counter.
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Room status')
    .addFields(
      { name: 'Status', value: room.status, inline: true },
      {
        name: 'Spend',
        value: `$${room.spent_usd.toFixed(4)} / ${budgetLabel}`,
        inline: true,
      },
      {
        name: 'Turns',
        value: `${room.turn_count} / ${room.max_turns} (this burst)`,
        inline: true,
      },
    );

  if (participants.length === 0) {
    embed.setDescription('_No participants yet — use `/room invite <agent>`._');
  } else {
    const lines = participants.map((p) => {
      const slot = p.bot_slot;
      const persona = slot ? identityForSlot(slot)?.name ?? `slot ${slot}` : 'unbound';
      const botUserId = slot ? roomsDb.getRoomBotUserId(slot) : null;
      const bot = botUserId ? `<@${botUserId}>` : `slot \`${slot ?? '—'}\``;
      return `**@${p.handle}** → \`${p.agent_id}\` · persona **${persona}** (${bot})`;
    });
    embed.setDescription(lines.join('\n'));
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
