import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { promises as fs } from 'fs';
import path from 'path';
import { autocomplete, execute, resolveContainedDocPath } from '../providers/discord/commands/auto-run';

afterEach(() => {
  mock.restoreAll();
});

interface MockInteraction {
  channelId: string;
  options: {
    getSubcommand: () => string;
    getString: (name: string, required?: boolean) => string | null;
    getInteger: (name: string) => number | null;
    getBoolean: (name: string) => boolean | null;
  };
  deferReply: ReturnType<typeof mock.fn>;
  editReply: ReturnType<typeof mock.fn>;
  reply: ReturnType<typeof mock.fn>;
}

function makeInteraction(
  options: Record<string, string | number | boolean | null> = {},
): MockInteraction {
  return {
    channelId: 'ch-1',
    options: {
      getSubcommand: () => 'start',
      getString: (name: string) => (options[name] as string | null) ?? null,
      getInteger: (name: string) => (options[name] as number | null) ?? null,
      getBoolean: (name: string) => (options[name] as boolean | null) ?? null,
    },
    deferReply: mock.fn(async () => {}),
    editReply: mock.fn(async () => {}),
    reply: mock.fn(async () => {}),
  };
}

test('auto-run start rejects channels not connected to an agent', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => undefined);

  const i = makeInteraction({ doc: 'plan.md' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.reply.mock.calls[0].arguments[0] as { content: string };
  assert.ok(reply.content.includes('not connected to an agent'));
});

test('auto-run start resolves a bare filename against the agent Auto Run folder', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: '/proj',
    autoRunFolderPath: '/agents/auto-run-docs',
  }));

  const startMock = mock.method(maestro, 'startAutoRun', async () => '');

  const i = makeInteraction({ doc: 'plan.md' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  assert.equal(startMock.mock.callCount(), 1);
  const opts = startMock.mock.calls[0].arguments[0] as { docs: string[] };
  assert.deepEqual(opts.docs, [path.join('/agents/auto-run-docs', 'plan.md')]);
});

test('auto-run start resolves a relative subpath against the agent Auto Run folder', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: '/proj',
    autoRunFolderPath: '/agents/auto-run-docs',
  }));

  const startMock = mock.method(maestro, 'startAutoRun', async () => '');

  const i = makeInteraction({ doc: 'subdir/doc.md' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  assert.equal(startMock.mock.callCount(), 1);
  const opts = startMock.mock.calls[0].arguments[0] as { docs: string[] };
  assert.deepEqual(opts.docs, [path.join('/agents/auto-run-docs', 'subdir/doc.md')]);
});

test('auto-run start accepts an absolute path that lives inside the agent folder', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: '/proj',
    autoRunFolderPath: '/agents/auto-run-docs',
  }));
  const startMock = mock.method(maestro, 'startAutoRun', async () => '');

  const inside = '/agents/auto-run-docs/subdir/doc.md';
  const i = makeInteraction({ doc: inside });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  assert.equal(startMock.mock.callCount(), 1);
  const opts = startMock.mock.calls[0].arguments[0] as { docs: string[] };
  assert.deepEqual(opts.docs, [inside]);
});

test('auto-run start rejects an absolute path outside the agent folder', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: '/proj',
    autoRunFolderPath: '/agents/auto-run-docs',
  }));
  const startMock = mock.method(maestro, 'startAutoRun', async () => '');

  const i = makeInteraction({ doc: '/etc/passwd' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  assert.equal(startMock.mock.callCount(), 0);
  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('inside'));
});

test('auto-run start rejects relative paths that escape the folder via traversal', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: '/proj',
    autoRunFolderPath: '/agents/auto-run-docs',
  }));
  const startMock = mock.method(maestro, 'startAutoRun', async () => '');

  const i = makeInteraction({ doc: '../../etc/passwd' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  assert.equal(startMock.mock.callCount(), 0);
  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('inside'));
});

test('auto-run start rejects when showAgent fails to resolve a folder', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => {
    throw new Error('cli unavailable');
  });
  const startMock = mock.method(maestro, 'startAutoRun', async () => '');

  const i = makeInteraction({ doc: 'plan.md' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  assert.equal(startMock.mock.callCount(), 0);
  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('Auto Run folder'));
});

test('auto-run start rejects when autoRunFolderPath is missing on the agent', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: '/proj',
    // autoRunFolderPath intentionally absent
  }));
  const startMock = mock.method(maestro, 'startAutoRun', async () => '');

  const i = makeInteraction({ doc: 'plan.md' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  assert.equal(startMock.mock.callCount(), 0);
  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('Auto Run folder'));
});

// --- resolveContainedDocPath unit tests ---

