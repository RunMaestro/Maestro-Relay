import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlackClient } from '../plugin/providers/slack';
import type { InboundMessage, ReplySink, RouteOutcome } from '../plugin/entry';
import type { SlackConfig } from '../plugin/registry';
import type { ReplyResult } from '../plugin/reply';
import { ManualScheduler, createFakeSdk, flush } from './plugin-helpers';

/**
 * The Slack Socket Mode client reimplements the slice of the protocol Relay
 * needs — open a socket via `apps.connections.open`, receive `events_api`
 * envelopes, ack them, route messages, and post replies via `chat.postMessage`
 * — directly over the brokered SDK, with no `@slack/bolt`. These tests drive the
 * protocol over a fake socket + fake `net.fetch`, deterministically.
 */

const openConfig: SlackConfig = { teamId: '', appId: '', allowedUserIds: [] };

/** A canned agent reply the fake router hands to the sink. */
const REPLY: ReplyResult = { sessionId: 'S', text: 'pong', chunks: ['pong'], reason: 'event' };

const WSS = 'wss://wss-primary.slack.com/link/?ticket=t1';
const HELLO = JSON.stringify({ type: 'hello' });

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Fake `net.fetch`: `apps.connections.open` yields the wss url; anything else ok. */
function slackFetch(url: string): unknown {
  const body = url.endsWith('/apps.connections.open')
    ? JSON.stringify({ ok: true, url: WSS })
    : JSON.stringify({ ok: true });
  return { status: 200, statusText: 'OK', headers: {}, body };
}

function envelope(
  envelopeId: string,
  event: Record<string, unknown>,
  payloadExtra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    envelope_id: envelopeId,
    type: 'events_api',
    payload: { team_id: 'T1', event, ...payloadExtra },
  });
}

function frame(data: string): { type: 'message'; data: string } {
  return { type: 'message', data };
}

test('opens the socket via apps.connections.open and connects to the returned wss url', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const client = createSlackClient({
    sdk,
    appToken: 'xapp-1',
    botToken: 'xoxb-1',
    config: openConfig,
    route: async () => ({ status: 'unbound' }) as RouteOutcome,
    scheduler,
  });

  await client.connect();
  await flush();

  const open = calls.fetches.find((f) => f.url.endsWith('/apps.connections.open'));
  assert.ok(open, 'apps.connections.open was called');
  const init = open.init as FetchInit;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer xapp-1');
  assert.equal(calls.connects.length, 1, 'one socket opened');
  assert.equal(calls.connects[0].url, WSS);
  assert.equal(client.connected(), false, 'not connected until hello');

  calls.emitSocket('sock-1', frame(HELLO));
  await flush();
  assert.equal(client.connected(), true, 'hello marks the client connected');
});

test('acks an events_api envelope before routing and posts a threaded reply', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const routed: InboundMessage[] = [];
  // Gate the reply post so we can observe the ack while the agent turn is still
  // "in flight": the ack must fire immediately, never waiting on the turn.
  let releaseTurn: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const route = async (m: InboundMessage, sink: ReplySink): Promise<RouteOutcome> => {
    routed.push(m);
    await turn;
    await sink(m, REPLY);
    return { status: 'dispatched', agentId: 'agent-1', reply: REPLY };
  };
  const client = createSlackClient({
    sdk,
    appToken: 'xapp-1',
    botToken: 'xoxb-1',
    config: openConfig,
    route,
    scheduler,
  });

  await client.connect();
  await flush();
  calls.emitSocket('sock-1', frame(HELLO));
  await flush();

  calls.emitSocket(
    'sock-1',
    frame(envelope('env-1', { type: 'message', channel: 'C1', user: 'U1', text: 'ping', ts: '123.456' })),
  );
  await flush();

  // The ack is sent and the turn dispatched, but the reply is still gated —
  // proving the ack does not wait on the (potentially long) agent turn.
  assert.deepEqual(
    calls.sends.map((s) => JSON.parse(s.data)),
    [{ envelope_id: 'env-1' }],
    'ack sent immediately',
  );
  assert.equal(routed.length, 1, 'the turn was dispatched');
  assert.equal(
    calls.fetches.filter((f) => f.url.endsWith('/chat.postMessage')).length,
    0,
    'reply not posted while the turn is in flight',
  );

  releaseTurn();
  await flush();

  assert.deepEqual(
    routed.map((m) => ({ provider: m.provider, channelId: m.channelId, userId: m.userId, text: m.text })),
    [{ provider: 'slack', channelId: 'C1', userId: 'U1', text: 'ping' }],
  );
  const post = calls.fetches.find((f) => f.url.endsWith('/chat.postMessage'));
  assert.ok(post, 'chat.postMessage was called');
  assert.equal(post.url, 'https://slack.com/api/chat.postMessage');
  const init = post.init as FetchInit;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer xoxb-1');
  // No thread_ts on the inbound message → the reply threads under the message ts.
  assert.deepEqual(JSON.parse(init.body ?? '{}'), { channel: 'C1', text: 'pong', thread_ts: '123.456' });
});

