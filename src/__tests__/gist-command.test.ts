import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../providers/discord/commands/gist';

afterEach(() => {
  mock.restoreAll();
});

interface MockInteraction {
  channelId: string;
  options: {
    getString: (name: string, required?: boolean) => string | null;
    getBoolean: (name: string) => boolean | null;
  };
  deferReply: ReturnType<typeof mock.fn>;
  editReply: ReturnType<typeof mock.fn>;
  reply: ReturnType<typeof mock.fn>;
}

function makeInteraction(
  options: Record<string, string | boolean | null> = {},
): MockInteraction {
  return {
    channelId: 'ch-1',
    options: {
      getString: (name: string) => (options[name] as string | null) ?? null,
      getBoolean: (name: string) => (options[name] as boolean | null) ?? null,
    },
    deferReply: mock.fn(async () => {}),
    editReply: mock.fn(async () => {}),
    reply: mock.fn(async () => {}),
  };
}

test('gist rejects channels not connected to an agent', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => undefined);

  const i = makeInteraction();
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.reply.mock.calls[0].arguments[0] as { content: string };
  assert.ok(reply.content.includes('not connected to an agent'));
});

test('gist publishes and renders an embed with the gist url', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'createGist', async () => ({
    url: 'https://gist.example/abc',
    id: 'abc',
  }));

  const i = makeInteraction({ description: 'desc', public: true });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0] as {
    embeds: { data: { url: string; title: string; description: string } }[];
  };
  assert.equal(reply.embeds[0].data.url, 'https://gist.example/abc');
  assert.ok(reply.embeds[0].data.title.includes('TestBot'));
  assert.ok(reply.embeds[0].data.description.includes('public'));
});

test('gist surfaces a friendly error when createGist throws an Error', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'createGist', async () => {
    throw new Error('gh not authenticated');
  });

  const i = makeInteraction();
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('Could not publish gist'));
  assert.ok((reply as string).includes('gh not authenticated'));
});

test('gist tolerates non-Error throws (string)', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  // Reject with a non-Error value — must not blow up the catch handler.
  mock.method(maestro, 'createGist', async () => {
    throw 'plain string failure';
  });

  const i = makeInteraction();
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('Could not publish gist'));
  assert.ok((reply as string).includes('plain string failure'));
});

test('gist tolerates non-Error throws (object without message)', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'createGist', async () => {
    throw { code: 42 };
  });

  const i = makeInteraction();
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('Could not publish gist'));
});

test('gist truncates very long error messages to 1500 chars', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  const huge = 'x'.repeat(5000);
  mock.method(maestro, 'createGist', async () => {
    throw new Error(huge);
  });

  const i = makeInteraction();
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0] as string;
  // header text "❌ Could not publish gist: " is added on top of 1500 chars
  assert.ok(reply.length <= 1500 + 50);
  // Lower bound catches over-truncation regressions: the body must still
  // contain ~1500 chars of the original error.
  assert.ok(
    reply.length >= 1500,
    `reply length ${reply.length} indicates over-truncation`,
  );
  assert.ok(reply.startsWith('❌ Could not publish gist:'));
});
