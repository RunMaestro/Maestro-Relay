import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addParticipant,
  createRoom,
  createRoomBus,
  deleteRoom,
  getRoom,
  isRoomChannel,
  listRooms,
  removeParticipant,
  setRoomStatus,
  type RoomBusDeps,
  type RoomPost,
  type RoomRecord,
} from '../plugin/rooms';
import { createFakeSdk } from './plugin-helpers';

/**
 * Masked-persona rooms: a KV-backed registry (no SQLite in the sandbox) plus a
 * serial, self-terminating bus that reuses the kernel room protocol. The bus's
 * agent dispatch and channel post are injected, so these tests drive the whole
 * route -> dispatch -> masked-post -> re-route loop with pure fakes.
 */

/** A scripted dispatch: per-agent reply queues, recording each call. */
function scriptedDispatch(replies: Record<string, string[]>): {
  dispatch: RoomBusDeps['dispatch'];
  calls: Array<{ agentId: string; prompt: string; sessionId?: string }>;
} {
  const calls: Array<{ agentId: string; prompt: string; sessionId?: string }> = [];
  const queues: Record<string, string[]> = {};
  for (const [agentId, list] of Object.entries(replies)) queues[agentId] = list.slice();
  const dispatch: RoomBusDeps['dispatch'] = async (agentId, prompt, sessionId) => {
    calls.push({ agentId, prompt, sessionId });
    const queue = queues[agentId] ?? [];
    const text = queue.length > 0 ? queue.shift()! : '';
    return { text, sessionId: `${agentId}-sess` };
  };
  return { dispatch, calls };
}

/** A sendAs sink that records every masked post. */
function recordingSendAs(): {
  sendAs: RoomBusDeps['sendAs'];
  posts: Array<{ room: RoomRecord; post: RoomPost }>;
} {
  const posts: Array<{ room: RoomRecord; post: RoomPost }> = [];
  const sendAs: RoomBusDeps['sendAs'] = (room, post) => {
    posts.push({ room, post });
  };
  return { sendAs, posts };
}

const silentLogger = { warn: () => {}, error: () => {} };

// --- Registry -------------------------------------------------------------

test('createRoom is idempotent and never clears participants', async () => {
  const { sdk } = createFakeSdk();
  const first = await createRoom(sdk, 'discord', 'chan-1', { name: 'Lab' });
  await addParticipant(sdk, 'discord', 'chan-1', 'agent-a', 'Ada');
  const second = await createRoom(sdk, 'discord', 'chan-1');
  assert.equal(second.roomKey, first.roomKey);
  assert.equal(second.name, 'Lab');
  assert.equal(second.participants.length, 1, 're-create must not wipe personas');
});

test('addParticipant sanitizes handles and disambiguates collisions', async () => {
  const { sdk } = createFakeSdk();
  const p1 = await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada Lovelace!');
  const p2 = await addParticipant(sdk, 'discord', 'c', 'agent-b', 'Ada Lovelace');
  assert.equal(p1.handle, 'AdaLovelace', 'strips non-handle chars');
  assert.notEqual(p2.handle.toLowerCase(), p1.handle.toLowerCase(), 'collision gets a suffix');
  assert.ok(p2.handle.startsWith('AdaLovelace-'));
  // Re-adding the same agent id is idempotent.
  const again = await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Different Name');
  assert.equal(again.handle, 'AdaLovelace');
  const room = await getRoom(sdk, 'discord', 'c');
  assert.equal(room?.participants.length, 2);
});

test('removeParticipant works by handle or agent id; deleteRoom clears it', async () => {
  const { sdk } = createFakeSdk();
  await addParticipant(sdk, 'slack', 'C1', 'agent-a', 'Ada');
  await addParticipant(sdk, 'slack', 'C1', 'agent-b', 'Bob');
  assert.equal(await removeParticipant(sdk, 'slack', 'C1', 'ada'), true, 'by handle, case-insensitive');
  assert.equal(await removeParticipant(sdk, 'slack', 'C1', 'agent-b'), true, 'by agent id');
  assert.equal(await removeParticipant(sdk, 'slack', 'C1', 'nope'), false);
  assert.equal(await isRoomChannel(sdk, 'slack', 'C1'), true);
  assert.equal(await deleteRoom(sdk, 'slack', 'C1'), true);
  assert.equal(await isRoomChannel(sdk, 'slack', 'C1'), false);
  assert.equal(await deleteRoom(sdk, 'slack', 'C1'), false);
});

