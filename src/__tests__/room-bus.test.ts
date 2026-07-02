import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomBus, type RoomBusDbSeam, type RoomBusMaestro } from '../core/room/bus';
import type { RoomRecord, RoomParticipant, RoomStatus } from '../core/room/roomsDb';
import type {
  BridgeProvider,
  ChannelTarget,
  KernelLogger,
  OutgoingMessage,
  PersonaIdentity,
} from '../core/types';

// --- fixtures ---------------------------------------------------------------

function makeRoom(overrides: Partial<RoomRecord> = {}): RoomRecord {
  return {
    room_key: 'room1',
    provider: 'discord',
    channel_id: 'chan1',
    thread_id: null,
    status: 'active',
    budget_usd: null,
    spent_usd: 0,
    max_mentions: 2,
    max_turns: 30,
    turn_count: 0,
    created_at: 0,
    ...overrides,
  };
}

function makeParticipant(overrides: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    room_key: 'room1',
    agent_id: 'a',
    handle: 'A',
    avatar_url: null,
    session_id: null,
    bot_slot: null,
    created_at: 0,
    ...overrides,
  };
}

/**
 * In-memory `RoomBusDbSeam` backed by a single mutable room record and a
 * participant list. `getRoom` returns the live object so `addSpend`,
 * `incrementTurn`, `setStatus`, and `resetTurnCount` are observable to later
 * `processNext` reads — exactly as the real SQLite-backed seam behaves.
 */
function makeDb(
  room: RoomRecord,
  participants: RoomParticipant[],
  botUserIds: Record<string, string> = {},
): RoomBusDbSeam {
  return {
    getRoom: (k) => (k === room.room_key ? room : undefined),
    getRoomByChannel: (p, c) =>
      p === room.provider && c === room.channel_id ? room : undefined,
    isRoom: (p, c) => p === room.provider && c === room.channel_id,
    getParticipants: (k) => (k === room.room_key ? participants : []),
    incrementTurn: (_k) => {
      room.turn_count += 1;
      return room.turn_count;
    },
    resetTurnCount: (_k) => {
      room.turn_count = 0;
    },
    addSpend: (_k, usd) => {
      room.spent_usd += usd;
    },
    setStatus: (_k, status: RoomStatus) => {
      room.status = status;
    },
    updateParticipantSession: (_k, agentId, sessionId) => {
      const p = participants.find((x) => x.agent_id === agentId);
      if (p) p.session_id = sessionId;
    },
    getRoomBotUserId: (slot) => botUserIds[slot] ?? null,
  };
}

interface SendCall {
  agentId: string;
  message: string;
  sessionId?: string;
}

type MaestroReply = Awaited<ReturnType<RoomBusMaestro['send']>>;

/** Records every `maestro.send` and replays a scripted response per call. */
function makeMaestro(replies: MaestroReply[]): { maestro: RoomBusMaestro; calls: SendCall[] } {
  const calls: SendCall[] = [];
  let i = 0;
  return {
    calls,
    maestro: {
      send: async (agentId, message, opts) => {
        calls.push({ agentId, message, sessionId: opts?.sessionId });
        const reply = replies[Math.min(i, replies.length - 1)];
        i += 1;
        return reply;
      },
    },
  };
}

interface Post {
  target: ChannelTarget;
  identity: PersonaIdentity;
  text?: string;
}
interface Notice {
  target: ChannelTarget;
  text?: string;
}

/**
 * Stub provider standing in for the Discord adapter's real bot pool: `sendAs`
 * records per-persona posts (what a room reply becomes), `send` records the
 * slot-0 system notices (budget/turn halts).
 */
function makeProvider(): { provider: BridgeProvider; posts: Post[]; notices: Notice[] } {
  const posts: Post[] = [];
  const notices: Notice[] = [];
  const provider = {
    name: 'discord',
    sendAs: async (target: ChannelTarget, identity: PersonaIdentity, msg: OutgoingMessage) => {
      posts.push({ target, identity, text: msg.text });
    },
    send: async (target: ChannelTarget, msg: OutgoingMessage) => {
      notices.push({ target, text: msg.text });
    },
  } as unknown as BridgeProvider;
  return { provider, posts, notices };
}

const silentLogger: KernelLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

function reply(response: string | null, totalCostUsd = 0, sessionId?: string): MaestroReply {
  return { success: response !== null, response, sessionId, usage: { totalCostUsd } };
}

