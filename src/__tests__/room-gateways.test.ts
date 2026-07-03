import test from 'node:test';
import assert from 'node:assert/strict';

import type { Message } from 'discord.js';

import { createRoomMessageHandler } from '../providers/discord/roomMessageCreate';
import {
  RoomGatewayManager,
  PRIMARY_SLOT,
  type RoomMessageListener,
} from '../providers/discord/roomGateways';
import type { RoomBotIdentity } from '../providers/discord/roomBots';
import type { RoomParticipant, RoomRecord } from '../core/room/roomsDb';
import type { KernelLogger, ProviderName, RoomSubmitOptions } from '../core/types';

/**
 * Listener + reconciliation unit tests for the Discord multi-agent room path
 * (plan Phase 3). Everything is stubbed — no real `discord.js` `Client`, no
 * SQLite — so these assert the pure routing contract of
 * `createRoomMessageHandler` and `RoomGatewayManager.reconcileSlot`:
 *
 *  - only the *addressed* bot's listener calls `submitMessage` (mention dedup);
 *  - a bot never routes its own post (self-filter), a registered peer relay bot
 *    DOES route, a third-party bot does not (the corrected peer filter, not a
 *    blanket `author.bot` drop);
 *  - reconnect-gap reconciliation replays a missed message through the SAME
 *    listener and routes it exactly once; a message seen live + replayed routes
 *    exactly once (de-dupe on `message.id`); the cursor advances monotonically
 *    and reconciliation fetches strictly `after` it;
 *  - slot-0 dual-role: a room message does not route to slot 0 unless slot 0 is
 *    itself a room participant.
 */

const noopLogger: KernelLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

const PROVIDER: ProviderName = 'discord';
const CHANNEL = 'room-chan';
const ROOM_KEY = 'discord:room-chan';

// Ada = slot 1 / bot-ada, Ben = slot 2 / bot-ben. Both are room participants.
const ADA: RoomParticipant = {
  room_key: ROOM_KEY,
  agent_id: 'agent-ada',
  handle: 'Ada',
  avatar_url: null,
  session_id: null,
  bot_slot: '1',
  created_at: 1,
};
const BEN: RoomParticipant = {
  room_key: ROOM_KEY,
  agent_id: 'agent-ben',
  handle: 'Ben',
  avatar_url: null,
  session_id: null,
  bot_slot: '2',
  created_at: 2,
};
const ROOM: RoomRecord = {
  room_key: ROOM_KEY,
  provider: PROVIDER,
  channel_id: CHANNEL,
  thread_id: null,
  status: 'active',
  budget_usd: null,
  spent_usd: 0,
  max_mentions: 2,
  max_turns: 30,
  turn_count: 0,
  max_lifetime_turns: 500,
  lifetime_turn_count: 0,
  created_at: 0,
};

/**
 * In-memory stand-in for `roomsDb`, shared by the listener (participant/registry
 * lookups + cursor writes) and the gateway manager (reconciliation reads). The
 * cursor logic mirrors the real forward-only snowflake compare so monotonicity
 * is genuinely exercised, not stubbed away.
 */
function makeRoomsDb(participants: RoomParticipant[] = [ADA, BEN]) {
  const cursors = new Map<string, string>();
  const key = (slot: string, channelId: string) => `${slot}:${channelId}`;
  const roomBots = [
    { slot: '1', bot_user_id: 'bot-ada' },
    { slot: '2', bot_user_id: 'bot-ben' },
  ];
  return {
    cursors,
    seedCursor(slot: string, channelId: string, id: string) {
      cursors.set(key(slot, channelId), id);
    },
    getRoomByChannel(_p: string, channelId: string): RoomRecord | undefined {
      return channelId === CHANNEL ? ROOM : undefined;
    },
    getParticipants(_roomKey: string): RoomParticipant[] {
      return participants;
    },
    getRoomBots() {
      return roomBots;
    },
    isSlotParticipant(slot: string): boolean {
      return participants.some((p) => p.bot_slot === slot);
    },
    getRoomsForSlot(slot: string): RoomRecord[] {
      return participants.some((p) => p.bot_slot === slot) ? [ROOM] : [];
    },
    getRoomBotCursor(slot: string, channelId: string): string | null {
      return cursors.get(key(slot, channelId)) ?? null;
    },
    advanceRoomBotCursor(slot: string, channelId: string, messageId: string): void {
      const cur = cursors.get(key(slot, channelId)) ?? null;
      if (cur !== null && BigInt(messageId) <= BigInt(cur)) return; // forward-only
      cursors.set(key(slot, channelId), messageId);
    },
    upsertRoomBot() {},
  };
}

