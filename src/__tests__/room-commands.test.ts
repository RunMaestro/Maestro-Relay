import test, { before, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `/room` command unit tests (Phase 6). We drive the real slash-command
 * handlers in `commands/room.ts` against a stubbed Discord interaction and the
 * REAL kernel `roomsDb` (backed by the shared registry singleton, like
 * rooms-db.test.ts) so the invite/rebind/kick/reset/status wiring is exercised
 * end-to-end.
 *
 * The bot pool is supplied through the environment (`DISCORD_ROOM_BOTS`), which
 * `loadRoomBots()` reads lazily on every call — no need to mock the bare loader
 * function. Tokens in the pool are deliberately Discord-token-shaped so the
 * `status` test can assert none of them (nor any "tokens" field) ever reach the
 * rendered output.
 */

// Discord-token-shaped secrets — the `status` test asserts none of these leak.
const POOL = [
  { slot: 'Ada', clientId: '1000000000000000001', name: 'Ada', token: 'MTk4Ni.Ada.SECRET-aaaaaaaaaaaaaaaaaaaaaaa' },
  { slot: 'Bo', clientId: '1000000000000000002', name: 'Bo', token: 'MTk4Ni.Bo.SECRET-bbbbbbbbbbbbbbbbbbbbbbbb' },
  { slot: 'Cy', clientId: '1000000000000000003', name: 'Cy', token: 'MTk4Ni.Cy.SECRET-cccccccccccccccccccccccc' },
];

before(() => {
  // loadRoomBots() prefers the indexed vars when DISCORD_ROOM_BOT_COUNT is set;
  // make sure only the JSON-blob path is active for a deterministic pool.
  delete process.env.DISCORD_ROOM_BOT_COUNT;
  process.env.DISCORD_ROOM_BOTS = JSON.stringify(POOL);
});

// Imported after the env note above; the module itself calls loadRoomBots()
// lazily inside the handlers, so import order does not matter.
import {
  execute,
} from '../providers/discord/commands/room';
import { roomsDb } from '../core/room/roomsDb';
import { db } from '../core/db';

// --- unique-id + cleanup bookkeeping (mirrors rooms-db.test.ts) --------------

let seq = 0;
function uid(prefix: string): string {
  seq++;
  return `${prefix}-${seq}-${Date.now()}`;
}

const createdRooms: string[] = [];
const createdAgents: string[] = [];

function newRoom(): { roomKey: string; channelId: string } {
  const channelId = uid('ch');
  const roomKey = `discord:${channelId}`;
  createdRooms.push(roomKey);
  roomsDb.createRoom({ roomKey, provider: 'discord', channelId });
  return { roomKey, channelId };
}

/** Register an agent id with the mocked maestro CLI and track it for cleanup. */
function newAgentId(prefix = 'agent'): string {
  const id = uid(prefix);
  createdAgents.push(id);
  return id;
}

interface StubAgent {
  id: string;
  name: string;
}

/** Point maestro.listAgents at a fixed roster so resolveAgent() finds them. */
function mockAgents(agents: StubAgent[]): void {
  const { maestro } = require('../core/maestro') as typeof import('../core/maestro');
  mock.method(maestro, 'listAgents', async () =>
    agents.map((a) => ({ id: a.id, name: a.name, toolType: 'claude', cwd: '/' })),
  );
}

interface InteractionOpts {
  channelId: string;
  sub: string;
  agent?: string | null;
  slot?: string | null;
  usd?: number;
}

function makeInteraction(opts: InteractionOpts) {
  return {
    guild: { id: 'guild-1' },
    channelId: opts.channelId,
    options: {
      getSubcommand: () => opts.sub,
      getString: (name: string, _req?: boolean) => {
        if (name === 'agent') return opts.agent ?? null;
        if (name === 'slot') return opts.slot ?? null;
        return null;
      },
      getNumber: (_name: string, _req?: boolean) => opts.usd,
    },
    deferReply: mock.fn(async () => {}),
    editReply: mock.fn(async () => {}),
    reply: mock.fn(async () => {}),
  } as any;
}

/** Last `editReply` payload (invite/rebind/kick defer first). */
function editReplyText(interaction: any): string {
  const call = interaction.editReply.mock.calls[0];
  assert.ok(call, 'expected editReply to have been called');
  return call.arguments[0] as string;
}

afterEach(() => {
  mock.restoreAll();
  for (const roomKey of createdRooms) {
    try {
      db.prepare('DELETE FROM room_participants WHERE room_key = ?').run(roomKey);
      db.prepare('DELETE FROM rooms WHERE room_key = ?').run(roomKey);
    } catch {
      /* ignore */
    }
  }
  for (const agentId of createdAgents) {
    try {
      db.prepare('DELETE FROM agent_bot_bindings WHERE agent_id = ?').run(agentId);
    } catch {
      /* ignore */
    }
  }
  createdRooms.length = 0;
  createdAgents.length = 0;
});

// --- invite: global-binding reuse + conflicting-slot rejection --------------

test('invite allocates a slot, writes the global binding, and reuses it across rooms', async () => {
  const agentId = newAgentId();
  mockAgents([{ id: agentId, name: 'Ada-agent' }]);

  const roomA = newRoom();
  const roomB = newRoom();

  // First invite (no explicit slot) → allocate next free slot + write binding.
  const inviteA = makeInteraction({ channelId: roomA.channelId, sub: 'invite', agent: agentId });
  await execute(inviteA);

  assert.equal(roomsDb.getAgentBinding(agentId), 'Ada', 'binding written on first invite');
  assert.equal(
    roomsDb.getParticipant(roomA.roomKey, agentId)?.bot_slot,
    'Ada',
    'participant bound to the allocated slot',
  );
  const replyA = editReplyText(inviteA);
  assert.match(replyA, /Ada/);
  assert.match(replyA, /slot/i);

  // Second invite into a DIFFERENT room reuses the same global slot.
  const inviteB = makeInteraction({ channelId: roomB.channelId, sub: 'invite', agent: agentId });
  await execute(inviteB);

  assert.equal(roomsDb.getAgentBinding(agentId), 'Ada', 'binding reused, not re-allocated');
  assert.equal(
    roomsDb.getParticipant(roomB.roomKey, agentId)?.bot_slot,
    'Ada',
    'second room reuses the standing slot',
  );
});

test('invite rejects an explicit slot that contradicts the standing binding', async () => {
  const agentId = newAgentId();
  mockAgents([{ id: agentId, name: 'Ada-agent' }]);

  const roomA = newRoom();
  const roomC = newRoom();

  // Establish the binding to slot "Ada".
  await execute(makeInteraction({ channelId: roomA.channelId, sub: 'invite', agent: agentId }));
  assert.equal(roomsDb.getAgentBinding(agentId), 'Ada');

  // Now try to invite into another room on a conflicting explicit slot.
  const conflict = makeInteraction({
    channelId: roomC.channelId,
    sub: 'invite',
    agent: agentId,
    slot: 'Bo',
  });
  await execute(conflict);

  const reply = editReplyText(conflict);
  assert.match(reply, /rebind/i, 'points the user at /room rebind');
  assert.match(reply, /Ada/, 'names the standing slot');
  // The rejected invite left no participant row in the second room.
  assert.equal(roomsDb.getParticipant(roomC.roomKey, agentId), undefined);
  assert.equal(roomsDb.getAgentBinding(agentId), 'Ada', 'binding untouched');
});

test('invite surfaces the onboarding error when every configured slot is taken', async () => {
  // Three configured slots (Ada/Bo/Cy) → the fourth first-bind has nowhere to go.
  const ids = [newAgentId(), newAgentId(), newAgentId(), newAgentId()];
  mockAgents(ids.map((id, i) => ({ id, name: `agent-${i}` })));

  const r = newRoom();
  for (let i = 0; i < 3; i++) {
    await execute(makeInteraction({ channelId: r.channelId, sub: 'invite', agent: ids[i] }));
  }

  const full = makeInteraction({ channelId: r.channelId, sub: 'invite', agent: ids[3] });
  await execute(full);
  assert.match(editReplyText(full), /No free room-bot slot/);
});

// --- rebind: changes the global binding everywhere --------------------------

test('rebind changes the agent global binding and the per-room slot', async () => {
  const agentId = newAgentId();
  mockAgents([{ id: agentId, name: 'Ada-agent' }]);

  const r = newRoom();
  await execute(makeInteraction({ channelId: r.channelId, sub: 'invite', agent: agentId }));
  assert.equal(roomsDb.getAgentBinding(agentId), 'Ada');

  const rebind = makeInteraction({
    channelId: r.channelId,
    sub: 'rebind',
    agent: agentId,
    slot: 'Bo',
  });
  await execute(rebind);

  assert.equal(roomsDb.getAgentBinding(agentId), 'Bo', 'global binding rewritten');
  const participant = roomsDb.getParticipant(r.roomKey, agentId);
  assert.equal(participant?.bot_slot, 'Bo', 'per-room slot rewritten in lock-step');
  // Handle + avatar follow the new persona too, not just the slot (P2 #59).
  assert.equal(participant?.handle, 'Bo', 'handle updated to the new persona name');
  const reply = editReplyText(rebind);
  assert.match(reply, /Bo/);
  assert.match(reply, /every/i, 'warns the change applies everywhere');
});

// --- kick: frees the slot for reuse -----------------------------------------

test('kick removes the participant and frees its slot for reuse', async () => {
  const first = newAgentId();
  const second = newAgentId();
  mockAgents([
    { id: first, name: 'First' },
    { id: second, name: 'Second' },
  ]);

  const r = newRoom();
  await execute(makeInteraction({ channelId: r.channelId, sub: 'invite', agent: first }));
  assert.equal(roomsDb.getParticipant(r.roomKey, first)?.bot_slot, 'Ada');

  const kick = makeInteraction({ channelId: r.channelId, sub: 'kick', agent: first });
  await execute(kick);

  assert.equal(roomsDb.getParticipant(r.roomKey, first), undefined, 'participant removed');
  assert.match(editReplyText(kick), /free/i);

  // Kick keeps the kicked agent's GLOBAL binding (Ada stays `first`'s persona
  // everywhere), so a different agent must NOT reclaim Ada — it gets the next
  // truly-free slot instead. This is the global 1:1 persona rule (P2 #59).
  const reinvite = makeInteraction({ channelId: r.channelId, sub: 'invite', agent: second });
  await execute(reinvite);
  assert.equal(
    roomsDb.getParticipant(r.roomKey, second)?.bot_slot,
    'Bo',
    'a different agent gets the next free slot, not the kicked agent’s reserved slot',
  );
  assert.equal(roomsDb.getAgentBinding(first), 'Ada', 'kicked agent keeps its global persona');
});

// --- status: renders participants without ever leaking a token --------------

test('status lists participants and never prints a token-shaped string', async () => {
  const a = newAgentId();
  const b = newAgentId();
  mockAgents([
    { id: a, name: 'Ada-agent' },
    { id: b, name: 'Bo-agent' },
  ]);

  const r = newRoom();
  await execute(makeInteraction({ channelId: r.channelId, sub: 'invite', agent: a }));
  await execute(makeInteraction({ channelId: r.channelId, sub: 'invite', agent: b }));

  const status = makeInteraction({ channelId: r.channelId, sub: 'status' });
  await execute(status);

  const payload = status.reply.mock.calls[0].arguments[0];
  assert.ok(payload.embeds && payload.embeds.length === 1, 'status replies with one embed');
  const data = payload.embeds[0].data;

  // Full serialized embed — title + fields + description — must not contain any
  // configured bot token, nor any "tokens" field/label.
  const serialized = JSON.stringify(data);
  for (const bot of POOL) {
    assert.ok(
      !serialized.includes(bot.token),
      `status embed leaked the ${bot.slot} bot token`,
    );
  }
  assert.ok(!/token/i.test(serialized), 'status embed mentions no token whatsoever');

  // It DOES surface handles + personas so the human can tell who's who.
  assert.match(data.description, /Ada/);
  assert.match(data.description, /Bo/);

  // Fields are limited to Status / Spend / Turns — no token count field.
  const fieldNames = data.fields.map((f: { name: string }) => f.name);
  assert.deepEqual(fieldNames, ['Status', 'Spend', 'Turns']);
});

// --- reset: clears sessions AND zeroes the burst turn counter ----------------

test('reset zeroes the turn counter and clears participant sessions', async () => {
  const agentId = newAgentId();
  mockAgents([{ id: agentId, name: 'Ada-agent' }]);

  const r = newRoom();
  await execute(makeInteraction({ channelId: r.channelId, sub: 'invite', agent: agentId }));
  roomsDb.updateParticipantSession(r.roomKey, agentId, 'sess-xyz');
  roomsDb.incrementTurn(r.roomKey);
  roomsDb.incrementTurn(r.roomKey);
  assert.equal(roomsDb.getRoom(r.roomKey)!.turn_count, 2);

  const reset = makeInteraction({ channelId: r.channelId, sub: 'reset' });
  await execute(reset);

  assert.equal(roomsDb.getRoom(r.roomKey)!.turn_count, 0, 'turn counter zeroed');
  assert.equal(
    roomsDb.getParticipant(r.roomKey, agentId)?.session_id,
    null,
    'session cleared',
  );
  assert.match(reset.reply.mock.calls[0].arguments[0].content, /reset/i);
});

test('reset reactivates a halted room (P2 #59)', async () => {
  const r = newRoom();
  // Simulate a room halted by a turn/budget brake.
  roomsDb.setStatus(r.roomKey, 'halted');
  assert.equal(roomsDb.getRoom(r.roomKey)!.status, 'halted');

  const reset = makeInteraction({ channelId: r.channelId, sub: 'reset' });
  await execute(reset);

  assert.equal(roomsDb.getRoom(r.roomKey)!.status, 'active', 'reset returns the room to active');
  assert.match(reset.reply.mock.calls[0].arguments[0].content, /reactivat/i);
});

// --- pause / resume / stop set the room status ------------------------------

test('pause, resume and stop set the expected room status', async () => {
  const r = newRoom();

  await execute(makeInteraction({ channelId: r.channelId, sub: 'pause' }));
  assert.equal(roomsDb.getRoom(r.roomKey)!.status, 'paused');

  await execute(makeInteraction({ channelId: r.channelId, sub: 'resume' }));
  assert.equal(roomsDb.getRoom(r.roomKey)!.status, 'active');

  await execute(makeInteraction({ channelId: r.channelId, sub: 'stop' }));
  assert.equal(roomsDb.getRoom(r.roomKey)!.status, 'halted');
});