test('listRooms returns every room sorted by key', async () => {
  const { sdk } = createFakeSdk();
  await createRoom(sdk, 'slack', 'C2');
  await createRoom(sdk, 'discord', 'c1');
  const keys = (await listRooms(sdk)).map((r) => r.roomKey);
  assert.deepEqual(keys, ['discord:c1', 'slack:C2']);
});

test('a corrupt rooms blob degrades to an empty registry', async () => {
  const { sdk } = createFakeSdk({ storage: { 'relay:rooms': '{not json' } });
  assert.deepEqual(await listRooms(sdk), []);
  // ...and a subsequent write still succeeds.
  await createRoom(sdk, 'discord', 'c');
  assert.equal(await isRoomChannel(sdk, 'discord', 'c'), true);
});

// --- Bus routing ----------------------------------------------------------

test('isRoom reflects the registry', async () => {
  const { sdk } = createFakeSdk();
  const { dispatch } = scriptedDispatch({});
  const { sendAs } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger });
  assert.equal(await bus.isRoom('discord', 'c'), false);
  await createRoom(sdk, 'discord', 'c');
  assert.equal(await bus.isRoom('discord', 'c'), true);
});

test('submitMessage reports no-room and no-target', async () => {
  const { sdk } = createFakeSdk();
  const { dispatch, calls } = scriptedDispatch({});
  const { sendAs, posts } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger });

  const noRoom = await bus.submitMessage('discord', 'c', 'human', '@Ada hi');
  assert.equal(noRoom.status, 'no-room');

  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  const noTarget = await bus.submitMessage('discord', 'c', 'human', 'just chatting, no mention');
  assert.equal(noTarget.status, 'no-target');
  assert.equal(calls.length, 0, 'an unaddressed message dispatches nothing');
  assert.equal(posts.length, 0);
});

test('an addressed message dispatches to that persona and masks the reply', async () => {
  const { sdk } = createFakeSdk();
  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  await addParticipant(sdk, 'discord', 'c', 'agent-b', 'Bob');
  const { dispatch, calls } = scriptedDispatch({ 'agent-a': ['Hello from Ada'] });
  const { sendAs, posts } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger });

  const result = await bus.submitMessage('discord', 'c', 'human', '@ada please help');
  assert.equal(result.status, 'drained');
  assert.equal(result.targets, 1);
  assert.equal(result.turns, 1);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, 'agent-a');
  assert.match(calls[0].prompt, /You are @Ada in room/, 'prompt carries the room preamble');
  assert.match(calls[0].prompt, /\[human\]: @ada please help/, 'and the triggering utterance');

  assert.equal(posts.length, 1);
  assert.equal(posts[0].post.handle, 'Ada');
  assert.equal(posts[0].post.text, 'Hello from Ada');
});

test('per-persona sessions continue across turns', async () => {
  const { sdk } = createFakeSdk();
  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  const { dispatch, calls } = scriptedDispatch({ 'agent-a': ['one', 'two'] });
  const { sendAs } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger });

  await bus.submitMessage('discord', 'c', 'human', '@Ada first');
  await bus.submitMessage('discord', 'c', 'human', '@Ada second');
  assert.equal(calls[0].sessionId, undefined, 'first turn starts a fresh session');
  assert.equal(calls[1].sessionId, 'agent-a-sess', 'second turn resumes it');
});

test('@all fans out to every persona', async () => {
  const { sdk } = createFakeSdk();
  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  await addParticipant(sdk, 'discord', 'c', 'agent-b', 'Bob');
  await addParticipant(sdk, 'discord', 'c', 'agent-x', 'Cy');
  const { dispatch, calls } = scriptedDispatch({});
  const { sendAs } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger });

  const result = await bus.submitMessage('discord', 'c', 'human', '@all standup please');
  assert.equal(result.targets, 3);
  assert.deepEqual(
    calls.map((c) => c.agentId).sort(),
    ['agent-a', 'agent-b', 'agent-x'],
  );
});

