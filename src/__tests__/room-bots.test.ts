import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadRoomBots,
  NO_FREE_ROOM_BOT_SLOT_ERROR,
  ROOM_BOT_ONBOARDING_DOC_REF,
} from '../providers/discord/roomBots';

/** All env keys the loader reads; cleared before each case so tests stay isolated. */
function clearRoomBotEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DISCORD_ROOM_BOT')) delete process.env[key];
  }
}

/** Run `fn` with a clean room-bot env, restoring the full env afterwards. */
function withEnv(fn: () => void): void {
  const previousEnv = { ...process.env };
  clearRoomBotEnv();
  try {
    fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      process.env[key] = value;
    }
  }
}

test('returns [] when no room-bot env is set (no throw)', () => {
  withEnv(() => {
    assert.deepEqual(loadRoomBots(), []);
  });
});

test('parses two indexed bots correctly', () => {
  withEnv(() => {
    process.env.DISCORD_ROOM_BOT_COUNT = '2';
    process.env.DISCORD_ROOM_BOT_1_TOKEN = 'token-one';
    process.env.DISCORD_ROOM_BOT_1_CLIENT_ID = '111111111111111111';
    process.env.DISCORD_ROOM_BOT_1_NAME = 'Alice';
    process.env.DISCORD_ROOM_BOT_2_TOKEN = 'token-two';
    process.env.DISCORD_ROOM_BOT_2_CLIENT_ID = '222222222222222222';
    process.env.DISCORD_ROOM_BOT_2_NAME = 'Bob';
    process.env.DISCORD_ROOM_BOT_2_AVATAR_URL = 'https://example.com/bob.png';

    const bots = loadRoomBots();
    assert.equal(bots.length, 2);
    assert.deepEqual(bots[0], {
      slot: '1',
      token: 'token-one',
      clientId: '111111111111111111',
      name: 'Alice',
    });
    assert.deepEqual(bots[1], {
      slot: '2',
      token: 'token-two',
      clientId: '222222222222222222',
      name: 'Bob',
      avatarUrl: 'https://example.com/bob.png',
    });
  });
});

test('parses the DISCORD_ROOM_BOTS JSON fallback', () => {
  withEnv(() => {
    process.env.DISCORD_ROOM_BOTS = JSON.stringify([
      { slot: 'a', token: 'tok-a', clientId: '333333333333333333', name: 'Carol' },
      {
        slot: 'b',
        token: 'tok-b',
        clientId: '444444444444444444',
        name: 'Dave',
        avatarUrl: 'https://example.com/dave.png',
      },
    ]);

    const bots = loadRoomBots();
    assert.equal(bots.length, 2);
    assert.equal(bots[0].slot, 'a');
    assert.equal(bots[0].name, 'Carol');
    assert.equal(bots[0].avatarUrl, undefined);
    assert.equal(bots[1].slot, 'b');
    assert.equal(bots[1].avatarUrl, 'https://example.com/dave.png');
  });
});

test('indexed vars take precedence over the JSON fallback when COUNT is set', () => {
  withEnv(() => {
    process.env.DISCORD_ROOM_BOT_COUNT = '1';
    process.env.DISCORD_ROOM_BOT_1_TOKEN = 'indexed-token';
    process.env.DISCORD_ROOM_BOT_1_CLIENT_ID = '555555555555555555';
    process.env.DISCORD_ROOM_BOT_1_NAME = 'Indexed';
    process.env.DISCORD_ROOM_BOTS = JSON.stringify([
      { slot: 'z', token: 'json-token', clientId: '999999999999999999', name: 'Json' },
    ]);

    const bots = loadRoomBots();
    assert.equal(bots.length, 1);
    assert.equal(bots[0].name, 'Indexed');
  });
});

test('duplicate slot in the JSON fallback throws naming the slot', () => {
  withEnv(() => {
    process.env.DISCORD_ROOM_BOTS = JSON.stringify([
      { slot: 'dup', token: 'tok-1', clientId: '111111111111111111', name: 'One' },
      { slot: 'dup', token: 'tok-2', clientId: '222222222222222222', name: 'Two' },
    ]);

    assert.throws(
      () => loadRoomBots(),
      (err: Error) => err.message.includes('"dup"') && /duplicate slot/i.test(err.message),
    );
  });
});

test('duplicate clientId (same bot account on two slots) throws naming the slot (P2 #59)', () => {
  withEnv(() => {
    process.env.DISCORD_ROOM_BOTS = JSON.stringify([
      { slot: 'one', token: 'tok-1', clientId: '111111111111111111', name: 'One' },
      { slot: 'two', token: 'tok-2', clientId: '111111111111111111', name: 'Two' },
    ]);

    assert.throws(
      () => loadRoomBots(),
      (err: Error) =>
        err.message.includes('"two"') &&
        err.message.includes('111111111111111111') &&
        /duplicate clientId/i.test(err.message),
    );
  });
});

test('a pool slot reusing the primary DISCORD_CLIENT_ID is rejected at load (P2 #59)', () => {
  withEnv(() => {
    // slot 0 (the primary bot) is registered on DISCORD_CLIENT_ID; a pool slot
    // that reuses it collides on the resolved bot user id, so the self/peer
    // filter could no longer distinguish the two personas.
    process.env.DISCORD_CLIENT_ID = '700000000000000007';
    process.env.DISCORD_ROOM_BOTS = JSON.stringify([
      { slot: 'clash', token: 'tok', clientId: '700000000000000007', name: 'Clash' },
    ]);

    assert.throws(
      () => loadRoomBots(),
      (err: Error) =>
        err.message.includes('"clash"') &&
        err.message.includes('700000000000000007') &&
        /primary/i.test(err.message),
    );
  });
});

test('malformed clientId throws naming the slot', () => {
  withEnv(() => {
    process.env.DISCORD_ROOM_BOT_COUNT = '1';
    process.env.DISCORD_ROOM_BOT_1_TOKEN = 'token-one';
    process.env.DISCORD_ROOM_BOT_1_CLIENT_ID = 'not-a-snowflake';
    process.env.DISCORD_ROOM_BOT_1_NAME = 'Alice';

    assert.throws(
      () => loadRoomBots(),
      (err: Error) => err.message.includes('slot "1"') && /snowflake/i.test(err.message),
    );
  });
});

test('empty clientId throws naming the slot', () => {
  withEnv(() => {
    process.env.DISCORD_ROOM_BOTS = JSON.stringify([
      { slot: 'x', token: 'tok', clientId: '', name: 'Empty' },
    ]);

    assert.throws(
      () => loadRoomBots(),
      (err: Error) => err.message.includes('"x"') && /clientId is empty/i.test(err.message),
    );
  });
});

test('no-free-slot error points at the onboarding checklist in docs/discord.md', () => {
  // Phase 6's `/room invite` reuses this exact string, so lock in the wording:
  // it must name the doc and route the user to the onboarding checklist section.
  assert.match(NO_FREE_ROOM_BOT_SLOT_ERROR, /No free room-bot slot/);
  assert.match(NO_FREE_ROOM_BOT_SLOT_ERROR, /docs\/discord\.md/);
  assert.ok(NO_FREE_ROOM_BOT_SLOT_ERROR.includes(ROOM_BOT_ONBOARDING_DOC_REF));
  assert.match(ROOM_BOT_ONBOARDING_DOC_REF, /onboarding checklist/);
});