test('replies inside an existing thread when the message carries thread_ts', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const route = async (m: InboundMessage, sink: ReplySink): Promise<RouteOutcome> => {
    await sink(m, REPLY);
    return { status: 'dispatched', agentId: 'a', reply: REPLY };
  };
  const client = createSlackClient({ sdk, appToken: 'xapp-1', botToken: 'xoxb-1', config: openConfig, route, scheduler });

  await client.connect();
  await flush();
  calls.emitSocket('sock-1', frame(HELLO));
  calls.emitSocket(
    'sock-1',
    frame(
      envelope('env-2', { type: 'message', channel: 'C1', user: 'U1', text: 'more', ts: '200.0', thread_ts: '100.0' }),
    ),
  );
  await flush();

  const post = calls.fetches.find((f) => f.url.endsWith('/chat.postMessage'));
  assert.ok(post);
  assert.equal(JSON.parse((post.init as FetchInit).body ?? '{}').thread_ts, '100.0');
});

test('honors team scope and allowed-user filters', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const routed: InboundMessage[] = [];
  const client = createSlackClient({
    sdk,
    appToken: 'xapp-1',
    botToken: 'xoxb-1',
    config: { teamId: 'T1', appId: '', allowedUserIds: ['U-allowed'] },
    route: async (m) => {
      routed.push(m);
      return { status: 'dispatched', agentId: 'a', reply: REPLY } as RouteOutcome;
    },
    scheduler,
  });

  await client.connect();
  await flush();
  calls.emitSocket('sock-1', frame(HELLO));

  // Wrong workspace → dropped.
  calls.emitSocket(
    'sock-1',
    frame(envelope('e1', { type: 'message', channel: 'C1', user: 'U-allowed', text: 'a', ts: '1.1' }, { team_id: 'T-other' })),
  );
  // Right workspace, disallowed user → dropped.
  calls.emitSocket(
    'sock-1',
    frame(envelope('e2', { type: 'message', channel: 'C1', user: 'U-nope', text: 'b', ts: '2.2' })),
  );
  // Right workspace, allowed user → routed.
  calls.emitSocket(
    'sock-1',
    frame(envelope('e3', { type: 'message', channel: 'C1', user: 'U-allowed', text: 'c', ts: '3.3' })),
  );
  await flush();

  assert.deepEqual(
    routed.map((m) => m.text),
    ['c'],
    'only the allowed user in the pinned workspace routes',
  );
  // Every envelope is still acked, even the filtered ones.
  assert.deepEqual(
    calls.sends.map((s) => JSON.parse(s.data).envelope_id),
    ['e1', 'e2', 'e3'],
  );
});

test('ignores bot messages and edit/system subtypes', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const routed: InboundMessage[] = [];
  const client = createSlackClient({
    sdk,
    appToken: 'xapp-1',
    botToken: 'xoxb-1',
    config: openConfig,
    route: async (m) => {
      routed.push(m);
      return { status: 'unbound' } as RouteOutcome;
    },
    scheduler,
  });

  await client.connect();
  await flush();
  calls.emitSocket('sock-1', frame(HELLO));

  // A message from a bot (our own reply echo) carries bot_id → dropped.
  calls.emitSocket(
    'sock-1',
    frame(envelope('e1', { type: 'message', channel: 'C1', user: 'U1', text: 'echo', ts: '1.1', bot_id: 'B1' })),
  );
  // An edit event carries subtype message_changed → dropped.
  calls.emitSocket(
    'sock-1',
    frame(envelope('e2', { type: 'message', channel: 'C1', user: 'U1', text: 'edited', ts: '2.2', subtype: 'message_changed' })),
  );
  // A file_share subtype is a genuine user message → routed.
  calls.emitSocket(
    'sock-1',
    frame(envelope('e3', { type: 'message', channel: 'C1', user: 'U1', text: 'shared', ts: '3.3', subtype: 'file_share' })),
  );
  await flush();

  assert.deepEqual(routed.map((m) => m.text), ['shared']);
});

