import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execute, autocomplete } from '../providers/discord/commands/agents';
import { EMBED_FIELD_VALUE_MAX, EMBED_TITLE_MAX } from '../providers/discord/embed';

afterEach(() => {
  mock.restoreAll();
});

// --- Helpers ---

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'ch-1',
    guild: {
      id: 'guild-1',
      channels: {
        cache: {
          find: () => undefined,
        },
        create: mock.fn(async (opts: Record<string, unknown>) => ({
          id: 'new-ch-1',
          name: opts.name,
          isSendable: () => true,
          send: mock.fn(async () => ({})),
        })),
      },
    },
    channel: { delete: mock.fn(async () => {}) },
    user: { id: 'user-1' },
    options: {
      getSubcommand: () => 'list',
      getString: () => null,
    },
    deferReply: mock.fn(async () => {}),
    editReply: mock.fn(async () => {}),
    reply: mock.fn(async () => {}),
    ...overrides,
  } as any;
}

// --- /agents list ---

test('agents list shows agents in an embed', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => [
    { id: 'a-1', name: 'Alpha', toolType: 'claude', cwd: '/home' },
    { id: 'a-2', name: 'Beta', toolType: 'openai', cwd: '/work' },
  ]);

  const interaction = makeInteraction({
    options: { getSubcommand: () => 'list' },
  });

  await execute(interaction);

  assert.equal(interaction.deferReply.mock.callCount(), 1);
  assert.equal(interaction.editReply.mock.callCount(), 1);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.embeds);
  assert.equal(reply.embeds.length, 1);

  const embedData = reply.embeds[0].data;
  assert.ok(embedData.description.includes('Alpha'));
  assert.ok(embedData.description.includes('Beta'));
});

test('agents list shows message when no agents found', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => []);

  const interaction = makeInteraction({
    options: { getSubcommand: () => 'list' },
  });

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(typeof reply === 'string');
  assert.ok(reply.includes('No agents found'));
});

// --- /agents new ---

test('agents new creates a channel for a valid agent', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-abc', name: 'TestBot', toolType: 'claude', cwd: '/proj' },
  ]);

  const { channelDb } = await import('../providers/discord/channelsDb');
  const registerMock = mock.method(channelDb, 'register', () => {});

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'new',
      getString: (_name: string, _req: boolean) => 'agent-abc',
    },
  });

  await execute(interaction);

  assert.equal(registerMock.mock.callCount(), 1);
  assert.equal(registerMock.mock.calls[0].arguments[0], 'new-ch-1');
  assert.equal(registerMock.mock.calls[0].arguments[2], 'agent-abc');

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(typeof reply === 'string');
  assert.ok(reply.includes('Created'));
  assert.ok(reply.includes('TestBot'));
});

test('agents new rejects unknown agent', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => [
    { id: 'other-agent', name: 'Other', toolType: 'claude', cwd: '/' },
  ]);

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'new',
      getString: (_name: string, _req: boolean) => 'nonexistent',
    },
  });

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(typeof reply === 'string');
  assert.ok(reply.includes('No agent found'));
});

test('agents new requires a guild', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => []);

  const interaction = makeInteraction({
    guild: null,
    options: {
      getSubcommand: () => 'new',
      getString: (_name: string, _req: boolean) => 'agent-1',
    },
  });

  await execute(interaction);

  const reply = interaction.reply.mock.calls[0].arguments[0];
  assert.ok(reply.content.includes('must be used in a server'));
});

test('agents new bounds the channel name to Discord 100-char limit', async () => {
  const { maestro } = await import('../core/maestro');
  // 200-char agent name will produce a > 100-char channel name (+ "agent-" prefix).
  const longName = 'A'.repeat(200);
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-long', name: longName, toolType: 'claude', cwd: '/proj' },
  ]);

  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'register', () => {});

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'new',
      getString: (_name: string, _req: boolean) => 'agent-long',
    },
  });

  await execute(interaction);

  // create() is called twice: first for the "Maestro Agents" category, then for
  // the actual agent channel. Find the call that targets the agent channel.
  const calls = interaction.guild.channels.create.mock.calls;
  const channelCall = calls.find((c: { arguments: [{ name: string }] }) =>
    c.arguments[0].name.startsWith('agent-'),
  );
  assert.ok(channelCall, 'Expected a channel creation call starting with "agent-"');
  const passedName = channelCall.arguments[0].name as string;
  assert.ok(
    passedName.length <= 100,
    `Channel name length ${passedName.length} exceeds Discord 100-char limit`,
  );
  assert.ok(passedName.startsWith('agent-'));
});