/** Let the fire-and-forget `processNext` chain fully unwind. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

// --- routing + no internal enqueue -----------------------------------------

test('routes one send to the addressee and rewrites its reply to native <@id>, no internal next hop', async () => {
  const room = makeRoom();
  const b = makeParticipant({ agent_id: 'b', handle: 'B', bot_slot: 'slot-b', session_id: 'sess-b' });
  const c = makeParticipant({ agent_id: 'c', handle: 'C', bot_slot: 'slot-c' });
  const db = makeDb(room, [b, c], { 'slot-b': '222', 'slot-c': '333' });
  const { maestro, calls } = makeMaestro([reply('Hey @C what do you think?', 0.01)]);
  const { provider, posts } = makeProvider();

  const bus = createRoomBus({
    db,
    maestro,
    getProvider: () => provider,
    logger: silentLogger,
  });

  bus.submitMessage('discord', 'chan1', 'human', 'ask B', { toAgentId: 'b', fromKind: 'human' });
  await settle();

  // Exactly ONE maestro.send — to B, on B's session. The C hop is NOT enqueued
  // internally; only a peer bot's gateway (an external event) would re-enter.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, 'b');
  assert.equal(calls[0].sessionId, 'sess-b');

  // The reply is posted as B, carrying a REAL native mention for C.
  assert.equal(posts.length, 1);
  assert.equal(posts[0].identity.name, 'B');
  assert.equal(posts[0].identity.botUserId, '222');
  assert.ok(posts[0].text?.includes('<@333>'), 'reply should contain C native mention');
  assert.ok(!posts[0].text?.includes('@C'), 'literal @C should be rewritten away');
});

// --- budget cap -------------------------------------------------------------

test('budget cap: cumulative spend reaching budget halts the room with no further send', async () => {
  const room = makeRoom({ budget_usd: 0.1 });
  const b = makeParticipant({ agent_id: 'b', handle: 'B', bot_slot: 'slot-b' });
  const db = makeDb(room, [b], { 'slot-b': '222' });
  // Each send costs exactly the whole budget, so the second pre-check trips.
  const { maestro, calls } = makeMaestro([reply('ok done', 0.1)]);
  const { provider, posts, notices } = makeProvider();

  const bus = createRoomBus({ db, maestro, getProvider: () => provider, logger: silentLogger });

  bus.submitMessage('discord', 'chan1', 'human', 'first', { toAgentId: 'b', fromKind: 'human' });
  await settle();
  assert.equal(calls.length, 1, 'first message sends (budget not yet spent)');
  assert.equal(room.spent_usd, 0.1);

  bus.submitMessage('discord', 'chan1', 'human', 'second', { toAgentId: 'b', fromKind: 'human' });
  await settle();

  assert.equal(calls.length, 1, 'second message must NOT send once budget is reached');
  assert.equal(room.status, 'halted');
  assert.equal(posts.length, 1, 'no further persona post after halt');
  assert.equal(notices.length, 1, 'one system halt notice');
  assert.ok(notices[0].text?.includes('budget'), 'notice mentions the budget');
});

// --- turn cap is burst-scoped ----------------------------------------------

test('turn cap trips within one burst but is reset by a human message and by queue drain', async () => {
  // (a) A human message re-arms the burst counter in submit (before any send).
  {
    const room = makeRoom({ turn_count: 5, max_turns: 30 });
    const b = makeParticipant({ agent_id: 'b', handle: 'B', bot_slot: 'slot-b' });
    const db = makeDb(room, [b], { 'slot-b': '222' });
    let resetsBeforeSend = 0;
    const baseReset = db.resetTurnCount;
    db.resetTurnCount = (k) => {
      resetsBeforeSend += 1;
      baseReset(k);
    };
    // A pending send blocks processNext at its await, so we observe only the
    // work that runs synchronously in submit (the human re-arm) + the burst
    // increment — proving the counter was reset (5 would otherwise become 6).
    const maestro: RoomBusMaestro = { send: () => new Promise(() => {}) };
    const { provider } = makeProvider();
    const bus = createRoomBus({ db, maestro, getProvider: () => provider, logger: silentLogger });

    bus.submitMessage('discord', 'chan1', 'human', 'hi', { toAgentId: 'b', fromKind: 'human' });
    assert.equal(resetsBeforeSend, 1, 'human message re-arms the burst budget in submit');
    assert.equal(room.turn_count, 1, 'reset to 0 then incremented once (not 5 → 6)');
  }

  // (b) A drained queue resets the counter — a long-lived room is never killed
  //     for lifetime turns.
  {
    const room = makeRoom({ max_turns: 30 });
    const b = makeParticipant({ agent_id: 'b', handle: 'B', bot_slot: 'slot-b' });
    const db = makeDb(room, [b], { 'slot-b': '222' });
    const { maestro } = makeMaestro([reply('spoken to the room, no mention', 0)]);
    const { provider } = makeProvider();
    const bus = createRoomBus({ db, maestro, getProvider: () => provider, logger: silentLogger });

    bus.submitMessage('discord', 'chan1', 'human', 'hi', { toAgentId: 'b', fromKind: 'human' });
    await settle();
    assert.equal(room.turn_count, 0, 'turn counter resets to 0 once the burst drains');
    assert.equal(room.status, 'active', 'a healthy drained room stays active');
  }

  // (c) Reaching max_turns inside a single burst halts.
  {
    const room = makeRoom({ max_turns: 2 });
    const b = makeParticipant({ agent_id: 'b', handle: 'B', bot_slot: 'slot-b' });
    const db = makeDb(room, [b], { 'slot-b': '222' });
    const { maestro, calls } = makeMaestro([
      reply('one', 0),
      reply('two', 0),
      reply('three', 0),
    ]);
    const { provider, notices } = makeProvider();
    const bus = createRoomBus({ db, maestro, getProvider: () => provider, logger: silentLogger });

    // Enqueue three hops synchronously so they share one burst (no drain between).
    bus.submitMessage('discord', 'chan1', 'B', 'm1', { toAgentId: 'b', fromKind: 'bot' });
    bus.submitMessage('discord', 'chan1', 'B', 'm2', { toAgentId: 'b', fromKind: 'bot' });
    bus.submitMessage('discord', 'chan1', 'B', 'm3', { toAgentId: 'b', fromKind: 'bot' });
    await settle();

    assert.equal(calls.length, 2, 'third hop halts BEFORE its send (turn 3 > max 2)');
    assert.equal(room.status, 'halted');
    assert.equal(notices.length, 1, 'one turn-limit notice');
    assert.ok(notices[0].text?.includes('turn limit'), 'notice mentions the turn limit');
  }
});

// --- maxMentions cap + self-drop + native rewrite --------------------------

test('maxMentions caps posted native mentions at 2, drops self, emits real <@id>', async () => {
  const room = makeRoom({ max_mentions: 2 });
  const a = makeParticipant({ agent_id: 'a', handle: 'A', bot_slot: 'slot-a' });
  const b = makeParticipant({ agent_id: 'b', handle: 'B', bot_slot: 'slot-b' });
  const c = makeParticipant({ agent_id: 'c', handle: 'C', bot_slot: 'slot-c' });
  const d = makeParticipant({ agent_id: 'd', handle: 'D', bot_slot: 'slot-d' });
  const db = makeDb(room, [a, b, c, d], {
    'slot-a': '111',
    'slot-b': '222',
    'slot-c': '333',
    'slot-d': '444',
  });
  const { maestro } = makeMaestro([reply('@A note: @B and @C and @D please go', 0)]);
  const { provider, posts } = makeProvider();

  const bus = createRoomBus({ db, maestro, getProvider: () => provider, logger: silentLogger });
  bus.submitMessage('discord', 'chan1', 'human', 'go', { toAgentId: 'a', fromKind: 'human' });
  await settle();

  assert.equal(posts.length, 1);
  const text = posts[0].text ?? '';
  assert.ok(text.includes('<@222>'), 'B rewritten to native');
  assert.ok(text.includes('<@333>'), 'C rewritten to native');
  assert.ok(!text.includes('<@444>'), 'D is over the cap — left literal');
  assert.ok(text.includes('@D'), 'over-cap D handle stays literal');
  assert.ok(!text.includes('<@111>'), 'self A is never rewritten to a native mention');
  assert.ok(text.includes('@A'), 'self handle stays literal');
});

// --- echo guard -------------------------------------------------------------

test('echo guard suppresses posting a reply identical to the agent last reply in the room', async () => {
  const room = makeRoom();
  const b = makeParticipant({ agent_id: 'b', handle: 'B', bot_slot: 'slot-b' });
  const db = makeDb(room, [b], { 'slot-b': '222' });
  // Same response string both turns → second is an echo.
  const { maestro, calls } = makeMaestro([reply('spoken to the room', 0), reply('spoken to the room', 0)]);
  const { provider, posts } = makeProvider();

  const bus = createRoomBus({ db, maestro, getProvider: () => provider, logger: silentLogger });

  bus.submitMessage('discord', 'chan1', 'human', 'first', { toAgentId: 'b', fromKind: 'human' });
  await settle();
  assert.equal(posts.length, 1, 'first reply posts');

  bus.submitMessage('discord', 'chan1', 'human', 'again', { toAgentId: 'b', fromKind: 'human' });
  await settle();

  assert.equal(calls.length, 2, 'the send still happens (echo is detected after the send)');
  assert.equal(posts.length, 1, 'duplicate reply is NOT re-posted');
});
