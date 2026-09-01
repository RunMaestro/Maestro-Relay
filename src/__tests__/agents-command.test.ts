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
    client: { user: { id: 'bot-1' } },
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

test('autocomplete returns agents sorted by name', async () => {
  const { maestro } = await import('../core/maestro');
  // Deliberately unsorted, and not sorted by id either.
  mock.method(maestro, 'listAgents', async () => [
    { id: 'a-3', name: 'Zulu', toolType: 'claude', cwd: '/' },
    { id: 'a-1', name: 'Alpha', toolType: 'claude', cwd: '/' },
    { id: 'a-2', name: 'Mike', toolType: 'openai', cwd: '/' },
  ]);

  const interaction = {
    options: { getFocused: () => '' },
    respond: mock.fn(async () => {}),
  } as any;

  await autocomplete(interaction);

  const items = interaction.respond.mock.calls[0].arguments[0] as Array<{
    name: string;
    value: string;
  }>;
  assert.deepEqual(
    items.map((i) => i.value),
    ['a-1', 'a-2', 'a-3'],
    'entries should be ordered by agent name, not by input order',
  );
});

test('autocomplete sorts before truncating to the 25-item Discord limit', async () => {
  const { maestro } = await import('../core/maestro');
  // 30 agents supplied in reverse name order. Discord caps choices at 25, so
  // if truncation happened before sorting the alphabetically-first agents
  // would be dropped.
  const agents = Array.from({ length: 30 }, (_, idx) => {
    const n = 30 - idx;
    return {
      id: `a-${String(n).padStart(2, '0')}`,
      name: `Agent-${String(n).padStart(2, '0')}`,
      toolType: 'claude',
      cwd: '/',
    };
  });
  mock.method(maestro, 'listAgents', async () => agents);

  const interaction = {
    options: { getFocused: () => '' },
    respond: mock.fn(async () => {}),
  } as any;

  await autocomplete(interaction);

  const items = interaction.respond.mock.calls[0].arguments[0] as Array<{
    name: string;
    value: string;
  }>;
  assert.equal(items.length, 25, 'must respect the Discord 25-choice cap');
  assert.equal(items[0].value, 'a-01', 'lowest-sorting agent must survive truncation');
  assert.equal(items[24].value, 'a-25');
  assert.ok(
    !items.some((i) => i.value === 'a-30'),
    'highest-sorting agents should be the ones truncated away',
  );
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

// --- /agents new: channel visibility ---

/**
 * Pull the permissionOverwrites the command passed when it created the text
 * channel. Selected by name rather than call index: `/agents new` also creates
 * the category, and which call comes first is not the point of these tests.
 */
function overwritesFor(interaction: any) {
  const call = interaction.guild.channels.create.mock.calls
    .map((c: any) => c.arguments[0])
    .find((o: any) => o.name !== 'Maestro Agents');
  assert.ok(call, 'expected the agent channel to be created');
  return call.permissionOverwrites;
}

function newInteraction(visibility: string | null, extra: Record<string, unknown> = {}) {
  return makeInteraction({
    options: {
      getSubcommand: () => 'new',
      getString: (name: string) => (name === 'visibility' ? visibility : 'agent-abc'),
    },
    ...extra,
  });
}

async function stubAgentAndDb() {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listAgents', async () => [
    { id: 'agent-abc', name: 'TestBot', toolType: 'claude', cwd: '/proj' },
  ]);
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'register', () => {});
}

test('agents new defaults to a private channel', async () => {
  await stubAgentAndDb();
  const interaction = newInteraction(null);

  await execute(interaction);

  const overwrites = overwritesFor(interaction);
  assert.ok(Array.isArray(overwrites), 'expected permissionOverwrites to be set');

  const everyone = overwrites.find((o: any) => o.id === 'guild-1');
  assert.ok(everyone, '@everyone (guild id) must appear in the overwrites');
  assert.ok(everyone.deny?.length, '@everyone must be denied ViewChannel');
});

test('agents new grants the bot and the creator on a private channel', async () => {
  await stubAgentAndDb();
  const interaction = newInteraction('private');

  await execute(interaction);

  const ids = overwritesFor(interaction).map((o: any) => o.id);
  assert.ok(ids.includes('bot-1'), 'the bot must keep access to the channel it posts in');
  assert.ok(ids.includes('user-1'), 'the creator must be able to see the channel they made');
});

test('agents new does not duplicate an overwrite when the creator is the bot', async () => {
  await stubAgentAndDb();
  const interaction = newInteraction('private', { user: { id: 'bot-1' } });

  await execute(interaction);

  const ids = overwritesFor(interaction).map((o: any) => o.id);
  assert.equal(
    ids.filter((id: string) => id === 'bot-1').length,
    1,
    'the bot should appear exactly once',
  );
});

