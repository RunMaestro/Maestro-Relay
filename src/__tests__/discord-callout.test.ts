import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordProvider } from '../providers/discord/adapter';
import { toOutgoing } from '../core/callouts';
import { CALLOUT_META } from '../core/callouts';
import { splitMessage } from '../core/splitMessage';
import { renderTables } from '../core/renderTables';
import { EMBED_DESCRIPTION_MAX } from '../providers/discord/embed';
import { RateLimitError } from '../core/errors';
import type { ChannelTarget, OutgoingMessage } from '../core/types';

/**
 * Discord callout embed rendering (Phase 03). The adapter's `send()` must turn a
 * message carrying `msg.callout` into a colored `EmbedBuilder` (title = emoji +
 * label, description = body, color = the variant hex as an int) while leaving
 * ordinary prose messages as plain strings. We drive the public `send()` against
 * a mocked sendable channel, injecting a fake client so no gateway is needed.
 */

/** A stand-in sendable channel that records every `send()` argument in order. */
function makeChannel(): { channel: unknown; calls: unknown[] } {
  const calls: unknown[] = [];
  const channel = {
    isSendable() {
      return true;
    },
    async send(arg: unknown) {
      calls.push(arg);
      return {};
    },
  };
  return { channel, calls };
}

/** A `DiscordProvider` whose private client resolves every fetch to `channel`. */
function makeProvider(channel: unknown): DiscordProvider {
  const provider = new DiscordProvider();
  (provider as unknown as { client: unknown }).client = {
    channels: {
      async fetch() {
        return channel;
      },
    },
  };
  return provider;
}

const TARGET: ChannelTarget = { provider: 'discord', channelId: 'C-test' };

/** Narrow a recorded call to the discord.js embed-send object shape. */
function asEmbedCall(arg: unknown): { content?: unknown; embeds: { data: Record<string, unknown> }[] } {
  assert.equal(typeof arg, 'object', 'callout call passes an options object, not a string');
  const obj = arg as { embeds?: { data: Record<string, unknown> }[] };
  assert.ok(Array.isArray(obj.embeds), 'callout call includes an embeds array');
  return obj as { content?: unknown; embeds: { data: Record<string, unknown> }[] };
}

test('1 callout + 2 prose blocks ⇒ 3 send calls in order (prose=string, callout=embed)', async () => {
  const { channel, calls } = makeChannel();
  const provider = makeProvider(channel);

  const text = 'para one\n\n> [!NOTE]\n> hello world\n\npara two';
  const messages = toOutgoing(text, { split: splitMessage, renderTables });
  assert.equal(messages.length, 3, 'toOutgoing yields text, callout, text');

  for (const m of messages) await provider.send(TARGET, m);

  assert.equal(calls.length, 3, 'one send() per message, in order');

  // First and last are prose → plain strings, no embeds.
  assert.equal(typeof calls[0], 'string');
  assert.equal(typeof calls[2], 'string');
  assert.match(calls[0] as string, /para one/);
  assert.match(calls[2] as string, /para two/);

  // Middle is the callout → embed with the NOTE presentation.
  const meta = CALLOUT_META.NOTE;
  const { embeds } = asEmbedCall(calls[1]);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].data.title, `${meta.emoji} ${meta.label}`);
  assert.equal(embeds[0].data.description, 'hello world');
  assert.equal(embeds[0].data.color, parseInt(meta.hex.slice(1), 16));
  // Independent anchor: NOTE's #1f6feb as a Discord color int.
  assert.equal(embeds[0].data.color, 2060267);
});

test('a plain blockquote (> quote) renders as a string, not an embed', async () => {
  const { channel, calls } = makeChannel();
  const provider = makeProvider(channel);

  const messages = toOutgoing('> just a quote', { split: splitMessage, renderTables });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].callout, undefined, 'a plain blockquote is not a callout');

  for (const m of messages) await provider.send(TARGET, m);

  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0], 'string');
  assert.match(calls[0] as string, /just a quote/);
});

