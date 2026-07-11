import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordClient } from '../plugin/providers/discord';
import type { InboundMessage, ReplySink, RouteOutcome } from '../plugin/entry';
import type { DiscordConfig } from '../plugin/registry';
import type { ReplyResult } from '../plugin/reply';
import { ManualScheduler, createFakeSdk, flush } from './plugin-helpers';

/**
 * The Discord Gateway client reimplements the slice of the protocol Relay needs
 * over the brokered SDK (no discord.js): HELLO -> IDENTIFY, heartbeat, and
 * MESSAGE_CREATE -> route -> reply over REST. Time is manual and inbound frames
 * are injected via `calls.emitSocket`, so nothing depends on the network.
 */

const openConfig: DiscordConfig = { clientId: '', guildId: '', allowedUserIds: [] };

/** A canned agent reply the fake router hands to the sink. */
const REPLY: ReplyResult = { sessionId: 'S', text: 'pong', chunks: ['pong'], reason: 'event' };

function messageFrame(seq: number, d: Record<string, unknown>): string {
  return JSON.stringify({ op: 0, s: seq, t: 'MESSAGE_CREATE', d });
}

function readyFrame(seq: number, botId: string): string {
  return JSON.stringify({
    op: 0,
    s: seq,
    t: 'READY',
    d: { session_id: 'sess-1', resume_gateway_url: 'wss://resume.discord.gg', user: { id: botId } },
  });
}

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