type RoomsDbStub = ReturnType<typeof makeRoomsDb>;

interface SubmitCall {
  from: string;
  text: string;
  opts?: RoomSubmitOptions;
}

/** A room listener bound to `botUserId`, with a spy over its `submitMessage` hops. */
function makeHandler(db: RoomsDbStub, botUserId: string) {
  const submits: SubmitCall[] = [];
  const rooms = {
    isRoom: (p: ProviderName, c: string) => p === PROVIDER && c === CHANNEL,
    submitMessage: (
      _p: ProviderName,
      _c: string,
      from: string,
      text: string,
      opts?: RoomSubmitOptions,
    ) => {
      submits.push({ from, text, opts });
    },
  };
  const handler = createRoomMessageHandler({
    rooms,
    roomsDb: db,
    getBotUserId: () => botUserId,
    logger: noopLogger,
  });
  return { handler, submits };
}

interface MessageOpts {
  id: string;
  authorId: string;
  bot?: boolean;
  username?: string;
  displayName?: string;
  content?: string;
  mentions?: string[];
  channelId?: string;
  clientBotId?: string;
}

function makeMessage(opts: MessageOpts): Message {
  const mentions = opts.mentions ?? [];
  return {
    id: opts.id,
    content: opts.content ?? '',
    channel: { id: opts.channelId ?? CHANNEL },
    author: { id: opts.authorId, bot: opts.bot ?? false, username: opts.username ?? 'user' },
    member: opts.displayName ? { displayName: opts.displayName } : null,
    client: { user: { id: opts.clientBotId ?? 'unused' } },
    mentions: { users: { has: (uid: string) => mentions.includes(uid) } },
  } as unknown as Message;
}

// --- listener: mention dedup ------------------------------------------------

test('only the addressed bot routes — mention Ben, Ada no-ops', async () => {
  const db = makeRoomsDb();
  const ada = makeHandler(db, 'bot-ada');
  const ben = makeHandler(db, 'bot-ben');

  const msg = makeMessage({
    id: '100',
    authorId: 'user-1',
    displayName: 'Alice',
    content: '<@bot-ben> ping',
    mentions: ['bot-ben'],
  });

  // Every bot sees every room message; only the mentioned one acts.
  await ada.handler(msg);
  await ben.handler(msg);

  assert.equal(ben.submits.length, 1, 'the addressed bot routes exactly once');
  assert.equal(ada.submits.length, 0, 'an unaddressed bot no-ops (mention gate)');
  assert.equal(ben.submits[0].from, 'Alice');
  assert.equal(ben.submits[0].text, 'ping', 'own mention stripped from content');
  assert.deepEqual(ben.submits[0].opts, { toAgentId: 'agent-ben', fromKind: 'human' });
});

test('a room message that mentions nobody routes to no bot', async () => {
  const db = makeRoomsDb();
  const ben = makeHandler(db, 'bot-ben');

  await ben.handler(
    makeMessage({ id: '101', authorId: 'user-1', content: 'just chatting', mentions: [] }),
  );

  assert.equal(ben.submits.length, 0);
});

// --- listener: self / peer / third-party filter -----------------------------