test('each callout variant embeds its own label, emoji, and color', async () => {
  for (const variant of Object.keys(CALLOUT_META) as (keyof typeof CALLOUT_META)[]) {
    const { channel, calls } = makeChannel();
    const provider = makeProvider(channel);
    const meta = CALLOUT_META[variant];

    const msg: OutgoingMessage = {
      text: `> [!${variant}]\n> body`,
      callout: { variant, body: 'body text' },
    };
    await provider.send(TARGET, msg);

    const { embeds } = asEmbedCall(calls[0]);
    assert.equal(embeds[0].data.title, `${meta.emoji} ${meta.label}`, `${variant} title`);
    assert.equal(embeds[0].data.description, 'body text', `${variant} description`);
    assert.equal(embeds[0].data.color, parseInt(meta.hex.slice(1), 16), `${variant} color`);
  }
});

test('an empty callout body yields a title-only embed (no description)', async () => {
  const { channel, calls } = makeChannel();
  const provider = makeProvider(channel);

  const msg: OutgoingMessage = {
    text: '> [!TIP]',
    callout: { variant: 'TIP', body: '' },
  };
  await provider.send(TARGET, msg);

  const { embeds } = asEmbedCall(calls[0]);
  assert.equal(embeds[0].data.title, `${CALLOUT_META.TIP.emoji} ${CALLOUT_META.TIP.label}`);
  assert.equal(embeds[0].data.description, undefined, 'empty body leaves description unset');
});

test('an oversized callout body is clamped to the 4096 description limit', async () => {
  const { channel, calls } = makeChannel();
  const provider = makeProvider(channel);

  const msg: OutgoingMessage = {
    text: '> [!WARNING]\n> big',
    callout: { variant: 'WARNING', body: 'x'.repeat(EMBED_DESCRIPTION_MAX + 500) },
  };
  await provider.send(TARGET, msg);

  const { embeds } = asEmbedCall(calls[0]);
  const description = embeds[0].data.description as string;
  assert.ok(description.length <= EMBED_DESCRIPTION_MAX, 'description clamped via clampDescription');
});

test('a failing embed send degrades to the plaintext blockquote fallback', async () => {
  const calls: unknown[] = [];
  // Reject only the embed send; the plaintext retry succeeds.
  const channel = {
    isSendable() {
      return true;
    },
    async send(arg: unknown) {
      calls.push(arg);
      if (typeof arg === 'object' && arg !== null && 'embeds' in arg) {
        throw new Error('Missing Permissions');
      }
      return {};
    },
  };
  const provider = makeProvider(channel);

  const msg: OutgoingMessage = {
    text: '> [!NOTE]\n> hello world',
    callout: { variant: 'NOTE', body: 'hello world' },
  };
  await provider.send(TARGET, msg);

  assert.equal(calls.length, 2, 'embed attempted, then the plaintext fallback');
  assert.equal(calls[1], msg.text, 'fallback posts the lossless blockquote string');
});

test('a rate-limited embed send propagates instead of degrading', async () => {
  const calls: unknown[] = [];
  const channel = {
    isSendable() {
      return true;
    },
    async send(arg: unknown) {
      calls.push(arg);
      throw Object.assign(new Error('rate limited'), { status: 429, retryAfter: 250 });
    },
  };
  const provider = makeProvider(channel);

  await assert.rejects(
    provider.send(TARGET, { text: '> [!NOTE]\n> hi', callout: { variant: 'NOTE', body: 'hi' } }),
    (err: unknown) => err instanceof RateLimitError,
    'rate limits surface to sendWithRetry rather than degrading',
  );
  assert.equal(calls.length, 1, 'no plaintext fallback attempted on a rate limit');
});

test('a callout fallback carries the mention prefix', async () => {
  const prev = process.env.DISCORD_MENTION_USER_ID;
  process.env.DISCORD_MENTION_USER_ID = 'U-ping';
  try {
    const calls: unknown[] = [];
    const channel = {
      isSendable() {
        return true;
      },
      async send(arg: unknown) {
        calls.push(arg);
        if (typeof arg === 'object' && arg !== null && 'embeds' in arg) {
          throw new Error('Missing Permissions');
        }
        return {};
      },
    };
    const provider = makeProvider(channel);

    await provider.send(TARGET, {
      text: '> [!NOTE]\n> hi',
      callout: { variant: 'NOTE', body: 'hi' },
      mention: true,
    });

    assert.equal(calls.length, 2);
    assert.match(calls[1] as string, /^<@U-ping> /, 'fallback keeps the ping');
  } finally {
    if (prev === undefined) delete process.env.DISCORD_MENTION_USER_ID;
    else process.env.DISCORD_MENTION_USER_ID = prev;
  }
});
