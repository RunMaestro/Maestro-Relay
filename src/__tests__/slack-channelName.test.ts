import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentChannelName,
  buildFallbackChannelName,
  findChannelByName,
} from '../providers/slack/adapter';

test('builds maestro-<sanitized>-<idprefix> from a clean name', () => {
  const out = buildAgentChannelName({ id: 'abcd1234efgh', name: 'My Agent' });
  assert.equal(out, 'maestro-my-agent-abcd1234');
});

test('lowercases, strips disallowed characters, and collapses dashes', () => {
  const out = buildAgentChannelName({ id: 'abcd1234', name: 'Foo!! Bar??' });
  assert.equal(out, 'maestro-foo-bar-abcd1234');
});

test('different agents with the same normalized name get different channel names', () => {
  const a = buildAgentChannelName({ id: 'abcd1234', name: 'My Agent' });
  const b = buildAgentChannelName({ id: 'wxyz9876', name: 'My Agent' });
  assert.notEqual(a, b);
  assert.equal(a, 'maestro-my-agent-abcd1234');
  assert.equal(b, 'maestro-my-agent-wxyz9876');
});

test('falls back to "agent" when the sanitized name is empty', () => {
  const out = buildAgentChannelName({ id: 'abcd1234', name: '!!!' });
  assert.equal(out, 'maestro-agent-abcd1234');
});

test('caps overall length at 80 characters', () => {
  const out = buildAgentChannelName({
    id: 'abcd1234',
    name: 'a'.repeat(200),
  });
  assert.ok(out.length <= 80, `expected <=80, got ${out.length}`);
  assert.match(out, /^maestro-/);
});

test('strips leading and trailing dashes from the sanitized name', () => {
  const out = buildAgentChannelName({ id: 'abcd1234', name: '!!!agent!!!' });
  assert.equal(out, 'maestro-agent-abcd1234');
});

test('handles agent.id with non-alphanumeric characters in the suffix', () => {
  const out = buildAgentChannelName({ id: 'a-b-c-d-1-2-3-4-5', name: 'My Agent' });
  assert.equal(out, 'maestro-my-agent-abcd1234');
});

test('buildFallbackChannelName preserves the full -<timestamp> suffix even at max length', () => {
  const base = 'a'.repeat(80);
  const out = buildFallbackChannelName(base, 1234567890123);
  assert.ok(out.length <= 80, `expected <=80, got ${out.length}`);
  // Suffix is `-` + last 6 digits of the timestamp = 7 chars.
  assert.match(out, /-890123$/);
});

test('buildFallbackChannelName trims base to make room for the suffix', () => {
  const base = 'maestro-agent-abcdefgh';
  const out = buildFallbackChannelName(base, 1700000000123);
  assert.equal(out, 'maestro-agent-abcdefgh-000123');
  assert.ok(out.length <= 80);
});

test('findChannelByName paginates until match found', async () => {
  const pages: Array<{
    channels: Array<{ id: string; name: string; is_archived?: boolean }>;
    response_metadata: { next_cursor?: string };
  }> = [
    {
      channels: [{ id: 'C100', name: 'general' }],
      response_metadata: { next_cursor: 'cursor-2' },
    },
    {
      channels: [{ id: 'C200', name: 'random' }],
      response_metadata: { next_cursor: 'cursor-3' },
    },
    {
      channels: [{ id: 'C300', name: 'maestro-target-abcd1234', is_archived: true }],
      response_metadata: { next_cursor: '' },
    },
  ];
  let calls = 0;
  const list = async (args: { cursor?: string }) => {
    calls++;
    if (!args.cursor) return pages[0];
    if (args.cursor === 'cursor-2') return pages[1];
    if (args.cursor === 'cursor-3') return pages[2];
    throw new Error(`unexpected cursor: ${args.cursor}`);
  };
  const result = await findChannelByName(list, 'maestro-target-abcd1234');
  assert.deepEqual(result, { id: 'C300', is_archived: true });
  assert.equal(calls, 3, 'should have walked all three pages');
});

test('findChannelByName returns null when name is on no page', async () => {
  const list = async (args: { cursor?: string }) => {
    if (!args.cursor) {
      return {
        channels: [{ id: 'C1', name: 'a' }],
        response_metadata: { next_cursor: 'next' },
      };
    }
    return {
      channels: [{ id: 'C2', name: 'b' }],
      response_metadata: { next_cursor: '' },
    };
  };
  const result = await findChannelByName(list, 'maestro-missing');
  assert.equal(result, null);
});

test('findChannelByName stops on the first page when next_cursor is empty', async () => {
  let calls = 0;
  const list = async () => {
    calls++;
    return {
      channels: [{ id: 'C1', name: 'maestro-x-abcd1234' }],
      response_metadata: { next_cursor: '' },
    };
  };
  const result = await findChannelByName(list, 'maestro-x-abcd1234');
  assert.deepEqual(result, { id: 'C1', is_archived: false });
  assert.equal(calls, 1);
});
