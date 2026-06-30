import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { tryHandleCommand } from '../providers/teams/commands';
import { channelDb } from '../providers/teams/channelsDb';
import { conversationRefsDb } from '../providers/teams/conversationRefsDb';
import { maestro } from '../core/maestro';

afterEach(() => {
  mock.restoreAll();
  delete process.env.TEAMS_ALLOWED_USER_IDS;
});

// --- Helpers ---

function makeTurn(conversationId = 'conv-1') {
  const replies: string[] = [];
  const turn = {
    activity: { conversation: { id: conversationId } },
    sendActivity: mock.fn(async (text: string) => {
      replies.push(text);
      return {};
    }),
    replies,
  };
  return turn;
}

// --- routing / unknown verbs ---

test('non-command text returns false (flows to agent)', async () => {
  const turn = makeTurn();
  const handled = await tryHandleCommand(turn, 'hello there agent', 'user-1');
  assert.equal(handled, false);
  assert.equal(turn.sendActivity.mock.callCount(), 0);
});

// --- authorization ---

test('unauthorized user is rejected and message consumed', async () => {
  process.env.TEAMS_ALLOWED_USER_IDS = 'allowed-user';
  const turn = makeTurn();
  const handled = await tryHandleCommand(turn, 'health', 'blocked-user');
  assert.equal(handled, true);
  assert.equal(turn.replies[0], 'You are not authorized.');
});

test('allowed user passes the authorization gate', async () => {
  process.env.TEAMS_ALLOWED_USER_IDS = 'allowed-user';
  mock.method(maestro, 'isInstalled', async () => true);
  const turn = makeTurn();
  const handled = await tryHandleCommand(turn, 'health', 'allowed-user');
  assert.equal(handled, true);
  assert.ok(turn.replies[0].includes('healthy'));
});

// --- health ---

test('health reports CLI reachable', async () => {
  mock.method(maestro, 'isInstalled', async () => true);
  const turn = makeTurn();
  const handled = await tryHandleCommand(turn, 'health', 'user-1');
  assert.equal(handled, true);
  assert.ok(turn.replies[0].includes('reachable'));
});

test('health reports CLI unreachable', async () => {
  mock.method(maestro, 'isInstalled', async () => false);
  const turn = makeTurn();
  await tryHandleCommand(turn, 'health', 'user-1');
  assert.ok(turn.replies[0].includes('not reachable'));
});

// --- agents list ---

test('agents (no sub) lists agents', async () => {
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-1', name: 'Alpha', toolType: 'claude-code', cwd: '/a' },
    { id: 'agent-2', name: 'Beta', toolType: 'claude-code', cwd: '/b' },
  ]);
  const turn = makeTurn();
  const handled = await tryHandleCommand(turn, 'agents', 'user-1');
  assert.equal(handled, true);
  assert.ok(turn.replies[0].includes('• Alpha (agent-1)'));
  assert.ok(turn.replies[0].includes('• Beta (agent-2)'));
});

test('agents list with empty roster', async () => {
  mock.method(maestro, 'listAgents', async () => []);
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents list', 'user-1');
  assert.equal(turn.replies[0], 'No agents available.');
});

// --- agents new ---

test('agents new binds an unbound chat', async () => {
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-1', name: 'Alpha', toolType: 'claude-code', cwd: '/a' },
  ]);
  const bindMock = mock.method(channelDb, 'bindOrRebind', () => 'bound' as const);
  const turn = makeTurn('conv-9');
  const handled = await tryHandleCommand(turn, 'agents new agent-1', 'user-1');

  assert.equal(handled, true);
  assert.equal(bindMock.mock.callCount(), 1);
  assert.deepEqual(bindMock.mock.calls[0].arguments, ['conv-9', 'agent-1', 'Alpha']);
  assert.ok(turn.replies[0].includes('Bound this chat to **Alpha**'));
});

test('agents new rebinds an already-bound chat and notes session reset', async () => {
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-2', name: 'Beta', toolType: 'claude-code', cwd: '/b' },
  ]);
  mock.method(channelDb, 'bindOrRebind', () => 'rebound' as const);
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents new agent-2', 'user-1');
  assert.ok(turn.replies[0].includes('Rebound'));
  assert.ok(turn.replies[0].toLowerCase().includes('session was reset'));
});

test('agents new resolves by id-prefix', async () => {
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-abcdef', name: 'Alpha', toolType: 'claude-code', cwd: '/a' },
  ]);
  const bindMock = mock.method(channelDb, 'bindOrRebind', () => 'bound' as const);
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents new agent-abc', 'user-1');
  assert.equal(bindMock.mock.calls[0].arguments[1], 'agent-abcdef');
});

test('agents new with unknown agent does not bind', async () => {
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-1', name: 'Alpha', toolType: 'claude-code', cwd: '/a' },
  ]);
  const bindMock = mock.method(channelDb, 'bindOrRebind', () => 'bound' as const);
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents new nope', 'user-1');
  assert.equal(bindMock.mock.callCount(), 0);
  assert.ok(turn.replies[0].includes('not found'));
});

test('agents new without an id shows usage', async () => {
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents new', 'user-1');
  assert.ok(turn.replies[0].includes('Usage'));
});

// --- agents current ---