test('a reply addressing a peer re-routes to it (internal enqueue)', async () => {
  const { sdk } = createFakeSdk();
  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  await addParticipant(sdk, 'discord', 'c', 'agent-b', 'Bob');
  const { dispatch, calls } = scriptedDispatch({
    'agent-a': ['@Bob can you take this?'],
    'agent-b': ['Sure, done.'],
  });
  const { sendAs, posts } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger });

  const result = await bus.submitMessage('discord', 'c', 'human', '@Ada kick it off');
  assert.equal(result.turns, 2, 'Ada then Bob');
  assert.deepEqual(calls.map((c) => c.agentId), ['agent-a', 'agent-b']);
  assert.deepEqual(posts.map((p) => p.post.handle), ['Ada', 'Bob']);
  assert.match(calls[1].prompt, /\[Ada\]: @Bob can you take this\?/, 'Bob hears Ada as the author');
});

test('the burst cap stops a runaway A<->B cascade', async () => {
  const { sdk } = createFakeSdk();
  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  await addParticipant(sdk, 'discord', 'c', 'agent-b', 'Bob');
  // Each persona always re-pings the other with a *fresh* line, so the echo
  // guard never trips — only the burst cap can terminate this.
  let n = 0;
  const dispatch: RoomBusDeps['dispatch'] = async (agentId) => {
    n += 1;
    const peer = agentId === 'agent-a' ? 'Bob' : 'Ada';
    return { text: `@${peer} ping ${n}`, sessionId: `${agentId}-sess` };
  };
  const { sendAs, posts } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger, maxBurstTurns: 4 });

  const result = await bus.submitMessage('discord', 'c', 'human', '@Ada start');
  assert.equal(result.turns, 4, 'cascade halts exactly at the burst cap');
  assert.equal(posts.length, 4);
});

test('the echo guard suppresses a verbatim-repeated reply', async () => {
  const { sdk } = createFakeSdk();
  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  await addParticipant(sdk, 'discord', 'c', 'agent-b', 'Bob');
  // Ada and Bob keep saying the exact same thing that pings the other. The first
  // hop posts; the repeat is dropped and not re-routed, so the loop dies.
  const dispatch: RoomBusDeps['dispatch'] = async (agentId) => ({
    text: agentId === 'agent-a' ? '@Bob same' : '@Ada same',
    sessionId: `${agentId}-sess`,
  });
  const { sendAs, posts } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger, maxBurstTurns: 20 });

  const result = await bus.submitMessage('discord', 'c', 'human', '@Ada go');
  // Ada("@Bob same") -> Bob("@Ada same") -> Ada("@Bob same" == echo, dropped).
  assert.equal(posts.length, 2);
  assert.ok(result.turns <= 3);
});

test('the mention cap bounds how many peers one message addresses', async () => {
  const { sdk } = createFakeSdk();
  await createRoom(sdk, 'discord', 'c', { maxMentions: 2 });
  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  await addParticipant(sdk, 'discord', 'c', 'agent-b', 'Bob');
  await addParticipant(sdk, 'discord', 'c', 'agent-x', 'Cy');
  const { dispatch, calls } = scriptedDispatch({});
  const { sendAs } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger });

  const result = await bus.submitMessage('discord', 'c', 'human', '@Ada @Bob @Cy all three');
  assert.equal(result.targets, 2, 'capped at maxMentions');
  assert.equal(calls.length, 2);
});

test('a paused room holds its backlog without dispatching', async () => {
  const { sdk } = createFakeSdk();
  await addParticipant(sdk, 'discord', 'c', 'agent-a', 'Ada');
  await setRoomStatus(sdk, 'discord', 'c', 'paused');
  const { dispatch, calls } = scriptedDispatch({ 'agent-a': ['hi'] });
  const { sendAs, posts } = recordingSendAs();
  const bus = createRoomBus({ sdk, dispatch, sendAs, logger: silentLogger });

  const result = await bus.submitMessage('discord', 'c', 'human', '@Ada hello');
  assert.equal(result.turns, 0);
  assert.equal(calls.length, 0, 'paused: nothing dispatched');
  assert.equal(posts.length, 0);

  // Resuming and nudging with a new message drains the held turn too.
  await setRoomStatus(sdk, 'discord', 'c', 'active');
  const resumed = await bus.submitMessage('discord', 'c', 'human', '@Ada again');
  assert.ok(resumed.turns >= 1, 'resumed room dispatches');
  assert.ok(calls.length >= 1);
});