test("a bot's own post never routes on its own listener (self-filter)", async () => {
  const db = makeRoomsDb();
  const ben = makeHandler(db, 'bot-ben');

  // Ben's own message, even mentioning himself, must be dropped by the self-loop
  // guard (`author.id === thisBotUserId`).
  await ben.handler(
    makeMessage({
      id: '102',
      authorId: 'bot-ben',
      bot: true,
      content: '<@bot-ben> reply',
      mentions: ['bot-ben'],
    }),
  );

  assert.equal(ben.submits.length, 0);
});

test('a registered peer relay bot addressing Ben DOES route', async () => {
  const db = makeRoomsDb();
  const ben = makeHandler(db, 'bot-ben');

  // Ada (a registered peer relay bot of this room) mentions Ben.
  await ben.handler(
    makeMessage({
      id: '103',
      authorId: 'bot-ada',
      bot: true,
      username: 'AdaBot',
      content: '<@bot-ben> your turn',
      mentions: ['bot-ben'],
    }),
  );

  assert.equal(ben.submits.length, 1, 'peer relay bot passes the filter');
  assert.equal(ben.submits[0].from, 'Ada', 'peer bot routes under its participant handle');
  assert.deepEqual(ben.submits[0].opts, { toAgentId: 'agent-ben', fromKind: 'bot' });
});

test('a third-party bot addressing Ben does NOT route', async () => {
  const db = makeRoomsDb();
  const ben = makeHandler(db, 'bot-ben');

  // A bot that is not a registered participant of this room — dropped by the
  // peer filter, NOT allowed through by a blanket `author.bot` relax.
  await ben.handler(
    makeMessage({
      id: '104',
      authorId: 'bot-stranger',
      bot: true,
      content: '<@bot-ben> spam',
      mentions: ['bot-ben'],
    }),
  );

  assert.equal(ben.submits.length, 0);
});

// --- listener: message.id de-dupe -------------------------------------------

test('the same message routes exactly once — de-dupe on message.id', async () => {
  const db = makeRoomsDb();
  const ben = makeHandler(db, 'bot-ben');

  const msg = makeMessage({
    id: '105',
    authorId: 'user-1',
    content: '<@bot-ben> hi',
    mentions: ['bot-ben'],
  });

  // Feeding the same message twice (as a live event then a reconciliation
  // replay would) routes it only once — the `recentlyRouted` guard.
  await ben.handler(msg);
  await ben.handler(msg);

  assert.equal(ben.submits.length, 1);
});

// --- listener: cursor advance is monotonic ----------------------------------

test('the reconnect cursor advances forward on every seen message and never rewinds', async () => {
  const db = makeRoomsDb();
  const ben = makeHandler(db, 'bot-ben');

  // Ben's cursor moves to the newest message id it observes — routed OR skipped.
  await ben.handler(makeMessage({ id: '200', authorId: 'user-1', mentions: [] }));
  assert.equal(db.getRoomBotCursor('2', CHANNEL), '200', 'cursor advances on a skipped message');

  await ben.handler(
    makeMessage({ id: '400', authorId: 'user-1', content: '<@bot-ben>', mentions: ['bot-ben'] }),
  );
  assert.equal(db.getRoomBotCursor('2', CHANNEL), '400', 'cursor advances on a routed message');

  // An out-of-order older message must not rewind the low-water mark.
  await ben.handler(makeMessage({ id: '300', authorId: 'user-1', mentions: [] }));
  assert.equal(db.getRoomBotCursor('2', CHANNEL), '400', 'cursor never rewinds');
});

// --- listener: slot-0 dual-role ---------------------------------------------

test('a room message does not route to slot 0 when slot 0 is not a participant', async () => {
  // Only Ada + Ben participate; slot 0 (bot-0) is the command host, not a
  // participant. A message mentioning bot-0 must not route on a slot-0 listener.
  const db = makeRoomsDb();
  const slot0 = makeHandler(db, 'bot-0');

  await slot0.handler(
    makeMessage({
      id: '106',
      authorId: 'user-1',
      content: '<@bot-0> hello',
      mentions: ['bot-0'],
    }),
  );

  assert.equal(slot0.submits.length, 0, 'a non-participant slot-0 client routes no chat');
});