test('sends IDENTIFY and schedules a heartbeat after HELLO', async () => {
  const { sdk, calls } = createFakeSdk();
  const scheduler = new ManualScheduler();
  const client = createDiscordClient({
    sdk,
    token: 'tok-123',
    config: openConfig,
    route: async () => ({ status: 'unbound' }) as RouteOutcome,
    scheduler,
  });

  await client.connect();
  await flush();
  assert.equal(calls.connects.length, 1);
  assert.match(calls.connects[0].url, /gateway\.discord\.gg/);
  assert.equal(client.connected(), false, 'not connected until READY');

  calls.emitSocket('sock-1', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  await flush();

  const identify = calls.sends.map((s) => JSON.parse(s.data)).find((f) => f.op === 2);
  assert.ok(identify, 'IDENTIFY (op 2) was sent');
  assert.equal(identify.d.token, 'tok-123');
  assert.equal(typeof identify.d.intents, 'number');
  assert.ok(scheduler.pendingCount >= 1, 'a heartbeat timer is pending');

  // Firing the heartbeat timer emits an op-1 frame.
  await scheduler.fire();
  const heartbeat = calls.sends.map((s) => JSON.parse(s.data)).find((f) => f.op === 1);
  assert.ok(heartbeat, 'heartbeat (op 1) was sent');
});

test('READY marks the client connected and captures the bot user id', async () => {
  const { sdk, calls } = createFakeSdk();
  const scheduler = new ManualScheduler();
  const routed: InboundMessage[] = [];
  const client = createDiscordClient({
    sdk,
    token: 'tok',
    config: openConfig,
    route: async (m) => {
      routed.push(m);
      return { status: 'dispatched', agentId: 'a', reply: REPLY } as RouteOutcome;
    },
    scheduler,
  });

  await client.connect();
  calls.emitSocket('sock-1', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  calls.emitSocket('sock-1', { type: 'message', data: readyFrame(1, 'bot-1') });
  await flush();
  assert.equal(client.connected(), true);

  // The bot's own message and other bots' messages are ignored.
  calls.emitSocket('sock-1', {
    type: 'message',
    data: messageFrame(2, { channel_id: 'c', author: { id: 'bot-1', bot: true }, content: 'echo' }),
  });
  calls.emitSocket('sock-1', {
    type: 'message',
    data: messageFrame(3, { channel_id: 'c', author: { id: 'other-bot', bot: true }, content: 'hi' }),
  });
  await flush();
  assert.deepEqual(routed, [], 'bot-authored messages never route');
});

test('a user MESSAGE_CREATE routes and posts the reply over Discord REST', async () => {
  const { sdk, calls } = createFakeSdk();
  const scheduler = new ManualScheduler();
  const routed: InboundMessage[] = [];
  const route = async (m: InboundMessage, sink: ReplySink): Promise<RouteOutcome> => {
    routed.push(m);
    await sink(m, REPLY);
    return { status: 'dispatched', agentId: 'agent-1', reply: REPLY };
  };
  const client = createDiscordClient({ sdk, token: 'tok', config: openConfig, route, scheduler });

  await client.connect();
  calls.emitSocket('sock-1', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  calls.emitSocket('sock-1', { type: 'message', data: readyFrame(1, 'bot-1') });
  calls.emitSocket('sock-1', {
    type: 'message',
    data: messageFrame(2, {
      channel_id: 'chan-9',
      guild_id: 'g1',
      author: { id: 'u1', bot: false },
      content: 'ping',
    }),
  });
  await flush();

  assert.deepEqual(
    routed.map((m) => ({ provider: m.provider, channelId: m.channelId, userId: m.userId, text: m.text })),
    [{ provider: 'discord', channelId: 'chan-9', userId: 'u1', text: 'ping' }],
  );
  assert.equal(calls.fetches.length, 1, 'one REST post for the reply');
  assert.equal(calls.fetches[0].url, 'https://discord.com/api/v10/channels/chan-9/messages');
  const init = calls.fetches[0].init as FetchInit;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bot tok');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { content: 'pong' });
});

test('honors the guild scope and allowed-user filters', async () => {
  const { sdk, calls } = createFakeSdk();
  const scheduler = new ManualScheduler();
  const routed: InboundMessage[] = [];
  const client = createDiscordClient({
    sdk,
    token: 'tok',
    config: { clientId: '', guildId: 'g1', allowedUserIds: ['u1'] },
    route: async (m) => {
      routed.push(m);
      return { status: 'unbound' } as RouteOutcome;
    },
    scheduler,
  });

  await client.connect();
  calls.emitSocket('sock-1', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  calls.emitSocket('sock-1', { type: 'message', data: readyFrame(1, 'bot-1') });

  // Wrong guild -> dropped.
  calls.emitSocket('sock-1', {
    type: 'message',
    data: messageFrame(2, { channel_id: 'c', guild_id: 'g2', author: { id: 'u1' }, content: 'a' }),
  });
  // Right guild, disallowed user -> dropped.
  calls.emitSocket('sock-1', {
    type: 'message',
    data: messageFrame(3, { channel_id: 'c', guild_id: 'g1', author: { id: 'u2' }, content: 'b' }),
  });
  // Right guild, allowed user -> routed.
  calls.emitSocket('sock-1', {
    type: 'message',
    data: messageFrame(4, { channel_id: 'c', guild_id: 'g1', author: { id: 'u1' }, content: 'c' }),
  });
  await flush();

  assert.deepEqual(
    routed.map((m) => m.text),
    ['c'],
    'only the allowed user in the pinned guild routes',
  );
});

test('splits a reply longer than the Discord limit into multiple posts', async () => {
  const { sdk, calls } = createFakeSdk();
  const scheduler = new ManualScheduler();
  const long = 'x'.repeat(2500);
  const client = createDiscordClient({
    sdk,
    token: 'tok',
    config: openConfig,
    route: async (m, sink) => {
      await sink(m, { sessionId: 'S', text: long, chunks: [long], reason: 'event' });
      return { status: 'dispatched', agentId: 'a', reply: REPLY };
    },
    scheduler,
  });

  await client.connect();
  calls.emitSocket('sock-1', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  calls.emitSocket('sock-1', { type: 'message', data: readyFrame(1, 'bot-1') });
  calls.emitSocket('sock-1', {
    type: 'message',
    data: messageFrame(2, { channel_id: 'c', author: { id: 'u1' }, content: 'go' }),
  });
  await flush();

  assert.ok(calls.fetches.length >= 2, 'a 2500-char reply is posted as multiple chunks');
  for (const f of calls.fetches) {
    const body = JSON.parse((f.init as FetchInit).body) as { content: string };
    assert.ok(body.content.length <= 2000, 'each chunk fits under Discord 2000-char cap');
  }
});

test('server RECONNECT (op 7) closes the socket and resumes on a fresh connection', async () => {
  const { sdk, calls } = createFakeSdk();
  const scheduler = new ManualScheduler();
  const client = createDiscordClient({
    sdk,
    token: 'tok',
    config: openConfig,
    route: async () => ({ status: 'unbound' }) as RouteOutcome,
    scheduler,
  });

  await client.connect();
  calls.emitSocket('sock-1', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  calls.emitSocket('sock-1', { type: 'message', data: readyFrame(1, 'bot-1') });
  await flush();

  calls.emitSocket('sock-1', { type: 'message', data: JSON.stringify({ op: 7 }) });
  await flush();
  assert.deepEqual(
    calls.closes.map((c) => c.socketId),
    ['sock-1'],
    'the old socket is closed on RECONNECT',
  );
  assert.equal(client.connected(), false);

  await scheduler.fire(); // the backoff reconnect timer
  await flush();
  assert.equal(calls.connects.length, 2, 'a second socket is opened');
  assert.equal(
    calls.connects[1].url,
    'wss://resume.discord.gg/?v=10&encoding=json',
    'reconnect targets the resume gateway url',
  );

  // HELLO on the resumed socket triggers RESUME (op 6), not a fresh IDENTIFY.
  calls.emitSocket('sock-2', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  await flush();
  const resume = calls.sends.map((s) => JSON.parse(s.data)).find((f) => f.op === 6);
  assert.ok(resume, 'a RESUME (op 6) frame was sent after reconnect');
  assert.equal(resume.d.session_id, 'sess-1');
});

test('a missed heartbeat ACK reconnects the zombied socket', async () => {
  const { sdk, calls } = createFakeSdk();
  const scheduler = new ManualScheduler();
  const client = createDiscordClient({
    sdk,
    token: 'tok',
    config: openConfig,
    route: async () => ({ status: 'unbound' }) as RouteOutcome,
    scheduler,
  });

  await client.connect();
  calls.emitSocket('sock-1', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  await flush();

  await scheduler.fire(); // first heartbeat: awaitingAck becomes true, no ACK arrives
  await scheduler.fire(); // second heartbeat: still un-ACKed -> zombie -> reconnect
  await flush();
  assert.deepEqual(
    calls.closes.map((c) => c.socketId),
    ['sock-1'],
    'the zombied socket is torn down',
  );
});

test('disconnect stops reconnecting and closes the socket', async () => {
  const { sdk, calls } = createFakeSdk();
  const scheduler = new ManualScheduler();
  const client = createDiscordClient({
    sdk,
    token: 'tok',
    config: openConfig,
    route: async () => ({ status: 'unbound' }) as RouteOutcome,
    scheduler,
  });

  await client.connect();
  calls.emitSocket('sock-1', {
    type: 'message',
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }),
  });
  calls.emitSocket('sock-1', { type: 'message', data: readyFrame(1, 'bot-1') });
  await flush();

  client.disconnect();
  assert.equal(client.connected(), false);
  assert.ok(
    calls.closes.some((c) => c.socketId === 'sock-1'),
    'disconnect closes the live socket',
  );

  // A late close event must not trigger a reconnect after an explicit disconnect.
  calls.emitSocket('sock-1', { type: 'close', code: 1000 });
  await flush();
  assert.equal(calls.connects.length, 1, 'no reconnect after disconnect');
});
