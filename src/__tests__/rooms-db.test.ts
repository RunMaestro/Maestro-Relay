import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  roomsDb,
  SlotConflictError,
  DEFAULT_ROOM_BUDGET_USD,
  DEFAULT_MAX_LIFETIME_TURNS,
} from '../core/room/roomsDb';
import { db } from '../core/db';

// The roomsDb module drives the shared registry singleton (like db.test.ts and
// telegramTopicsDb.test.ts), so we scope every row with a unique suffix and
// clean up afterward. agent_bot_bindings is global (keyed on agent_id only), so
// unique agent ids per run are essential to avoid cross-run contamination.
let seq = 0;
function uid(prefix: string): string {
  seq++;
  return `${prefix}-${seq}-${Date.now()}`;
}

const createdRooms: string[] = [];
const createdAgents: string[] = [];

function room(): { roomKey: string; channelId: string } {
  const channelId = uid('ch');
  const roomKey = `discord:${channelId}`;
  createdRooms.push(roomKey);
  roomsDb.createRoom({ roomKey, provider: 'discord', channelId });
  return { roomKey, channelId };
}

function agent(): string {
  const id = uid('agent');
  createdAgents.push(id);
  return id;
}

afterEach(() => {
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

// --- room + participant round-trip ------------------------------------------

test('createRoom / getRoom / isRoom round-trip with real-bots defaults', () => {
  const { roomKey, channelId } = room();

  const rec = roomsDb.getRoom(roomKey);
  assert.ok(rec);
  assert.equal(rec.provider, 'discord');
  assert.equal(rec.channel_id, channelId);
  assert.equal(rec.status, 'active');
  assert.equal(rec.spent_usd, 0);
  assert.equal(rec.max_turns, 30);
  assert.equal(rec.turn_count, 0);
  // A newly-created room carries the default budget cap and lifetime backstop.
  assert.equal(rec.budget_usd, DEFAULT_ROOM_BUDGET_USD);
  assert.equal(rec.max_lifetime_turns, DEFAULT_MAX_LIFETIME_TURNS);
  assert.equal(rec.lifetime_turn_count, 0);

  assert.equal(roomsDb.isRoom('discord', channelId), true);
  assert.equal(roomsDb.isRoom('discord', 'not-a-room'), false);
});

test('addParticipant / getParticipants records handle, session and bot_slot', () => {
  const { roomKey } = room();
  const a = agent();
  roomsDb.addParticipant({ roomKey, agentId: a, handle: 'Ada', botSlot: 'Ada', sessionId: null });

  const parts = roomsDb.getParticipants(roomKey);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].agent_id, a);
  assert.equal(parts[0].handle, 'Ada');
  assert.equal(parts[0].bot_slot, 'Ada');
  assert.equal(parts[0].session_id, null);

  roomsDb.updateParticipantSession(roomKey, a, 'sess-1');
  assert.equal(roomsDb.getParticipants(roomKey)[0].session_id, 'sess-1');
});

// --- turn counter + spend ledger --------------------------------------------

test('incrementTurn / resetTurnCount and addSpend mutate the room ledger', () => {
  const { roomKey } = room();
  assert.equal(roomsDb.incrementTurn(roomKey), 1);
  assert.equal(roomsDb.incrementTurn(roomKey), 2);
  roomsDb.resetTurnCount(roomKey);
  assert.equal(roomsDb.getRoom(roomKey)!.turn_count, 0);

  // Lifetime counter is independent: resetTurnCount leaves it untouched; only
  // resetLifetimeTurnCount clears it.
  assert.equal(roomsDb.incrementLifetimeTurn(roomKey), 1);
  assert.equal(roomsDb.incrementLifetimeTurn(roomKey), 2);
  roomsDb.resetTurnCount(roomKey);
  assert.equal(roomsDb.getRoom(roomKey)!.lifetime_turn_count, 2, 'burst reset spares lifetime');
  roomsDb.resetLifetimeTurnCount(roomKey);
  assert.equal(roomsDb.getRoom(roomKey)!.lifetime_turn_count, 0);

  roomsDb.addSpend(roomKey, 0.25);
  roomsDb.addSpend(roomKey, 0.75);
  assert.equal(roomsDb.getRoom(roomKey)!.spent_usd, 1);

  roomsDb.setStatus(roomKey, 'halted');
  assert.equal(roomsDb.getRoom(roomKey)!.status, 'halted');
});

// --- allocateFreeSlot -------------------------------------------------------