test('resolveContainedDocPath resolves a bare filename inside the folder', () => {
  const out = resolveContainedDocPath('/agents/auto', 'plan.md');
  assert.equal(out, path.resolve('/agents/auto', 'plan.md'));
});

test('resolveContainedDocPath resolves a relative subpath inside the folder', () => {
  const out = resolveContainedDocPath('/agents/auto', 'subdir/plan.md');
  assert.equal(out, path.resolve('/agents/auto', 'subdir/plan.md'));
});

test('resolveContainedDocPath accepts an absolute path inside the folder', () => {
  const out = resolveContainedDocPath('/agents/auto', '/agents/auto/x/y.md');
  assert.equal(out, path.resolve('/agents/auto/x/y.md'));
});

test('resolveContainedDocPath rejects an absolute path outside the folder', () => {
  assert.equal(resolveContainedDocPath('/agents/auto', '/etc/passwd'), null);
});

test('resolveContainedDocPath rejects relative traversal that escapes the folder', () => {
  assert.equal(resolveContainedDocPath('/agents/auto', '../../etc/passwd'), null);
});

test('resolveContainedDocPath rejects an exact match of the folder itself', () => {
  assert.equal(resolveContainedDocPath('/agents/auto', '.'), null);
});

test('resolveContainedDocPath rejects sibling-prefix paths that look similar', () => {
  // /agents/auto-evil starts with "/agents/auto" as a string but is a
  // different directory. Containment must use a separator boundary.
  assert.equal(resolveContainedDocPath('/agents/auto', '/agents/auto-evil/x.md'), null);
});

test('auto-run start surfaces errors from startAutoRun', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => ({
    channel_id: 'ch-1',
    agent_id: 'agent-1',
    agent_name: 'TestBot',
  }));

  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showAgent', async () => ({
    id: 'agent-1',
    name: 'TestBot',
    toolType: 'claude',
    cwd: '/proj',
    autoRunFolderPath: '/agents/auto-run-docs',
  }));
  mock.method(maestro, 'startAutoRun', async () => {
    throw new Error('boom');
  });

  const i = makeInteraction({ doc: 'plan.md' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('Auto Run failed to launch'));
  assert.ok((reply as string).includes('boom'));
});

// --- autocomplete ---

test('auto-run autocomplete includes nested .md files using forward slashes', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-run-ac-'));
  try {
    await fs.writeFile(path.join(tmp, 'top.md'), '#');
    await fs.mkdir(path.join(tmp, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'sub', 'nested.md'), '#');
    await fs.mkdir(path.join(tmp, 'sub', 'deeper'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'sub', 'deeper', 'plan.md'), '#');
    // Non-md file should be ignored
    await fs.writeFile(path.join(tmp, 'sub', 'README.txt'), 'x');

    const { channelDb } = await import('../providers/discord/channelsDb');
    mock.method(channelDb, 'get', () => ({
      channel_id: 'ch-1',
      agent_id: 'agent-1',
      agent_name: 'TestBot',
    }));

    const { maestro } = await import('../core/maestro');
    mock.method(maestro, 'showAgent', async () => ({
      id: 'agent-1',
      name: 'TestBot',
      toolType: 'claude',
      cwd: '/proj',
      autoRunFolderPath: tmp,
    }));

    const responded: Array<Array<{ name: string; value: string }>> = [];
    const i = {
      channelId: 'ch-1',
      options: {
        getFocused: () => ({ name: 'doc', value: '' }),
      },
      respond: mock.fn(async (items: Array<{ name: string; value: string }>) => {
        responded.push(items);
      }),
    };

    await autocomplete(i as unknown as Parameters<typeof autocomplete>[0]);

    assert.equal(responded.length, 1);
    const values = responded[0].map((entry) => entry.value);
    assert.ok(values.includes('top.md'));
    assert.ok(values.includes('sub/nested.md'));
    assert.ok(values.includes('sub/deeper/plan.md'));
    // Non-md file must not appear
    assert.ok(!values.some((v) => v.endsWith('.txt')));
    // No backslashes regardless of platform
    for (const v of values) assert.ok(!v.includes('\\'), `value ${v} should not contain \\`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('auto-run autocomplete returns empty when channel is not registered', async () => {
  const { channelDb } = await import('../providers/discord/channelsDb');
  mock.method(channelDb, 'get', () => undefined);

  const responded: unknown[] = [];
  const i = {
    channelId: 'ch-x',
    options: { getFocused: () => ({ name: 'doc', value: '' }) },
    respond: mock.fn(async (items: unknown) => {
      responded.push(items);
    }),
  };

  await autocomplete(i as unknown as Parameters<typeof autocomplete>[0]);
  assert.deepEqual(responded[0], []);
});
