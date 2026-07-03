/**
 * Discord multi-agent rooms — room-aware `messageCreate` listener (Phase 3).
 *
 * This is the sibling of `messageCreate.ts` for the room path. It is bound
 * PER discord.js `Client` (one per pool bot; see `roomGateways.ts`), so
 * `message.client.user.id` is *this* bot's account id — the identity the
 * self/peer filter and the mention gate pivot on.
 *
 * Discord-provider code: it may touch `discord.js` types, but all room logic
 * comes from the pure kernel — `roomsDb` for participant/registry lookups and
 * `RoomGateway` for the `isRoom` check and the single `submitMessage` hop. It
 * never enqueues the next turn itself (that is the Phase 4 bus's job); routing
 * an inbound room message means calling `submitMessage(...)` exactly once for
 * the addressed bot.
 *
 * The non-room path is untouched: non-room channels are handled solely by slot
 * 0's existing `handleMessageCreate`; this listener returns immediately for
 * them, so room bots (slots 1..N) ignore non-room channels entirely.
 *
 * This is also the ONE routing path reconnect-gap reconciliation replays into
 * (`roomGateways.ts`), so it is idempotent: it advances a per-`(slot, channel)`
 * cursor on every room message it sees, and de-dupes routing on `message.id` so
 * a hop already routed live is a no-op when a `resume`-time refetch replays it.
 * The honest contract is **best-effort-with-catch-up, never exactly-once** — a
 * message dropped by the transport is recovered on the next `resume`; anything
 * reconciliation cannot see is caught by stall detection (`roomStall.ts`).
 */

import type { Message } from 'discord.js';
import type { KernelLogger, ProviderName, RoomGateway } from '../../core/types';
import { logger as defaultLogger } from '../../core/logger';
import { roomsDb as defaultRoomsDb, type RoomParticipant } from '../../core/room/roomsDb';
import { NoopStallDetector, type RoomStallDetector } from './roomStall';

const PROVIDER: ProviderName = 'discord';

/** Cap on the in-memory recently-routed set (idempotency guard, oldest evicted). */
const ROUTED_CAP = 512;

export type RoomMessageDeps = {
  /** The room bus seam — `isRoom` gate + the single-hop `submitMessage`. */
  rooms: Pick<RoomGateway, 'isRoom' | 'submitMessage'>;
  /** Kernel persistence seam (room + participant + gateway registry lookups). */
  roomsDb?: Pick<
    typeof defaultRoomsDb,
    'getRoomByChannel' | 'getParticipants' | 'getRoomBots' | 'advanceRoomBotCursor'
  >;
  /** This client's own bot account id; defaults to `message.client.user.id`. */
  getBotUserId?: (message: Message) => string | undefined;
  /** Stall detection seam; defaults to the no-op detector (no timers). */
  stall?: RoomStallDetector;
  logger?: KernelLogger;
};

/**
 * Build the per-client room listener. Every bot in a room receives every room
 * message; the mention gate ensures only the *addressed* bot acts, which is the
 * natural dedup that avoids cross-bot coordination.
 *
 * The returned handler is safe to invoke from BOTH the live `messageCreate`
 * event and the reconciliation refetch — routing de-dupes on `message.id`, so a
 * message seen through both paths routes exactly once.
 */
