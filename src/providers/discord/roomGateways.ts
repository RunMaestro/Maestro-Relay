/**
 * Discord multi-agent rooms — multi-client gateway manager (Phase 3).
 *
 * One process, N discord.js `Client`s: the primary bot (slot "0", constructed by
 * `DiscordProvider` and reused here as the `/room` command host + slot-0
 * participant) plus one client per pool bot (`RoomBotIdentity` from
 * `loadRoomBots()`, slots "1".."N"). On `start()` each pool client logs in with
 * its own token; the resolved `client.user.id` is recorded into an in-memory
 * `slot → { client, botUserId }` map and upserted into the `room_bots` registry
 * table via the pure kernel `roomsDb` — the bot user id ONLY, never the token.
 *
 * This is Discord-provider code, so it may import `discord.js`, but it drives no
 * room logic itself: it calls the kernel (`roomsDb`) for persistence and exposes
 * `getClientForSlot` / `getBotUserIdForSlot` for Phase 4's outbound and the
 * room listener's per-client binding.
 *
 * Ownership: the manager OWNS (and on `stop()` destroys) only the pool clients
 * it constructed. The primary client is registered, not owned — `DiscordProvider`
 * built it and tears it down in its own `stop()`; destroying it here would double
 * free it.
 */

import { Client, GatewayIntentBits, type Message } from 'discord.js';
import type { KernelLogger } from '../../core/types';
import { logger as defaultLogger } from '../../core/logger';
import { roomsDb } from '../../core/room/roomsDb';
import { loadRoomBots as defaultLoadRoomBots, type RoomBotIdentity } from './roomBots';

/** Slot id of the primary Discord bot — the `/room` command host and slot-0 participant. */
export const PRIMARY_SLOT = '0';

/** Intents required for room gateways — copied verbatim from `adapter.ts` slot-0 construction. */
const ROOM_BOT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
] as const;

/** A logged-in client bound to a slot, with its resolved bot account id. */
export interface SlotClient {
  slot: string;
  client: Client;
  botUserId: string;
}

/** The room-aware `messageCreate` handler bound per client (see `roomMessageCreate.ts`). */
export type RoomMessageListener = (message: Message) => void | Promise<void>;

/**
 * Kernel persistence seam for the gateway manager. The two registry writes
 * (`upsertRoomBot`, `isSlotParticipant`) are required; the reconciliation
 * reads (`getRoomsForSlot`, `getRoomBotCursor`) are optional on the override so
 * existing test stubs that never trigger reconciliation stay valid — the real
 * `roomsDb` default supplies all four.
 */
type RoomGatewayDbSeam = Pick<typeof roomsDb, 'upsertRoomBot' | 'isSlotParticipant'> &
  Partial<Pick<typeof roomsDb, 'getRoomsForSlot' | 'getRoomBotCursor'>>;

export interface RoomGatewayManagerDeps {
  /** Override for tests; defaults to the env-driven pool loader. */
  loadRoomBots?: () => RoomBotIdentity[];
  /** Override for tests; defaults to a real `Client` with the room intents. */
  createClient?: () => Client;
  /** Kernel persistence seam (the `room_bots` registry + cursors); defaults to `roomsDb`. */
  roomBotsDb?: RoomGatewayDbSeam;
  logger?: KernelLogger;
}

/**
 * Log a client in and resolve with its bot user id once the gateway is ready.
 * `client.login()` can resolve before `client.user` is populated, so we await
 * the `ready` event to read the account id reliably.
 */
async function loginAndAwaitReady(client: Client, token: string): Promise<string> {
  const ready = new Promise<string>((resolve, reject) => {
    const onError = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
    client.once('ready', (c) => {
      client.off('error', onError);
      resolve(c.user.id);
    });
    client.once('error', onError);
  });
  await client.login(token);
  return ready;
}