// --- reconciliation via the gateway manager ---------------------------------

/**
 * A discord.js `Client` stand-in for the reconciliation path: captures gateway
 * event handlers (so a test can fire `shardResume`), and serves a fixed pool of
 * "missed" messages via `channels.fetch(...).messages.fetch({ after })`.
 */
class FakeGatewayClient {
  user: { id: string };
  readonly fetchAfter: string[] = [];
  private readonly onceHandlers = new Map<string, (arg: unknown) => void>();
  private readonly handlers = new Map<string, Array<(arg: unknown) => void>>();
  private readonly channel: unknown;

  constructor(userId: string, missed: Message[]) {
    this.user = { id: userId };
    const nextBatch = (after: string) => {
      const hits = missed.filter((m) => BigInt(m.id) > BigInt(after));
      return new Map(hits.map((m) => [m.id, m]));
    };
    this.channel = {
      id: CHANNEL,
      isTextBased: () => true,
      messages: {
        fetch: async ({ after }: { after: string; limit: number }) => {
          this.fetchAfter.push(after);
          return nextBatch(after);
        },
      },
    };
  }

  channels = { fetch: async (_id: string) => this.channel };

  once(event: string, cb: (arg: unknown) => void): this {
    this.onceHandlers.set(event, cb);
    return this;
  }
  off(): this {
    return this;
  }
  on(event: string, cb: (arg: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) cb(arg);
  }
  async login(_token: string): Promise<string> {
    this.onceHandlers.get('ready')?.({ user: { id: this.user.id } });
    return 'ok';
  }
}

/**
 * Stand up a manager whose only pool bot is Ben (slot 2), reusing a real room
 * listener over a shared `roomsDb` stub, and return the pieces a reconciliation
 * test drives.
 */
function makeReconHarness(missed: Message[]) {
  const db = makeRoomsDb();
  const { handler, submits } = makeHandler(db, 'bot-ben');
  const benClient = new FakeGatewayClient('bot-ben', missed);
  const primary = { user: { id: 'bot-0' } };

  const bots: RoomBotIdentity[] = [
    { slot: '2', token: 'token-ben', clientId: 'client-ben', name: 'Ben' },
  ];

  const manager = new RoomGatewayManager({
    loadRoomBots: () => bots,
    createClient: () => benClient as unknown as import('discord.js').Client,
    roomBotsDb: db,
    logger: noopLogger,
  });

  return { db, manager, benClient, primary, handler: handler as RoomMessageListener, submits };
}

test('reconciliation replays a message delivered ONLY via fetch, exactly once, after the cursor', async () => {
  const missed = makeMessage({
    id: '200',
    authorId: 'user-1',
    displayName: 'Alice',
    content: '<@bot-ben> catch up',
    mentions: ['bot-ben'],
    clientBotId: 'bot-ben',
  });
  const { db, manager, benClient, primary, handler, submits } = makeReconHarness([missed]);

  await manager.start(primary as unknown as import('discord.js').Client);
  // Ben missed message 200 while its gateway was down; its cursor lags at 100.
  db.seedCursor('2', CHANNEL, '100');
  manager.bindRoomListeners(handler);

  // Gateway comes back — reconciliation kicks in.
  benClient.emit('shardResume', 0);
  await new Promise((r) => setImmediate(r)); // let the async replay settle

  assert.equal(submits.length, 1, 'the missed message routes exactly once via replay');
  assert.equal(submits[0].from, 'Alice');
  assert.equal(submits[0].text, 'catch up');
  assert.deepEqual(benClient.fetchAfter, ['100'], 'fetch pages strictly after the cursor');
  assert.equal(db.getRoomBotCursor('2', CHANNEL), '200', 'replay advances the cursor');

  await manager.stop();
});

