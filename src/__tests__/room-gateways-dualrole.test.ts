import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RoomGatewayManager,
  PRIMARY_SLOT,
  type RoomMessageListener,
} from '../providers/discord/roomGateways';
import type { RoomBotIdentity } from '../providers/discord/roomBots';
import type { KernelLogger } from '../core/types';

/**
 * Slot-0 dual-role separation (plan Phase 3 §Slot-0 dual-role). These tests
 * exercise `RoomGatewayManager.bindRoomListeners` in isolation: pool clients
 * (slots 1..N) always receive the room `messageCreate` listener; the primary
 * (slot 0) receives it ONLY when slot 0 is itself a room participant; and the
 * bind is idempotent (a client is never double-bound). The full inbound routing
 * path is covered by the dedicated listener/reconciliation tests.
 */

const noopLogger: KernelLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

/** Minimal discord.js `Client` stand-in that captures `messageCreate` listeners. */
class FakeClient {
  user: { id: string } | null;
  readonly messageCreateListeners: RoomMessageListener[] = [];
  private readonly onceHandlers = new Map<string, (arg: unknown) => void>();

  constructor(userId: string | null) {
    this.user = userId ? { id: userId } : null;
  }

  once(event: string, cb: (arg: unknown) => void): this {
    this.onceHandlers.set(event, cb);
    return this;
  }

  off(): this {
    return this;
  }

  on(event: string, cb: RoomMessageListener): this {
    if (event === 'messageCreate') this.messageCreateListeners.push(cb);
    return this;
  }

  async login(_token: string): Promise<string> {
    // `loginAndAwaitReady` awaits the `ready` event to read `client.user.id`.
    const ready = this.onceHandlers.get('ready');
    if (ready) ready({ user: { id: this.user!.id } });
    return 'ok';
  }
}

interface Harness {
  manager: RoomGatewayManager;
  primary: FakeClient;
  pool: FakeClient[];
}

/**
 * Build a manager with a primary (slot 0) plus `poolCount` pool clients, and a
 * stubbed `roomBotsDb` whose `isSlotParticipant` returns `slot0IsParticipant`.
 */
async function makeHarness(poolCount: number, slot0IsParticipant: boolean): Promise<Harness> {
  const primary = new FakeClient('bot-0');
  const pool: FakeClient[] = [];

  const bots: RoomBotIdentity[] = Array.from({ length: poolCount }, (_, i) => ({
    slot: String(i + 1),
    token: `token-${i + 1}`,
    clientId: `client-${i + 1}`,
    name: `Bot${i + 1}`,
  }));

  let created = 0;
  const manager = new RoomGatewayManager({
    loadRoomBots: () => bots,
    createClient: () => {
      const c = new FakeClient(`bot-${created + 1}`);
      pool.push(c);
      created += 1;
      return c as unknown as import('discord.js').Client;
    },
    roomBotsDb: {
      upsertRoomBot: () => {},
      isSlotParticipant: (slot: string) => slot === PRIMARY_SLOT && slot0IsParticipant,
    },
    logger: noopLogger,
  });

  await manager.start(primary as unknown as import('discord.js').Client);
  return { manager, primary, pool };
}

test('pool clients always get the room listener; slot 0 stays quiet when not a participant', async () => {
  const { manager, primary, pool } = await makeHarness(2, false);
  const listener: RoomMessageListener = () => {};

  manager.bindRoomListeners(listener);

  assert.equal(primary.messageCreateListeners.length, 0, 'command-host slot 0 must not route chat');
  assert.equal(pool.length, 2);
  for (const c of pool) {
    assert.equal(c.messageCreateListeners.length, 1, 'every pool client is room-only');
  }
});

test('slot 0 gets the room listener when it is itself a room participant', async () => {
  const { manager, primary, pool } = await makeHarness(1, true);
  const listener: RoomMessageListener = () => {};

  manager.bindRoomListeners(listener);

  assert.equal(primary.messageCreateListeners.length, 1, 'slot 0 routes chat only as a participant');
  assert.equal(pool[0].messageCreateListeners.length, 1);
});

test('bindRoomListeners is idempotent — no client is double-bound', async () => {
  const { manager, primary, pool } = await makeHarness(2, true);
  const listener: RoomMessageListener = () => {};

  manager.bindRoomListeners(listener);
  manager.bindRoomListeners(listener);
  manager.bindRoomListeners(listener);

  assert.equal(primary.messageCreateListeners.length, 1);
  for (const c of pool) {
    assert.equal(c.messageCreateListeners.length, 1);
  }
});
