import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  dispatchCommand,
  type DispatchCommandContext,
} from '../providers/telegram/commands';
import type { TelegramCommandContext } from '../providers/telegram/commands/types';

function makeCtx(overrides: Partial<DispatchCommandContext> = {}): {
  ctx: DispatchCommandContext;
  replies: string[];
} {
  const replies: string[] = [];
  const ctx: DispatchCommandContext = {
    bot: {} as DispatchCommandContext['bot'],
    chatId: 'chat-1',
    threadId: undefined,
    fromUserId: 'user-1',
    boundAgentId: 'agent-1',
    boundAgentName: 'My Agent',
    chatMode: 'dm',
    reply: async (text: string) => {
      replies.push(text);
    },
    ...overrides,
  };
  return { ctx, replies };
}

test('COMMANDS exposes all seven Telegram commands with descriptions', () => {
  const expected = ['health', 'agents', 'session', 'gist', 'playbook', 'notes', 'auto-run'];
  for (const name of expected) {
    const entry = COMMANDS[name];
    assert.ok(entry, `missing command ${name}`);
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.length > 0, `${name} description should be non-empty`);
    assert.equal(typeof entry.execute, 'function');
  }
});

test('dispatchCommand returns false for non-slash text', async () => {
  const { ctx } = makeCtx();
  assert.equal(await dispatchCommand('hello there', ctx), false);
  assert.equal(await dispatchCommand('', ctx), false);
  assert.equal(await dispatchCommand('/', ctx), false);
});

test('dispatchCommand returns false for unknown commands', async () => {
  const { ctx, replies } = makeCtx();
  assert.equal(await dispatchCommand('/notarealcommand', ctx), false);
  assert.deepEqual(replies, [], 'unknown command should not produce a reply');
});

test('dispatchCommand parses bare command with no args', async () => {
  const seen: TelegramCommandContext[] = [];
  const original = COMMANDS.health.execute;
  COMMANDS.health.execute = async (cmdCtx) => {
    seen.push(cmdCtx);
  };
  try {
    const { ctx } = makeCtx();
    const handled = await dispatchCommand('/health', ctx);
    assert.equal(handled, true);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].args, []);
    assert.equal(seen[0].rawText, '/health');
    assert.equal(seen[0].chatId, 'chat-1');
    assert.equal(seen[0].boundAgentName, 'My Agent');
  } finally {
    COMMANDS.health.execute = original;
  }
});

test('dispatchCommand splits positional args on whitespace', async () => {
  const seen: TelegramCommandContext[] = [];
  const original = COMMANDS.agents.execute;
  COMMANDS.agents.execute = async (cmdCtx) => {
    seen.push(cmdCtx);
  };
  try {
    const { ctx } = makeCtx();
    const handled = await dispatchCommand('/agents list  one   two', ctx);
    assert.equal(handled, true);
    assert.deepEqual(seen[0].args, ['list', 'one', 'two']);
  } finally {
    COMMANDS.agents.execute = original;
  }
});

test('dispatchCommand strips @<botname> suffix from the command word', async () => {
  const seen: TelegramCommandContext[] = [];
  const original = COMMANDS.agents.execute;
  COMMANDS.agents.execute = async (cmdCtx) => {
    seen.push(cmdCtx);
  };
  try {
    const { ctx } = makeCtx();
    const handled = await dispatchCommand('/agents@MyBot list', ctx);
    assert.equal(handled, true);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].args, ['list']);
  } finally {
    COMMANDS.agents.execute = original;
  }
});

test('dispatchCommand is case-insensitive for command name', async () => {
  const seen: TelegramCommandContext[] = [];
  const original = COMMANDS.health.execute;
  COMMANDS.health.execute = async (cmdCtx) => {
    seen.push(cmdCtx);
  };
  try {
    const { ctx } = makeCtx();
    const handled = await dispatchCommand('/HEALTH', ctx);
    assert.equal(handled, true);
    assert.equal(seen.length, 1);
  } finally {
    COMMANDS.health.execute = original;
  }
});

test('dispatchCommand handles hyphenated command name auto-run', async () => {
  const seen: TelegramCommandContext[] = [];
  const original = COMMANDS['auto-run'].execute;
  COMMANDS['auto-run'].execute = async (cmdCtx) => {
    seen.push(cmdCtx);
  };
  try {
    const { ctx } = makeCtx();
    const handled = await dispatchCommand('/auto-run start docs/foo.md', ctx);
    assert.equal(handled, true);
    assert.deepEqual(seen[0].args, ['start', 'docs/foo.md']);
  } finally {
    COMMANDS['auto-run'].execute = original;
  }
});

test('dispatchCommand preserves rawText including args', async () => {
  const seen: TelegramCommandContext[] = [];
  const original = COMMANDS.gist.execute;
  COMMANDS.gist.execute = async (cmdCtx) => {
    seen.push(cmdCtx);
  };
  try {
    const { ctx } = makeCtx();
    const text = '/gist --public a custom description';
    const handled = await dispatchCommand(text, ctx);
    assert.equal(handled, true);
    assert.equal(seen[0].rawText, text);
    assert.deepEqual(seen[0].args, ['--public', 'a', 'custom', 'description']);
  } finally {
    COMMANDS.gist.execute = original;
  }
});