test('a message seen live AND replayed by reconciliation routes exactly once', async () => {
  const live = makeMessage({
    id: '200',
    authorId: 'user-1',
    displayName: 'Alice',
    content: '<@bot-ben> hi',
    mentions: ['bot-ben'],
    clientBotId: 'bot-ben',
  });
  const { db, manager, benClient, primary, handler, submits } = makeReconHarness([live]);

  await manager.start(primary as unknown as import('discord.js').Client);
  db.seedCursor('2', CHANNEL, '100');
  manager.bindRoomListeners(handler);

  // Live delivery routes it (and advances the cursor to 200).
  await handler(live);
  assert.equal(submits.length, 1);

  // Simulate a cursor that lagged behind the live-routed message (e.g. the
  // advance did not persist before the gateway dropped): rewind it so the
  // refetch WILL re-serve message 200 — the exact race the id-dedupe guards.
  db.seedCursor('2', CHANNEL, '100');
  benClient.emit('shardResume', 0);
  await new Promise((r) => setImmediate(r));

  assert.equal(submits.length, 1, 'live + replay of the same id routes exactly once');

  await manager.stop();
});

test('reconciliation only fires on a reconnect, not on the initial shardReady', async () => {
  const missed = makeMessage({
    id: '200',
    authorId: 'user-1',
    content: '<@bot-ben> x',
    mentions: ['bot-ben'],
    clientBotId: 'bot-ben',
  });
  const { db, manager, benClient, primary, handler, submits } = makeReconHarness([missed]);

  await manager.start(primary as unknown as import('discord.js').Client);
  db.seedCursor('2', CHANNEL, '100');
  manager.bindRoomListeners(handler);

  // A fresh login's first shardReady (no preceding shardReconnecting) must NOT
  // trigger a catch-up fetch.
  benClient.emit('shardReady', 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(benClient.fetchAfter.length, 0, 'initial ready does not reconcile');
  assert.equal(submits.length, 0);

  // After a reconnect, the following shardReady DOES reconcile.
  benClient.emit('shardReconnecting', 0);
  benClient.emit('shardReady', 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(submits.length, 1, 'shardReady after shardReconnecting catches up');

  await manager.stop();
});

// --- slot-0 dual-role at the manager level ----------------------------------

test('no room listener is attached to slot 0 when it is not a participant; /room still works on slot 0', async () => {
  // Only Ben participates → slot 0 is the command host only. bindRoomListeners
  // must attach the chat listener to Ben's client but never to slot 0.
  const db = makeRoomsDb([BEN]);
  const benClient = new FakeGatewayClient('bot-ben', []);
  let interactionBound = false;
  const primary = {
    user: { id: 'bot-0' },
    on(event: string) {
      if (event === 'interactionCreate') interactionBound = true;
      return this;
    },
  };
  // The primary hosts /room via its own interactionCreate binding (adapter.ts).
  primary.on('interactionCreate');

  const manager = new RoomGatewayManager({
    loadRoomBots: () => [{ slot: '2', token: 't', clientId: 'c', name: 'Ben' }],
    createClient: () => benClient as unknown as import('discord.js').Client,
    roomBotsDb: db,
    logger: noopLogger,
  });

  const { submits } = makeHandler(db, 'bot-ben');
  const listener: RoomMessageListener = () => {
    submits.push({ from: 'x', text: 'x' });
  };

  await manager.start(primary as unknown as import('discord.js').Client);
  manager.bindRoomListeners(listener);

  // Ben's client carries the room listener; slot 0's client was never touched
  // by bindRoomListeners (its only binding is the command host, still intact).
  benClient.emit('messageCreate', makeMessage({ id: '1', authorId: 'user-1', mentions: [] }));
  assert.equal(submits.length, 1, 'pool client routes chat');
  assert.equal(interactionBound, true, '/room command host stays bound on slot 0');

  await manager.stop();
});