export function createRoomMessageHandler(deps: RoomMessageDeps) {
  const roomsDb = deps.roomsDb ?? defaultRoomsDb;
  const getBotUserId = deps.getBotUserId ?? ((m: Message) => m.client.user?.id);
  const stall = deps.stall ?? NoopStallDetector;
  const log: KernelLogger = deps.logger ?? defaultLogger;

  // Idempotency guard shared by the live listener and reconciliation replay: a
  // message already routed for a given bot is dropped the second time. The key is
  // per-(bot, message-id), NOT per-message-id: a single message can `@`-mention
  // two room bots (up to `max_mentions`), and BOTH must route — one to each
  // agent. A shared per-message-id set would let the first bot's routing suppress
  // the second addressee, silently dropping its turn. Bounded FIFO.
  const recentlyRouted = new Set<string>();
  const routeKey = (botUserId: string, messageId: string): string => `${botUserId}:${messageId}`;
  const markRouted = (key: string): void => {
    recentlyRouted.add(key);
    if (recentlyRouted.size > ROUTED_CAP) {
      const oldest = recentlyRouted.values().next().value;
      if (oldest !== undefined) recentlyRouted.delete(oldest);
    }
  };

  return async function handleRoomMessage(message: Message): Promise<void> {
    const channelId = message.channel.id;

    // Room path only. Non-room channels belong to slot 0's `handleMessageCreate`.
    if (!deps.rooms.isRoom(PROVIDER, channelId)) return;

    const thisBotUserId = getBotUserId(message);
    if (!thisBotUserId) {
      log.warn('roomMessageCreate', 'bot user id missing, skipping room message');
      return;
    }

    // slot → resolved bot account id for every registered gateway client.
    const slotToBotId = new Map(roomsDb.getRoomBots().map((b) => [b.slot, b.bot_user_id]));

    // Advance THIS client's reconnect cursor for every room message it sees —
    // whether it ends up routing or intentionally skipping. This is the
    // low-water mark reconciliation replays from, so it must move on all
    // messages, including our own and unaddressed ones.
    const thisSlot = [...slotToBotId.entries()].find(([, id]) => id === thisBotUserId)?.[0];
    if (thisSlot !== undefined) {
      roomsDb.advanceRoomBotCursor(thisSlot, channelId, message.id);
    }

    // The room is alive: a message (id !== the message that armed a pending
    // expectation) clears any stall watch for this channel.
    stall.observe(channelId, message.id);

    // The CHANGED line vs `messageCreate.ts`: drop only *self* (the loop guard),
    // never a blanket `author.bot` drop — a registered peer relay bot must pass
    // through so agents can address one another.
    if (message.author.id === thisBotUserId) return;

    const room = roomsDb.getRoomByChannel(PROVIDER, channelId);
    if (!room) return;
    const participants = roomsDb.getParticipants(room.room_key);

    // The bot accounts that render a participant of THIS room — the legitimate
    // peer relay bots. Any bot account outside this set is third-party.
    const roomBotUserIds = new Set<string>();
    let selfParticipant: RoomParticipant | undefined;
    let authorParticipant: RoomParticipant | undefined;
    for (const p of participants) {
      if (p.bot_slot == null) continue;
      const botId = slotToBotId.get(p.bot_slot);
      if (!botId) continue;
      roomBotUserIds.add(botId);
      if (botId === thisBotUserId) selfParticipant = p;
      if (botId === message.author.id) authorParticipant = p;
    }

    // Peer filter: a real user always passes; a bot passes only if it is a
    // registered peer relay bot of this room. Third-party bots are dropped.
    if (message.author.bot && !roomBotUserIds.has(message.author.id)) return;

    // This bot must itself be a room participant to act on the message.
    if (!selfParticipant) return;

    // Mention gate: only the addressed bot proceeds (natural dedup).
    if (!message.mentions.users.has(thisBotUserId)) return;

    // Idempotency guard: if THIS bot already routed this message id (live event),
    // a reconciliation replay of the same message is a no-op — exactly once per
    // bot. A different addressed bot has its own key and still routes.
    const dedupeKey = routeKey(thisBotUserId, message.id);
    if (recentlyRouted.has(dedupeKey)) return;

    // Strip this bot's own native mention (`<@id>` / `<@!id>`) from the content,
    // mirroring `messageCreate.ts`'s `mentionPattern` cleanup.
    const mentionPattern = new RegExp(`<@!?${thisBotUserId}>`, 'g');
    const cleanedText = message.content.replace(mentionPattern, '').trim();

    // Classify the author so Phase 4 can reset the turn counter on human input.
    // `fromHandle`: a peer bot uses its participant handle; a human uses their
    // display name.
    const fromKind: 'human' | 'bot' = message.author.bot ? 'bot' : 'human';
    const fromHandle =
      fromKind === 'bot'
        ? authorParticipant?.handle ?? message.author.username
        : message.member?.displayName ?? message.author.username ?? message.author.id;

    // Route exactly once for the addressed bot. The bus (Phase 4) owns the next
    // hop; we never enqueue it here.
    markRouted(dedupeKey);
    deps.rooms.submitMessage(PROVIDER, channelId, fromHandle, cleanedText, {
      toAgentId: selfParticipant.agent_id,
      fromKind,
    });

    // Arm the stall watch: we now expect a follow-up room message (the bot's
    // reply, or a human) after this one. Keyed on this message id so peer bots'
    // observations of the very same message do not clear it prematurely.
    stall.expect(channelId, selfParticipant.handle, message.id);
  };
}
