import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebClient } from '@slack/web-api';
import { findOrCreateSlackChannel } from '../providers/slack/adapter';

type ListArgs = { cursor?: string; limit?: number; types?: string; exclude_archived?: boolean };
type ListResult = {
  channels: Array<{ id: string; name: string; is_archived?: boolean }>;
  response_metadata: { next_cursor: string };
};
type CreateResult = { channel: { id: string } | undefined };

interface FakeClient {
  conversations: {
    list: (args: ListArgs) => Promise<ListResult>;
    unarchive: (args: { channel: string }) => Promise<void>;
    create: (args: { name: string; is_private: boolean }) => Promise<CreateResult>;
  };
}

function makeClient(opts: {
  list: (args: ListArgs) => Promise<ListResult>;
  unarchive?: (args: { channel: string }) => Promise<void>;
  create?: (args: { name: string; is_private: boolean }) => Promise<CreateResult>;
}): { client: WebClient; calls: { list: number; unarchive: number; create: number; createNames: string[] } } {
  const calls = { list: 0, unarchive: 0, create: 0, createNames: [] as string[] };
  const fake: FakeClient = {
    conversations: {
      list: async (args) => {
        calls.list++;
        return opts.list(args);
      },
      unarchive: async (args) => {
        calls.unarchive++;
        if (!opts.unarchive) throw new Error('unarchive not stubbed');
        return opts.unarchive(args);
      },
      create: async (args) => {
        calls.create++;
        calls.createNames.push(args.name);
        if (!opts.create) throw new Error('create not stubbed');
        return opts.create(args);
      },
    },
  };
  return { client: fake as unknown as WebClient, calls };
}

const AGENT = { id: 'abcd1234efgh', name: 'My Agent' };
const EXPECTED_NAME = 'maestro-my-agent-abcd1234';

test('returns existing channel when found and not archived', async () => {
  const { client, calls } = makeClient({
    list: async () => ({
      channels: [{ id: 'C-EXISTING', name: EXPECTED_NAME, is_archived: false }],
      response_metadata: { next_cursor: '' },
    }),
  });

  const result = await findOrCreateSlackChannel(client, AGENT);

  assert.deepEqual(result, { channelId: 'C-EXISTING', isNew: false });
  assert.equal(calls.create, 0, 'must not create when an open channel exists');
  assert.equal(calls.unarchive, 0, 'must not unarchive an already-open channel');
});

test('unarchives and returns existing channel when found archived', async () => {
  const { client, calls } = makeClient({
    list: async () => ({
      channels: [{ id: 'C-ARCHIVED', name: EXPECTED_NAME, is_archived: true }],
      response_metadata: { next_cursor: '' },
    }),
    unarchive: async () => undefined,
  });

  const result = await findOrCreateSlackChannel(client, AGENT);

  assert.deepEqual(result, { channelId: 'C-ARCHIVED', isNew: false });
  assert.equal(calls.unarchive, 1, 'must unarchive the archived channel');
  assert.equal(calls.create, 0, 'must not create when unarchive succeeds');
});

test('falls back to timestamped create when unarchive fails', async () => {
  const { client, calls } = makeClient({
    list: async () => ({
      channels: [{ id: 'C-LOCKED', name: EXPECTED_NAME, is_archived: true }],
      response_metadata: { next_cursor: '' },
    }),
    unarchive: async () => {
      throw new Error('channel_locked');
    },
    create: async () => ({ channel: { id: 'C-FRESH' } }),
  });

  const result = await findOrCreateSlackChannel(client, AGENT);

  assert.equal(result.channelId, 'C-FRESH');
  assert.equal(result.isNew, true);
  assert.equal(calls.create, 1, 'must create a fallback channel when unarchive fails');
  assert.equal(calls.createNames.length, 1);
  // The fallback name keeps the original base and appends -<6 digits>.
  assert.match(calls.createNames[0], new RegExp(`^${EXPECTED_NAME}-\\d{6}$`));
});

test('creates with primary name when channel does not exist', async () => {
  const { client, calls } = makeClient({
    list: async () => ({
      channels: [{ id: 'C-OTHER', name: 'unrelated' }],
      response_metadata: { next_cursor: '' },
    }),
    create: async () => ({ channel: { id: 'C-NEW' } }),
  });

  const result = await findOrCreateSlackChannel(client, AGENT);

  assert.deepEqual(result, { channelId: 'C-NEW', isNew: true });
  assert.equal(calls.create, 1);
  assert.deepEqual(calls.createNames, [EXPECTED_NAME], 'must create with the primary (un-suffixed) name');
});

test('proceeds to create when conversations.list throws', async () => {
  // Network/auth error during list shouldn't block channel provisioning;
  // the adapter swallows the list error and falls through to create.
  const { client, calls } = makeClient({
    list: async () => {
      throw new Error('rate_limited');
    },
    create: async () => ({ channel: { id: 'C-NEW' } }),
  });

  const result = await findOrCreateSlackChannel(client, AGENT);

  assert.deepEqual(result, { channelId: 'C-NEW', isNew: true });
  assert.equal(calls.create, 1);
});

test('throws when conversations.create returns no channel id', async () => {
  const { client } = makeClient({
    list: async () => ({
      channels: [],
      response_metadata: { next_cursor: '' },
    }),
    create: async () => ({ channel: undefined }),
  });

  await assert.rejects(
    findOrCreateSlackChannel(client, AGENT),
    /Failed to create Slack channel for agent/,
  );
});

test('walks pagination during channel lookup', async () => {
  const pages: ListResult[] = [
    {
      channels: [{ id: 'C1', name: 'general' }],
      response_metadata: { next_cursor: 'cursor-1' },
    },
    {
      channels: [{ id: 'C2', name: 'random' }],
      response_metadata: { next_cursor: 'cursor-2' },
    },
    {
      channels: [{ id: 'C-MATCH', name: EXPECTED_NAME, is_archived: false }],
      response_metadata: { next_cursor: '' },
    },
  ];
  const { client, calls } = makeClient({
    list: async (args) => {
      if (!args.cursor) return pages[0];
      if (args.cursor === 'cursor-1') return pages[1];
      if (args.cursor === 'cursor-2') return pages[2];
      throw new Error(`unexpected cursor: ${args.cursor}`);
    },
  });

  const result = await findOrCreateSlackChannel(client, AGENT);

  assert.deepEqual(result, { channelId: 'C-MATCH', isNew: false });
  assert.equal(calls.list, 3, 'must walk all three pages');
  assert.equal(calls.create, 0);
});