export class RoomGatewayManager {
  private readonly slots = new Map<string, SlotClient>();
  /** Clients this manager constructed and must destroy on stop (excludes the primary). */
  private readonly ownedClients: Client[] = [];
  /** Clients already carrying the room listener — the idempotency guard for `bindRoomListeners`. */
  private readonly listenerBound = new Set<Client>();
  private readonly loadRoomBots: () => RoomBotIdentity[];
  private readonly createClient: () => Client;
  private readonly roomBotsDb: RoomGatewayDbSeam;
  private readonly log: KernelLogger;

  constructor(deps: RoomGatewayManagerDeps = {}) {
    this.loadRoomBots = deps.loadRoomBots ?? defaultLoadRoomBots;
    this.createClient =
      deps.createClient ?? (() => new Client({ intents: [...ROOM_BOT_INTENTS] }));
    this.roomBotsDb = deps.roomBotsDb ?? roomsDb;
    this.log = deps.logger ?? defaultLogger;
  }

  /**
   * Register the primary client as slot 0, then construct + login one client per
   * configured pool bot, recording each resolved bot user id. Safe with an empty
   * pool: it just registers slot 0 (a single-agent deployment is unaffected).
   *
   * @param primaryClient the already-logged-in `DiscordProvider` client.
   */
  async start(primaryClient: Client): Promise<void> {
    const primaryId = primaryClient.user?.id;
    if (!primaryId) {
      throw new Error(
        'RoomGatewayManager.start: primary client is not ready (client.user.id missing)',
      );
    }
    this.registerSlot(PRIMARY_SLOT, primaryClient, primaryId);

    for (const bot of this.loadRoomBots()) {
      const client = this.createClient();
      this.ownedClients.push(client);
      try {
        const botUserId = await loginAndAwaitReady(client, bot.token);
        this.registerSlot(bot.slot, client, botUserId);
        this.log.info(
          'discord/roomGateways',
          `room bot slot ${bot.slot} (${bot.name}) logged in as ${botUserId}`,
        );
      } catch (err) {
        // A single bad token must not take down the whole pool or the primary.
        await this.log.error(
          'discord/roomGateways',
          `room bot slot ${bot.slot} (${bot.name}) failed to log in: ${String(err)}`,
        );
      }
    }
  }

  private registerSlot(slot: string, client: Client, botUserId: string): void {
    this.slots.set(slot, { slot, client, botUserId });
    this.roomBotsDb.upsertRoomBot(slot, botUserId);
  }

  /** The client bound to a slot (for Phase 4 outbound), or undefined if unregistered. */
  getClientForSlot(slot: string): Client | undefined {
    return this.slots.get(slot)?.client;
  }

  /** The resolved bot user id for a slot (for the self/peer filter), or undefined. */
  getBotUserIdForSlot(slot: string): string | undefined {
    return this.slots.get(slot)?.botUserId;
  }

  /** Every registered slot (primary + pool) — the set the room listener binds per-client. */
  getSlots(): SlotClient[] {
    return [...this.slots.values()];
  }

  /**
   * Bind the room-aware `messageCreate` listener per client, enforcing slot 0's
   * dual-role separation (plan Phase 3 §Slot-0 dual-role):
   *
   *  - **Pool clients (slots 1..N)** are room-only: they always get the listener.
   *  - **The primary (slot 0)** wears two independent hats. It is the `/room`
   *    slash-command host — that `interactionCreate` binding lives on
   *    `DiscordProvider`'s client and is untouched here. It is *also* a room
   *    participant, but only when it has actually been invited into a room. So
   *    the chat listener is bound to slot 0 ONLY if `slot 0` is a room
   *    participant; the command host must never route chat.
   *
   * The listener and the command host share no state — they are two independent
   * event bindings. The bind is **idempotent**: a client is never double-bound,
   * so this is safe to re-invoke (e.g. after a `/room` invite makes slot 0 a
   * participant for the first time).
   */
  bindRoomListeners(listener: RoomMessageListener): void {
    for (const { slot, client } of this.slots.values()) {
      if (slot === PRIMARY_SLOT && !this.roomBotsDb.isSlotParticipant(PRIMARY_SLOT)) {
        // Slot 0 is only the command host right now — do not route chat through it.
        continue;
      }
      if (this.listenerBound.has(client)) continue;
      client.on('messageCreate', listener);
      this.bindReconciliation(slot, client, listener);
      this.listenerBound.add(client);
    }
  }