// Regression: public creation used to pass `permissionOverwrites: undefined`,
// which inherits the Maestro Agents category. A category created by an earlier
// private /agents new denies @everyone ViewChannel, so the "public" channel was
// invisible while the reply said it was visible to everyone.
test('agents new makes a public channel visible to @everyone explicitly', async () => {
  await stubAgentAndDb();
  const interaction = newInteraction('public');

  await execute(interaction);

  const overwrites = overwritesFor(interaction);
  assert.ok(Array.isArray(overwrites), 'public creation must set overwrites, not inherit them');

  const everyone = overwrites.find((o: any) => o.id === 'guild-1');
  assert.ok(everyone, "@everyone must appear in a public channel's overwrites");
  assert.ok(everyone.allow?.length, '@everyone must be allowed ViewChannel');
  assert.ok(!everyone.deny?.length, '@everyone must not be denied anything on a public channel');

  const ids = overwrites.map((o: any) => o.id);
  assert.ok(ids.includes('bot-1'), 'the bot must keep access to the channel it posts in');
});

// Regression: ManageMessages was granted to the bot but is not in the
// documented invite integer, and Discord rejects an overwrite for a bit the bot
// does not hold -- turning /agents new into a hard 50013 failure.
test('agents new does not grant the bot permissions the invite link omits', async () => {
  const { PermissionFlagsBits } = await import('discord.js');
  await stubAgentAndDb();
  const interaction = newInteraction(null);

  await execute(interaction);

  const bot = overwritesFor(interaction).find((o: any) => o.id === 'bot-1');
  assert.ok(bot, 'the bot overwrite must exist');
  assert.ok(
    !bot.allow.includes(PermissionFlagsBits.ManageMessages),
    'ManageMessages is not in the documented invite integer and is unused',
  );
});

test('agents new warns in the reply when the channel is public', async () => {
  await stubAgentAndDb();
  const interaction = newInteraction('public');

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.includes('visible to everyone'), 'a public channel must say so');
});

test('agents new points at /agents grant when the channel is private', async () => {
  await stubAgentAndDb();
  const interaction = newInteraction(null);

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.includes('/agents grant'), 'a private channel must say how to add someone');
});

test('agents new locks a category it creates itself', async () => {
  await stubAgentAndDb();
  const interaction = newInteraction(null);

  await execute(interaction);

  // call 0 is the category (cache.find returns undefined), call 1 the channel
  const created = interaction.guild.channels.create.mock.calls.map((c: any) => c.arguments[0]);
  const category = created.find((o: any) => o.name === 'Maestro Agents');
  assert.ok(category, 'expected the category to be created');
  const everyone = category.permissionOverwrites.find((o: any) => o.id === 'guild-1');
  assert.ok(everyone?.deny?.length, 'a category created for private agents must deny @everyone');
});

// --- /agents grant | revoke ---

/** A member who holds every permission -- the default for these tests. */
const ALL_PERMS = { has: () => true };
/** A member who holds none, i.e. a collaborator who was merely granted access. */
const NO_PERMS = { has: () => false };

function accessInteraction(
  action: 'grant' | 'revoke',
  targetId = 'user-2',
  overrides: Record<string, unknown> = {},
) {
  const edit = mock.fn(async (_id: string, _perms: Record<string, boolean>) => {});
  const del = mock.fn(async (_id: string) => {});
  const interaction = makeInteraction({
    options: {
      getSubcommand: () => action,
      getUser: () => ({ id: targetId }),
    },
    memberPermissions: ALL_PERMS,
    channel: {
      id: 'ch-1',
      isThread: () => false,
      permissionOverwrites: { edit, delete: del },
    },
    ...overrides,
  });
  return { interaction, edit, del };
}

async function stubRegisteredChannel() {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-abc',
    agent_name: 'TestBot',
  }));
}

test('agents grant adds a channel overwrite for the target user', async () => {
  await stubRegisteredChannel();
  const { interaction, edit } = accessInteraction('grant');

  await execute(interaction);

  assert.equal(edit.mock.callCount(), 1);
  assert.equal(edit.mock.calls[0].arguments[0], 'user-2');
  assert.deepEqual(edit.mock.calls[0].arguments[1], {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });
});

test('agents revoke deletes the target user overwrite', async () => {
  await stubRegisteredChannel();
  const { interaction, del } = accessInteraction('revoke');

  await execute(interaction);

  assert.equal(del.mock.callCount(), 1);
  assert.equal(del.mock.calls[0].arguments[0], 'user-2');
});