test('agents new replies with a friendly error when channel is not sendable', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-abc', name: 'TestBot', toolType: 'claude', cwd: '/proj' },
  ]);

  const { channelDb } = await import('../providers/discord/channelsDb');
  const registerMock = mock.method(channelDb, 'register', () => {});

  const interaction = makeInteraction({
    guild: {
      id: 'guild-1',
      channels: {
        cache: { find: () => undefined },
        create: mock.fn(async (opts: Record<string, unknown>) => ({
          id: 'new-ch-1',
          name: opts.name,
          // Simulate a non-sendable channel (e.g. permissions issue).
          isSendable: () => false,
          send: mock.fn(async () => ({})),
        })),
      },
    },
    options: {
      getSubcommand: () => 'new',
      getString: (_name: string, _req: boolean) => 'agent-abc',
    },
  });

  await execute(interaction);

  // Should not register the channel when not sendable.
  assert.equal(registerMock.mock.callCount(), 0);
  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok(reply.includes('Failed to create a sendable channel'));
});

test('agents new matches agent by prefix', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-abc-123-full', name: 'PrefixBot', toolType: 'claude', cwd: '/proj' },
  ]);

  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'register', () => {});

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'new',
      getString: (_name: string, _req: boolean) => 'agent-abc',
    },
  });

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.includes('PrefixBot'));
});

// --- /agents show ---

test('agents show renders an embed with stats and recent activity', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: '/proj',
    groupName: 'Group A',
    stats: {
      historyEntries: 12,
      successCount: 10,
      failureCount: 2,
      totalInputTokens: 5000,
      totalOutputTokens: 1000,
      totalCost: 0.0123,
      totalElapsedMs: 5400,
    },
    recentHistory: [
      { id: 'h-1', type: 'CUE', timestamp: Date.now(), summary: 'first', success: true },
      { id: 'h-2', type: 'CUE', timestamp: Date.now(), summary: 'second', success: false },
    ],
  }));

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'show',
      getString: (_name: string, _req: boolean) => 'agent-1',
    },
  });

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.embeds);
  const data = reply.embeds[0].data;
  assert.equal(data.title, 'TestBot');
  const fieldNames = data.fields.map((f: { name: string }) => f.name);
  assert.ok(fieldNames.includes('Stats'));
  assert.ok(fieldNames.includes('Recent activity'));
});

test('agents show clamps an oversize cwd value to the field-value limit', async () => {
  const { maestro } = await import('../core/maestro');
  // 2000-char path comfortably exceeds the 1024 field limit (with backticks)
  const longCwd = '/very/long/path/segment/'.repeat(100);
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: longCwd,
  }));

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'show',
      getString: (_name: string, _req: boolean) => 'agent-1',
    },
  });

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  const cwdField = reply.embeds[0].data.fields.find((f: { name: string }) => f.name === 'Cwd');
  assert.ok(cwdField, 'Cwd field should be present');
  assert.ok(
    cwdField.value.length <= EMBED_FIELD_VALUE_MAX,
    `Cwd field length ${cwdField.value.length} exceeds ${EMBED_FIELD_VALUE_MAX}`,
  );
});

test('agents show clamps oversize title and groupName', async () => {
  const { maestro } = await import('../core/maestro');
  const longName = 'N'.repeat(EMBED_TITLE_MAX + 500);
  const longGroup = 'G'.repeat(EMBED_FIELD_VALUE_MAX + 500);
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: longName,
    toolType: 'claude',
    cwd: '/proj',
    groupName: longGroup,
  }));

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'show',
      getString: (_name: string, _req: boolean) => 'agent-1',
    },
  });

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  const data = reply.embeds[0].data;
  assert.ok(
    data.title.length <= EMBED_TITLE_MAX,
    `Title length ${data.title.length} exceeds ${EMBED_TITLE_MAX}`,
  );
  const groupField = data.fields.find((f: { name: string }) => f.name === 'Group');
  assert.ok(groupField, 'Group field should be present');
  assert.ok(
    groupField.value.length <= EMBED_FIELD_VALUE_MAX,
    `Group field length ${groupField.value.length} exceeds ${EMBED_FIELD_VALUE_MAX}`,
  );
});

test('agents show surfaces a friendly error when load fails', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => {
    throw new Error('agent missing');
  });

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'show',
      getString: (_name: string, _req: boolean) => 'agent-x',
    },
  });

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok(reply.includes('Could not load agent'));
});

