import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { channelDb, getChannelInfoForInteraction } from '../providers/discord/channelsDb';

afterEach(() => {
  mock.restoreAll();
});

// --- Helpers ---

const BINDING = {
  provider: 'discord',
  channel_id: 'parent-1',
  guild_id: 'guild-1',
  agent_id: 'agent-1',
  session_id: null,
} as unknown as ReturnType<typeof channelDb.get>;

function makeInteraction(opts: {
  channelId: string;
  isThread?: boolean;
  parentId?: string | null;
  noChannel?: boolean;
}) {
  return {
    channelId: opts.channelId,
    channel: opts.noChannel
      ? null
      : {
          isThread: () => opts.isThread ?? false,
          parentId: opts.parentId ?? null,
        },
  } as unknown as Parameters<typeof getChannelInfoForInteraction>[0];
}

// --- getChannelInfoForInteraction (parent-channel fallback) ---

test('resolves a direct binding without consulting the parent channel', () => {
  const get = mock.method(channelDb, 'get', (id: string) =>
    id === 'ch-1' ? BINDING : undefined,
  );

  const info = getChannelInfoForInteraction(makeInteraction({ channelId: 'ch-1' }));

  assert.equal(info, BINDING);
  // Only the direct lookup should have happened.
  assert.equal(get.mock.callCount(), 1);
  assert.equal(get.mock.calls[0].arguments[0], 'ch-1');
});

test('falls back to the parent channel binding when invoked inside a thread', () => {
  // The thread itself is unbound; only its parent carries the agent binding.
  const get = mock.method(channelDb, 'get', (id: string) =>
    id === 'parent-1' ? BINDING : undefined,
  );

  const info = getChannelInfoForInteraction(
    makeInteraction({ channelId: 'thread-1', isThread: true, parentId: 'parent-1' }),
  );

  assert.equal(info, BINDING, 'thread should inherit the parent channel binding');
  assert.equal(get.mock.callCount(), 2);
  assert.equal(get.mock.calls[0].arguments[0], 'thread-1');
  assert.equal(get.mock.calls[1].arguments[0], 'parent-1');
});

test('prefers the thread own binding over the parent channel', () => {
  const threadBinding = { ...BINDING, channel_id: 'thread-1', agent_id: 'agent-thread' };
  mock.method(channelDb, 'get', (id: string) =>
    id === 'thread-1' ? threadBinding : BINDING,
  );

  const info = getChannelInfoForInteraction(
    makeInteraction({ channelId: 'thread-1', isThread: true, parentId: 'parent-1' }),
  );

  assert.equal(info?.agent_id, 'agent-thread');
});

test('returns undefined for an unbound non-thread channel', () => {
  mock.method(channelDb, 'get', () => undefined);

  const info = getChannelInfoForInteraction(makeInteraction({ channelId: 'ch-1' }));

  assert.equal(info, undefined);
});

test('returns undefined when neither the thread nor its parent is bound', () => {
  mock.method(channelDb, 'get', () => undefined);

  const info = getChannelInfoForInteraction(
    makeInteraction({ channelId: 'thread-1', isThread: true, parentId: 'parent-1' }),
  );

  assert.equal(info, undefined);
});

test('returns undefined for a thread with no parentId', () => {
  mock.method(channelDb, 'get', () => undefined);

  const info = getChannelInfoForInteraction(
    makeInteraction({ channelId: 'thread-1', isThread: true, parentId: null }),
  );

  assert.equal(info, undefined);
});

test('tolerates an interaction with no resolvable channel', () => {
  mock.method(channelDb, 'get', () => undefined);

  assert.doesNotThrow(() => {
    const info = getChannelInfoForInteraction(
      makeInteraction({ channelId: 'ch-1', noChannel: true }),
    );
    assert.equal(info, undefined);
  });
});