test('allocateFreeSlot returns the first unused configured slot deterministically', () => {
  const { roomKey } = room();
  const configured = ['Ada', 'Bo', 'Cy'];

  assert.equal(roomsDb.allocateFreeSlot(roomKey, configured), 'Ada');
  roomsDb.addParticipant({ roomKey, agentId: agent(), handle: 'Ada', botSlot: 'Ada' });
  assert.equal(roomsDb.allocateFreeSlot(roomKey, configured), 'Bo');
  roomsDb.addParticipant({ roomKey, agentId: agent(), handle: 'Bo', botSlot: 'Bo' });
  assert.equal(roomsDb.allocateFreeSlot(roomKey, configured), 'Cy');
  roomsDb.addParticipant({ roomKey, agentId: agent(), handle: 'Cy', botSlot: 'Cy' });
  assert.equal(roomsDb.allocateFreeSlot(roomKey, configured), null, 'all slots taken');
});

// --- bot_slot uniqueness within a room --------------------------------------

test('inviting a second agent to an already-used slot is rejected', () => {
  const { roomKey } = room();
  roomsDb.addParticipant({ roomKey, agentId: agent(), handle: 'Ada', botSlot: 'Ada' });

  assert.throws(
    () => roomsDb.addParticipant({ roomKey, agentId: agent(), handle: 'Ada2', botSlot: 'Ada' }),
    (err: unknown) => {
      assert.ok(err instanceof SlotConflictError, 'expected SlotConflictError');
      assert.match((err as Error).message, /already used/i);
      return true;
    },
  );

  // The rejected participant left no row behind.
  assert.equal(roomsDb.getParticipants(roomKey).length, 1);
});

test('a NULL bot_slot participant never collides', () => {
  const { roomKey } = room();
  roomsDb.addParticipant({ roomKey, agentId: agent(), handle: 'Ghost1', botSlot: null });
  roomsDb.addParticipant({ roomKey, agentId: agent(), handle: 'Ghost2', botSlot: null });
  assert.equal(roomsDb.getParticipants(roomKey).length, 2);
});

// --- global agent→bot binding -----------------------------------------------

test('same agent invited into two rooms binds the same slot both times', () => {
  const a = agent();
  const roomA = room();
  const roomB = room();

  // First invite allocates + writes the global binding.
  assert.equal(roomsDb.getAgentBinding(a), null, 'unbound before first invite');
  roomsDb.addParticipant({ roomKey: roomA.roomKey, agentId: a, handle: 'Ada', botSlot: 'Ada' });
  assert.equal(roomsDb.getAgentBinding(a), 'Ada', 'binding written on first invite');

  // Second invite into a different room reuses the same slot.
  roomsDb.addParticipant({ roomKey: roomB.roomKey, agentId: a, handle: 'Ada', botSlot: 'Ada' });
  assert.equal(roomsDb.getAgentBinding(a), 'Ada', 'binding reused, not duplicated');

  const inA = roomsDb.getParticipants(roomA.roomKey).find((p) => p.agent_id === a);
  const inB = roomsDb.getParticipants(roomB.roomKey).find((p) => p.agent_id === a);
  assert.equal(inA?.bot_slot, 'Ada');
  assert.equal(inB?.bot_slot, 'Ada', 'per-room bot_slot matches the global binding');
});

test('binding a globally-bound agent to a different slot is rejected', () => {
  const a = agent();
  const roomA = room();
  const roomB = room();

  roomsDb.addParticipant({ roomKey: roomA.roomKey, agentId: a, handle: 'Ada', botSlot: 'Ada' });
  assert.equal(roomsDb.getAgentBinding(a), 'Ada');

  assert.throws(
    () =>
      roomsDb.addParticipant({ roomKey: roomB.roomKey, agentId: a, handle: 'Bo', botSlot: 'Bo' }),
    (err: unknown) => {
      assert.ok(err instanceof SlotConflictError, 'expected SlotConflictError');
      assert.match((err as Error).message, /globally bound|rebind/i);
      return true;
    },
  );

  // The global binding is unchanged and no stray participant was written.
  assert.equal(roomsDb.getAgentBinding(a), 'Ada', 'binding untouched by the rejected invite');
  assert.equal(roomsDb.getParticipants(roomB.roomKey).length, 0);
});

test('setAgentBinding upserts and getAgentBinding reflects a deliberate rebind', () => {
  const a = agent();
  assert.equal(roomsDb.getAgentBinding(a), null);
  roomsDb.setAgentBinding(a, 'Ada');
  assert.equal(roomsDb.getAgentBinding(a), 'Ada');
  roomsDb.setAgentBinding(a, 'Cy'); // deliberate rebind
  assert.equal(roomsDb.getAgentBinding(a), 'Cy');
});
