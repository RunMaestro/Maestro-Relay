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

import { Client, GatewayIntentBits } from 'discord.js';
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

export interface RoomGatewayManagerDeps {
  /** Override for tests; defaults to the env-driven pool loader. */
  loadRoomBots?: () => RoomBotIdentity[];
  /** Override for tests; defaults to a real `Client` with the room intents. */
  createClient?: () => Client;
  /** Kernel persistence seam (the `room_bots` registry); defaults to `roomsDb`. */
  roomBotsDb?: Pick<typeof roomsDb, 'upsertRoomBot'>;
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
  private readonly loadRoomBots: () => RoomBotIdentity[];
  private readonly createClient: () => Client;
  private readonly roomBotsDb: Pick<typeof roomsDb, 'upsertRoomBot'>;
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
  }
}