test('routes an app_mention and dedupes the twin message event', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const routed: InboundMessage[] = [];
  const client = createSlackClient({
    sdk,
    appToken: 'xapp-1',
    botToken: 'xoxb-1',
    config: openConfig,
    route: async (m) => {
      routed.push(m);
      return { status: 'unbound' } as RouteOutcome;
    },
    scheduler,
  });

  await client.connect();
  await flush();
  calls.emitSocket('sock-1', frame(HELLO));

  // The same @-mention arrives as both an app_mention and a message event
  // (identical ts). Only one routes; the bot mention token is stripped.
  calls.emitSocket(
    'sock-1',
    frame(envelope('e1', { type: 'app_mention', channel: 'C1', user: 'U1', text: '<@BOT> deploy', ts: '9.9' })),
  );
  calls.emitSocket(
    'sock-1',
    frame(envelope('e2', { type: 'message', channel: 'C1', user: 'U1', text: '<@BOT> deploy', ts: '9.9' })),
  );
  await flush();

  assert.deepEqual(routed.map((m) => m.text), ['deploy'], 'mention token stripped, routed once');
  assert.deepEqual(
    calls.sends.map((s) => JSON.parse(s.data).envelope_id),
    ['e1', 'e2'],
    'both envelopes acked even though only one routes',
  );
});

test('splits a reply longer than the Slack limit into multiple posts', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const long = 'x'.repeat(9000);
  const longReply: ReplyResult = { sessionId: 'S', text: long, chunks: [long], reason: 'event' };
  const route = async (m: InboundMessage, sink: ReplySink): Promise<RouteOutcome> => {
    await sink(m, longReply);
    return { status: 'dispatched', agentId: 'a', reply: longReply };
  };
  const client = createSlackClient({ sdk, appToken: 'xapp-1', botToken: 'xoxb-1', config: openConfig, route, scheduler });

  await client.connect();
  await flush();
  calls.emitSocket('sock-1', frame(HELLO));
  calls.emitSocket(
    'sock-1',
    frame(envelope('e1', { type: 'message', channel: 'C1', user: 'U1', text: 'go', ts: '1.1' })),
  );
  await flush();

  const posts = calls.fetches.filter((f) => f.url.endsWith('/chat.postMessage'));
  assert.ok(posts.length >= 2, 'a >limit reply is split into multiple posts');
  for (const p of posts) {
    const body = JSON.parse((p.init as FetchInit).body ?? '{}');
    assert.ok(body.text.length <= 3900, 'each chunk is within the Slack limit');
  }
});

test('a disconnect frame closes the socket and reopens a fresh one', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const client = createSlackClient({
    sdk,
    appToken: 'xapp-1',
    botToken: 'xoxb-1',
    config: openConfig,
    route: async () => ({ status: 'unbound' }) as RouteOutcome,
    scheduler,
  });

  await client.connect();
  await flush();
  calls.emitSocket('sock-1', frame(HELLO));
  await flush();
  assert.equal(client.connected(), true);

  calls.emitSocket('sock-1', frame(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' })));
  await flush();
  assert.equal(client.connected(), false, 'disconnect drops the connection');
  assert.equal(calls.closes.length, 1, 'the old socket is closed');
  assert.ok(scheduler.pendingCount >= 1, 'a reconnect is scheduled');

  await scheduler.fire();
  await flush();
  assert.equal(
    calls.fetches.filter((f) => f.url.endsWith('/apps.connections.open')).length,
    2,
    'reconnect re-opens a fresh Socket Mode connection',
  );
  assert.equal(calls.connects.length, 2, 'a second socket is opened');
});

test('disconnect() stops reconnecting and closes the socket', async () => {
  const { sdk, calls } = createFakeSdk({ fetch: slackFetch });
  const scheduler = new ManualScheduler();
  const client = createSlackClient({
    sdk,
    appToken: 'xapp-1',
    botToken: 'xoxb-1',
    config: openConfig,
    route: async () => ({ status: 'unbound' }) as RouteOutcome,
    scheduler,
  });

  await client.connect();
  await flush();
  calls.emitSocket('sock-1', frame(HELLO));
  await flush();

  client.disconnect();
  assert.equal(client.connected(), false);
  assert.equal(calls.closes.length, 1, 'the socket is closed on disconnect');

  // A late socket error must not trigger a reconnect after disconnect().
  const connectsBefore = calls.connects.length;
  calls.emitSocket('sock-1', { type: 'error', message: 'boom' });
  await flush();
  assert.equal(scheduler.pendingCount, 0, 'no reconnect scheduled after disconnect');
  assert.equal(calls.connects.length, connectsBefore, 'no new socket opened');
});