test('agents revoke warns that a role grant can still apply', async () => {
  await stubRegisteredChannel();
  const { interaction } = accessInteraction('revoke');

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.includes('role'), 'revoke must not imply more than it delivers');
});

test('agents grant refuses outside a registered agent channel', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => undefined);
  const { interaction, edit } = accessInteraction('grant');

  await execute(interaction);

  assert.equal(edit.mock.callCount(), 0, 'an unregistered channel must not be modified');
  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.includes('not an agent channel'));
});

test('agents revoke refuses to remove the bot itself', async () => {
  await stubRegisteredChannel();
  const { interaction, del } = accessInteraction('revoke', 'bot-1');

  await execute(interaction);

  assert.equal(del.mock.callCount(), 0, 'locking the bot out would orphan the channel');
  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.includes('Refusing'));
});

test('agents grant reports a missing Manage Roles permission instead of throwing', async () => {
  await stubRegisteredChannel();
  const edit = mock.fn(async (_id: string, _perms: Record<string, boolean>) => {
    throw new Error('Missing Permissions');
  });
  const interaction = makeInteraction({
    options: { getSubcommand: () => 'grant', getUser: () => ({ id: 'user-2' }) },
    memberPermissions: ALL_PERMS,
    channel: {
      id: 'ch-1',
      isThread: () => false,
      permissionOverwrites: { edit, delete: mock.fn(async () => {}) },
    },
  });

  await execute(interaction);

  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.includes('Manage Roles'), 'the operator needs to know what to fix');
});

// Regression: /agents grant and /agents revoke had no permission gate at all,
// so anyone who could see the channel could widen it -- a granted collaborator
// could grant a stranger a shell on the operator's machine.
test('agents grant refuses a caller without channel-management permissions', async () => {
  await stubRegisteredChannel();
  const { interaction, edit } = accessInteraction('grant', 'user-2', {
    memberPermissions: NO_PERMS,
  });

  await execute(interaction);

  assert.equal(edit.mock.callCount(), 0, 'a mere participant must not re-key the channel');
  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(reply.includes('Manage Channels'), 'the reply must name what is missing');
});

test('agents revoke refuses a caller without channel-management permissions', async () => {
  await stubRegisteredChannel();
  const { interaction, del } = accessInteraction('revoke', 'user-2', {
    memberPermissions: NO_PERMS,
  });

  await execute(interaction);

  assert.equal(del.mock.callCount(), 0);
});

test('agents grant allows a listed relay operator without Discord permissions', async () => {
  await stubRegisteredChannel();
  const prev = process.env.DISCORD_ALLOWED_USER_IDS;
  process.env.DISCORD_ALLOWED_USER_IDS = 'user-1';
  try {
    const { interaction, edit } = accessInteraction('grant', 'user-2', {
      memberPermissions: NO_PERMS,
    });
    await execute(interaction);
    assert.equal(edit.mock.callCount(), 1, 'the relay operator is an operator by definition');
  } finally {
    if (prev === undefined) delete process.env.DISCORD_ALLOWED_USER_IDS;
    else process.env.DISCORD_ALLOWED_USER_IDS = prev;
  }
});

// Regression: channelDb.get(interaction.channelId) only matches the parent
// agent channel, so running /agents grant from inside a session thread -- the
// natural place to be -- replied "This is not an agent channel."
test('agents grant works from inside a session thread and edits the parent', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', (id: string) =>
    id === 'ch-1'
      ? { channel_id: 'ch-1', agent_id: 'agent-abc', agent_name: 'TestBot' }
      : undefined,
  );

  const edit = mock.fn(async (_id: string, _perms: Record<string, boolean>) => {});
  const interaction = makeInteraction({
    channelId: 'thread-9',
    options: { getSubcommand: () => 'grant', getUser: () => ({ id: 'user-2' }) },
    memberPermissions: ALL_PERMS,
    channel: {
      id: 'thread-9',
      isThread: () => true,
      parentId: 'ch-1',
      parent: { id: 'ch-1', permissionOverwrites: { edit, delete: mock.fn(async () => {}) } },
    },
  });

  await execute(interaction);

  assert.equal(edit.mock.callCount(), 1, 'the overwrite belongs on the parent agent channel');
  assert.equal(edit.mock.calls[0].arguments[0], 'user-2');
  const reply = interaction.editReply.mock.calls[0].arguments[0];
  assert.ok(!reply.includes('not an agent channel'), reply);
  assert.ok(reply.includes('<#ch-1>'), 'the reply must point at the parent channel');
});
