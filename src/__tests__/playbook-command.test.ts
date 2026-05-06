import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../providers/discord/commands/playbook';
import {
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_TITLE_MAX,
} from '../providers/discord/embed';

afterEach(() => {
  mock.restoreAll();
});

interface MockInteraction {
  options: {
    getSubcommand: () => string;
    getString: (name: string, required?: boolean) => string | null;
  };
  deferReply: ReturnType<typeof mock.fn>;
  editReply: ReturnType<typeof mock.fn>;
  reply: ReturnType<typeof mock.fn>;
}

function makeInteraction(sub: string, options: Record<string, string | null> = {}): MockInteraction {
  return {
    options: {
      getSubcommand: () => sub,
      getString: (name: string) => options[name] ?? null,
    },
    deferReply: mock.fn(async () => {}),
    editReply: mock.fn(async () => {}),
    reply: mock.fn(async () => {}),
  };
}

test('playbook list renders an embed with playbooks', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listPlaybooks', async () => [
    {
      id: 'pb-1',
      name: 'Build & Test',
      description: '',
      documentCount: 2,
      taskCount: 7,
      agentName: 'Alpha',
    },
  ]);

  const i = makeInteraction('list');
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0] as { embeds: { data: { description: string } }[] };
  assert.ok(reply.embeds);
  assert.ok(reply.embeds[0].data.description.includes('Build & Test'));
  assert.ok(reply.embeds[0].data.description.includes('Alpha'));
});

test('playbook list shows a friendly message when no playbooks exist', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'listPlaybooks', async () => []);

  const i = makeInteraction('list');
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('No playbooks'));
});

test('playbook show clamps oversize description and document field', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showPlaybook', async () => ({
    id: 'pb-1',
    name: 'Big Playbook',
    description: 'd'.repeat(EMBED_DESCRIPTION_MAX + 1000),
    documentCount: 30,
    taskCount: 60,
    documents: Array.from({ length: 15 }, (_, i) => ({
      path: '/very/long/path/segment/'.repeat(20) + `doc-${i}.md`,
      taskCount: 5,
      completedCount: 1,
    })),
  }));

  const i = makeInteraction('show', { playbook: 'pb-1' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  type EmbedData = {
    description: string;
    fields: { name: string; value: string }[];
  };
  const reply = i.editReply.mock.calls[0].arguments[0] as { embeds: { data: EmbedData }[] };
  const data = reply.embeds[0].data;
  assert.ok(data.description.length <= EMBED_DESCRIPTION_MAX);

  const docs = data.fields.find((f) => f.name === 'Documents');
  assert.ok(docs, 'Documents field should be present');
  assert.ok(docs!.value.length <= EMBED_FIELD_VALUE_MAX);
});

test('playbook show clamps oversize title and agent name', async () => {
  const { maestro } = await import('../core/maestro');
  const longName = 'P'.repeat(EMBED_TITLE_MAX + 500);
  const longAgent = 'A'.repeat(EMBED_FIELD_VALUE_MAX + 500);
  mock.method(maestro, 'showPlaybook', async () => ({
    id: 'pb-1',
    name: longName,
    description: 'short',
    documentCount: 1,
    taskCount: 1,
    agentName: longAgent,
    documents: [],
  }));

  const i = makeInteraction('show', { playbook: 'pb-1' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  type EmbedData = {
    title: string;
    fields: { name: string; value: string }[];
  };
  const reply = i.editReply.mock.calls[0].arguments[0] as { embeds: { data: EmbedData }[] };
  const data = reply.embeds[0].data;
  assert.ok(
    data.title.length <= EMBED_TITLE_MAX,
    `Title length ${data.title.length} exceeds ${EMBED_TITLE_MAX}`,
  );
  const agentField = data.fields.find((f) => f.name === 'Agent');
  assert.ok(agentField, 'Agent field should be present');
  assert.ok(
    agentField!.value.length <= EMBED_FIELD_VALUE_MAX,
    `Agent field length ${agentField!.value.length} exceeds ${EMBED_FIELD_VALUE_MAX}`,
  );
});

test('playbook show surfaces a friendly error when load fails', async () => {
  const { maestro } = await import('../core/maestro');
  mock.method(maestro, 'showPlaybook', async () => {
    throw new Error('not found');
  });

  const i = makeInteraction('show', { playbook: 'pb-missing' });
  await execute(i as unknown as Parameters<typeof execute>[0]);

  const reply = i.editReply.mock.calls[0].arguments[0];
  assert.equal(typeof reply, 'string');
  assert.ok((reply as string).includes('Could not load playbook'));
});