  /**
   * Hook the gateway lifecycle for reconnect-gap reconciliation (plan Phase 3
   * §Reconciliation & stall detection — MUST). The A→B hop is a best-effort
   * `messageCreate` push: a client mid-reconnect silently misses it. On every
   * `shardResume` — and on a `shardReady` that follows a `shardReconnecting`
   * (not the initial ready) — we catch that client up by refetching each room
   * channel's messages after its last-seen cursor and replaying them through
   * the SAME listener. This is best-effort-with-catch-up, never exactly-once;
   * the listener's `message.id` de-dupe makes replay a no-op.
   */
  private bindReconciliation(
    slot: string,
    client: Client,
    listener: RoomMessageListener,
  ): void {
    const reconnecting = new Set<number>();
    client.on('shardReconnecting', (shardId: number) => {
      reconnecting.add(shardId);
    });
    client.on('shardResume', (shardId: number) => {
      reconnecting.delete(shardId);
      void this.reconcileSlot(slot, client, listener);
    });
    client.on('shardReady', (shardId: number) => {
      // Only catch up when this shard just came back from a reconnect — the
      // first ready of a fresh login has nothing to reconcile.
      if (reconnecting.delete(shardId)) {
        void this.reconcileSlot(slot, client, listener);
      }
    });
  }

  /**
   * Refetch and replay any room messages this slot's client missed while its
   * gateway was down. For each room the bot participates in, page forward from
   * the `(slot, channel)` cursor (`fetch({ after, limit: 100 })`, oldest-first)
   * and feed every message back through the live listener. A slot with no
   * cursor yet has no low-water mark, so there is nothing to catch up on.
   */
  private async reconcileSlot(
    slot: string,
    client: Client,
    listener: RoomMessageListener,
  ): Promise<void> {
    const rooms = this.roomBotsDb.getRoomsForSlot?.(slot) ?? [];
    for (const room of rooms) {
      const channelId = room.channel_id;
      const cursor = this.roomBotsDb.getRoomBotCursor?.(slot, channelId) ?? null;
      if (cursor === null) continue; // no low-water mark yet — never seen a message here.
      let after: string = cursor;
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || !('messages' in channel)) continue;
        for (;;) {
          const batch = await channel.messages.fetch({ after, limit: 100 });
          if (batch.size === 0) break;
          // discord.js returns newest-first; replay oldest-first so the cursor
          // and any ordering-sensitive routing advance in chronological order.
          const ordered = [...batch.values()].sort((a, b) =>
            BigInt(a.id) < BigInt(b.id) ? -1 : 1,
          );
          for (const msg of ordered) {
            try {
              await listener(msg);
            } catch (err) {
              await this.log.error(
                'discord/roomGateways',
                `reconciliation replay failed for message ${msg.id}: ${String(err)}`,
              );
            }
          }
          after = ordered[ordered.length - 1].id;
          if (batch.size < 100) break;
        }
      } catch (err) {
        await this.log.error(
          'discord/roomGateways',
          `reconciliation fetch failed for slot ${slot} channel ${channelId}: ${String(err)}`,
        );
      }
    }
  }

  /** Destroy every pool client this manager constructed; the primary is left to its owner. */
  async stop(): Promise<void> {
    for (const client of this.ownedClients) {
      try {
        await client.destroy();
      } catch (err) {
        await this.log.error(
          'discord/roomGateways',
          `failed to destroy room bot client: ${String(err)}`,
        );
      }
    }
    this.ownedClients.length = 0;
    this.slots.clear();
    this.listenerBound.clear();
  }
}
