import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackProvider } from '../providers/slack/adapter';
import { conversationDb } from '../providers/slack/conversationsDb';
import { toOutgoing, CALLOUT_META } from '../core/callouts';
import { splitMessage } from '../core/splitMessage';
import { renderTables } from '../core/renderTables';
import type { ChannelTarget, OutgoingMessage } from '../core/types';

/**
 * Slack callout attachment rendering (Phase 04). The adapter's `send()` must
 * turn a message carrying `msg.callout` into a single colored attachment (title
 * = emoji + label, text = body, color = the variant hex) while leaving ordinary
 * prose messages as plain `text` posts. The channel-vs-thread resolution is
 * shared by both branches. We drive the public `send()` against a mocked
 * `chat.postMessage`, injecting a fake client so no Slack app is needed.
 */

/** A stand-in Slack client that records every `chat.postMessage` payload in order. */
function makeClient(): { client: unknown; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const client = {
    chat: {
      async postMessage(arg: Record<string, unknown>) {
        calls.push(arg);
        return { ok: true };
      },
    },
  };
  return { client, calls };
}

/** A `SlackProvider` whose private client is the injected mock. */
function makeProvider(client: unknown): SlackProvider {
  const provider = new SlackProvider();
  (provider as unknown as { client: unknown }).client = client;
  return provider;
}

const CHANNEL_TARGET: ChannelTarget = { provider: 'slack', channelId: 'C-test' };

/** Narrow a recorded call's `attachments` to the shape we assert against. */
function attachmentsOf(arg: Record<string, unknown>): { color: string; title: string; text: string }[] {
  assert.ok(Array.isArray(arg.attachments), 'callout post includes an attachments array');
  return arg.attachments as { color: string; title: string; text: string }[];
}

test('a callout ⇒ one postMessage with a single colored attachment', async () => {
  const { client, calls } = makeClient();
  const provider = makeProvider(client);

  const msg: OutgoingMessage = {
    text: '> [!NOTE]\n> hello world',
    callout: { variant: 'NOTE', body: 'hello world' },
  };
  await provider.send(CHANNEL_TARGET, msg);

  assert.equal(calls.length, 1, 'exactly one postMessage call');
  const meta = CALLOUT_META.NOTE;
  const attachments = attachmentsOf(calls[0]);
  assert.equal(attachments.length, 1, 'a single attachment per callout');
  assert.equal(attachments[0].color, meta.hex);
  assert.equal(attachments[0].color, '#1f6feb', 'NOTE hex anchor');
  assert.equal(attachments[0].title, `${meta.emoji} ${meta.label}`);
  assert.equal(attachments[0].text, 'hello world');
  assert.equal(calls[0].channel, 'C-test', 'posts to the plain channel target');
});

test('each callout variant attaches its own label, emoji, and color', async () => {
  for (const variant of Object.keys(CALLOUT_META) as (keyof typeof CALLOUT_META)[]) {
    const { client, calls } = makeClient();
    const provider = makeProvider(client);
    const meta = CALLOUT_META[variant];

    const msg: OutgoingMessage = {
      text: `> [!${variant}]\n> body`,
      callout: { variant, body: 'body text' },
    };
    await provider.send(CHANNEL_TARGET, msg);

    const attachments = attachmentsOf(calls[0]);
    assert.equal(attachments[0].color, meta.hex, `${variant} color`);
    assert.equal(attachments[0].title, `${meta.emoji} ${meta.label}`, `${variant} title`);
    assert.equal(attachments[0].text, 'body text', `${variant} text`);
  }
});

test('a custom callout title overrides the emoji+label default', async () => {
  const { client, calls } = makeClient();
  const provider = makeProvider(client);

  const msg: OutgoingMessage = {
    text: '> [!TIP]\n> body',
    callout: { variant: 'TIP', title: 'Custom Heading', body: 'body' },
  };
  await provider.send(CHANNEL_TARGET, msg);

  const attachments = attachmentsOf(calls[0]);
  assert.equal(attachments[0].title, 'Custom Heading');
});

test('thread targets resolve to parent channel + thread_ts, attachment preserved', async () => {
  const threadTs = '1777189034.828869';
  conversationDb.register(threadTs, 'C-parent', 'agent-1', 'U-owner');
  try {
    const { client, calls } = makeClient();
    const provider = makeProvider(client);

    const msg: OutgoingMessage = {
      text: '> [!WARNING]\n> heads up',
      callout: { variant: 'WARNING', body: 'heads up' },
    };
    await provider.send({ provider: 'slack', channelId: threadTs }, msg);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, 'C-parent', 'resolves the parent channel');
    assert.equal(calls[0].thread_ts, threadTs, 'keeps the thread_ts');
    const attachments = attachmentsOf(calls[0]);
    assert.equal(attachments[0].color, CALLOUT_META.WARNING.hex);
    assert.equal(attachments[0].text, 'heads up');
  } finally {
    conversationDb.remove(threadTs);
  }
});

test('N mixed segments ⇒ N postMessage calls in order (prose=text, callout=attachment)', async () => {
  const { client, calls } = makeClient();
  const provider = makeProvider(client);

  const text = 'para one\n\n> [!NOTE]\n> hello world\n\npara two';
  const messages = toOutgoing(text, { split: splitMessage, renderTables });
  assert.equal(messages.length, 3, 'toOutgoing yields text, callout, text');

  for (const m of messages) await provider.send(CHANNEL_TARGET, m);

  assert.equal(calls.length, 3, 'one postMessage per message, in order');

  // First and last are prose → plain text, no attachments.
  assert.equal(calls[0].attachments, undefined, 'prose post has no attachments');
  assert.equal(calls[2].attachments, undefined, 'prose post has no attachments');
  assert.match(calls[0].text as string, /para one/);
  assert.match(calls[2].text as string, /para two/);

  // Middle is the callout → attachment with the NOTE presentation.
  const meta = CALLOUT_META.NOTE;
  const attachments = attachmentsOf(calls[1]);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].color, meta.hex);
  assert.equal(attachments[0].title, `${meta.emoji} ${meta.label}`);
  assert.equal(attachments[0].text, 'hello world');
});

test('a mention rides in the top-level text beside the attachment', async () => {
  const prev = process.env.SLACK_MENTION_USER_ID;
  process.env.SLACK_MENTION_USER_ID = 'U-ping';
  try {
    const { client, calls } = makeClient();
    const provider = makeProvider(client);

    const msg: OutgoingMessage = {
      text: '> [!IMPORTANT]\n> read me',
      callout: { variant: 'IMPORTANT', body: 'read me' },
      mention: true,
    };
    await provider.send(CHANNEL_TARGET, msg);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, '<@U-ping>', 'mention is in the top-level text');
    const attachments = attachmentsOf(calls[0]);
    assert.equal(attachments.length, 1, 'attachment still present alongside the mention');
    assert.equal(attachments[0].text, 'read me');
  } finally {
    if (prev === undefined) delete process.env.SLACK_MENTION_USER_ID;
    else process.env.SLACK_MENTION_USER_ID = prev;
  }
});