test('agents current reports the bound agent', async () => {
  mock.method(channelDb, 'get', () => ({
    provider: 'teams',
    channel_id: 'conv-1',
    guild_id: null,
    agent_id: 'agent-1',
    agent_name: 'Alpha',
    session_id: null,
    read_only: 0,
    created_at: 0,
  }));
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents current', 'user-1');
  assert.ok(turn.replies[0].includes('**Alpha**'));
  assert.ok(turn.replies[0].includes('agent-1'));
});

test('agents current reports none when unbound', async () => {
  mock.method(channelDb, 'get', () => undefined);
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents current', 'user-1');
  assert.ok(turn.replies[0].includes('no agent'));
});

// --- agents disconnect ---

test('agents disconnect removes the binding and conversation ref', async () => {
  mock.method(channelDb, 'get', () => ({
    provider: 'teams',
    channel_id: 'conv-1',
    guild_id: null,
    agent_id: 'agent-1',
    agent_name: 'Alpha',
    session_id: null,
    read_only: 0,
    created_at: 0,
  }));
  const refRemove = mock.method(conversationRefsDb, 'remove', () => {});
  const chRemove = mock.method(channelDb, 'remove', () => {});
  const turn = makeTurn('conv-1');
  await tryHandleCommand(turn, 'agents disconnect', 'user-1');
  assert.equal(refRemove.mock.calls[0].arguments[0], 'conv-1');
  assert.equal(chRemove.mock.calls[0].arguments[0], 'conv-1');
  assert.ok(turn.replies[0].includes('Disconnected'));
});

test('agents disconnect on an unbound chat is a no-op reply', async () => {
  mock.method(channelDb, 'get', () => undefined);
  const refRemove = mock.method(conversationRefsDb, 'remove', () => {});
  const chRemove = mock.method(channelDb, 'remove', () => {});
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents disconnect', 'user-1');
  assert.equal(refRemove.mock.callCount(), 0);
  assert.equal(chRemove.mock.callCount(), 0);
});

// --- agents readonly ---

test('agents readonly on toggles read-only mode', async () => {
  mock.method(channelDb, 'get', () => ({
    provider: 'teams',
    channel_id: 'conv-1',
    guild_id: null,
    agent_id: 'agent-1',
    agent_name: 'Alpha',
    session_id: null,
    read_only: 0,
    created_at: 0,
  }));
  const setRo = mock.method(channelDb, 'setReadOnly', () => {});
  const turn = makeTurn('conv-1');
  await tryHandleCommand(turn, 'agents readonly on', 'user-1');
  assert.deepEqual(setRo.mock.calls[0].arguments, ['conv-1', true]);
  assert.ok(turn.replies[0].includes('read-only'));
});

test('agents readonly off toggles read-write mode', async () => {
  mock.method(channelDb, 'get', () => ({
    provider: 'teams',
    channel_id: 'conv-1',
    guild_id: null,
    agent_id: 'agent-1',
    agent_name: 'Alpha',
    session_id: null,
    read_only: 1,
    created_at: 0,
  }));
  const setRo = mock.method(channelDb, 'setReadOnly', () => {});
  const turn = makeTurn('conv-1');
  await tryHandleCommand(turn, 'agents readonly off', 'user-1');
  assert.deepEqual(setRo.mock.calls[0].arguments, ['conv-1', false]);
  assert.ok(turn.replies[0].includes('read-write'));
});

test('agents readonly with bad mode shows usage', async () => {
  mock.method(channelDb, 'get', () => ({
    provider: 'teams',
    channel_id: 'conv-1',
    guild_id: null,
    agent_id: 'agent-1',
    agent_name: 'Alpha',
    session_id: null,
    read_only: 0,
    created_at: 0,
  }));
  const setRo = mock.method(channelDb, 'setReadOnly', () => {});
  const turn = makeTurn();
  await tryHandleCommand(turn, 'agents readonly maybe', 'user-1');
  assert.equal(setRo.mock.callCount(), 0);
  assert.ok(turn.replies[0].includes('Usage'));
});

// --- session new ---

test('session new clears the session on a bound chat', async () => {
  mock.method(channelDb, 'get', () => ({
    provider: 'teams',
    channel_id: 'conv-1',
    guild_id: null,
    agent_id: 'agent-1',
    agent_name: 'Alpha',
    session_id: 'old-session',
    read_only: 0,
    created_at: 0,
  }));
  const update = mock.method(channelDb, 'updateSession', () => {});
  const turn = makeTurn('conv-1');
  const handled = await tryHandleCommand(turn, 'session new', 'user-1');
  assert.equal(handled, true);
  assert.deepEqual(update.mock.calls[0].arguments, ['conv-1', null]);
  assert.equal(turn.replies[0], 'Started a fresh session.');
});

test('session new on an unbound chat does not update', async () => {
  mock.method(channelDb, 'get', () => undefined);
  const update = mock.method(channelDb, 'updateSession', () => {});
  const turn = makeTurn();
  await tryHandleCommand(turn, 'session new', 'user-1');
  assert.equal(update.mock.callCount(), 0);
});

// --- error handling ---

test('a handler throwing is caught and reported as consumed', async () => {
  mock.method(maestro, 'listAgents', async () => {
    throw new Error('CLI down');
  });
  const turn = makeTurn();
  const handled = await tryHandleCommand(turn, 'agents list', 'user-1');
  assert.equal(handled, true);
  assert.equal(turn.replies[0], 'Failed to execute command.');
});