// --- /agents disconnect ---

test('agents disconnect removes channel and schedules deletion', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  const { threadDb } = await import('../providers/discord/threadsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));
  const removeChannelMock = mock.method(channelDb, 'remove', () => {});
  mock.method(channelDb, 'listByAgentId', () => []);
  const removeThreadsMock = mock.method(threadDb, 'removeByChannel', () => {});
  mock.method(threadDb, 'getByAgentId', () => []);

  const { maestro } = await import('../core/maestro');
  // Return null so cleanupAgentFiles is never called (no real side effects)
  mock.method(maestro, 'getAgentCwd', async () => null);

  const interaction = makeInteraction({
    options: { getSubcommand: () => 'disconnect' },
  });

  await execute(interaction);

  assert.equal(removeChannelMock.mock.callCount(), 1);
  assert.equal(removeThreadsMock.mock.callCount(), 1);
  const reply = interaction.reply.mock.calls[0].arguments[0];
  assert.ok(reply.content.includes('Disconnecting'));
  assert.ok(reply.content.includes('TestBot'));
});

test('agents disconnect rejects non-agent channels', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => undefined);

  const interaction = makeInteraction({
    options: { getSubcommand: () => 'disconnect' },
  });

  await execute(interaction);

  const reply = interaction.reply.mock.calls[0].arguments[0];
  assert.ok(reply.content.includes('not an agent channel'));
});

// --- /agents readonly ---

test('agents readonly on sets read-only mode', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_name: 'TestBot',
  }));
  const setReadOnlyMock = mock.method(channelDb, 'setReadOnly', () => {});

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'readonly',
      getString: (name: string, _req: boolean) => {
        if (name === 'mode') return 'on';
        return null;
      },
    },
  });

  await execute(interaction);

  assert.equal(setReadOnlyMock.mock.callCount(), 1);
  assert.equal(setReadOnlyMock.mock.calls[0].arguments[1], true);

  const reply = interaction.reply.mock.calls[0].arguments[0];
  assert.ok(reply.embeds);
  const desc = reply.embeds[0].data.description;
  assert.ok(desc.includes('read-only'));
});

test('agents readonly off disables read-only mode', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_name: 'TestBot',
  }));
  const setReadOnlyMock = mock.method(channelDb, 'setReadOnly', () => {});

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'readonly',
      getString: (name: string, _req: boolean) => {
        if (name === 'mode') return 'off';
        return null;
      },
    },
  });

  await execute(interaction);

  assert.equal(setReadOnlyMock.mock.callCount(), 1);
  assert.equal(setReadOnlyMock.mock.calls[0].arguments[1], false);

  const reply = interaction.reply.mock.calls[0].arguments[0];
  const desc = reply.embeds[0].data.description;
  assert.ok(desc.includes('read-write'));
});

test('agents readonly rejects non-agent channels', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => undefined);

  const interaction = makeInteraction({
    options: {
      getSubcommand: () => 'readonly',
      getString: () => 'on',
    },
  });

  await execute(interaction);

  const reply = interaction.reply.mock.calls[0].arguments[0];
  assert.ok(reply.content.includes('not an agent channel'));
});

// --- autocomplete ---

test('autocomplete filters agents by name', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => [
    { id: 'a-1', name: 'AlphaBot', toolType: 'claude', cwd: '/' },
    { id: 'a-2', name: 'BetaBot', toolType: 'openai', cwd: '/' },
  ]);

  const responses: unknown[] = [];
  const interaction = {
    options: { getFocused: () => 'alpha' },
    respond: mock.fn(async (items: unknown) => {
      responses.push(items);
    }),
  } as any;

  await autocomplete(interaction);

  assert.equal(interaction.respond.mock.callCount(), 1);
  const items = responses[0] as Array<{ name: string; value: string }>;
  assert.equal(items.length, 1);
  assert.ok(items[0].name.includes('AlphaBot'));
  assert.equal(items[0].value, 'a-1');
});

test('autocomplete returns empty on error', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => {
    throw new Error('CLI fail');
  });

  const interaction = {
    options: { getFocused: () => '' },
    respond: mock.fn(async () => {}),
  } as any;

  await autocomplete(interaction);

  assert.equal(interaction.respond.mock.callCount(), 1);
  const items = interaction.respond.mock.calls[0].arguments[0];
  assert.deepEqual(items, []);
});
