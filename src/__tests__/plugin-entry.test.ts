import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, type InboundMessage } from '../plugin/entry';
import type { RelayConfig } from '../plugin/registry';
import { conversationKey, getBinding, getSecret, setBinding } from '../plugin/registry';
import { ManualScheduler, createFakeSdk, flush } from './plugin-helpers';
import { addParticipant, getRoom, listRooms } from '../plugin/rooms';

/**
 * The runtime ties config + bindings + the reply loop together: an inbound chat
 * message routes to the bound agent, and the completed reply is handed to the
 * provider's sink. Commands drive the lifecycle. Time is manual.
 */

const baseConfig: RelayConfig = {
  enabledProviders: ['discord', 'slack'],
  logLevel: 'info',
  discord: { clientId: '', guildId: '', allowedUserIds: [] },
  slack: { teamId: '', appId: '', allowedUserIds: [] },
};

test('routeInbound dispatches to the bound agent and posts the reply via the sink', async () => {
  const { sdk, calls } = createFakeSdk({
    dispatchSessionId: 'S1',
    read: () => [{ id: 'e1', timestamp: 1, fullResponse: 'pong' }],
  });
  await setBinding(sdk, conversationKey('discord', 'chan-1'), 'agent-9');
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  const posted: Array<{ channelId: string; text: string }> = [];
  const msg: InboundMessage = {
    provider: 'discord',
    channelId: 'chan-1',
    userId: 'u1',
    text: 'ping',
  };
  const routed = runtime.routeInbound(msg, (m, reply) => {
    posted.push({ channelId: m.channelId, text: reply.text });
  });

  await flush();
  assert.deepEqual(calls.dispatched, [{ agentId: 'agent-9', prompt: 'ping' }]);
  assert.equal(runtime.status().activeReplies, 1, 'the in-flight reply is tracked');

  runtime.onAgentCompleted({ sessionId: 'S1', status: 'completed' });
  const outcome = await routed;
  assert.equal(outcome.status, 'dispatched');
  assert.equal(outcome.agentId, 'agent-9');
  assert.deepEqual(posted, [{ channelId: 'chan-1', text: 'pong' }]);
  assert.equal(runtime.status().activeReplies, 0, 'the handle is cleared after the reply');
});

test('routeInbound returns unbound when no agent is bound to the channel', async () => {
  const { sdk, calls } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());
  const outcome = await runtime.routeInbound(
    { provider: 'slack', channelId: 'C1', userId: 'u', text: 'hi' },
    () => assert.fail('sink must not be called when unbound'),
  );
  assert.equal(outcome.status, 'unbound');
  assert.deepEqual(calls.dispatched, [], 'nothing is dispatched for an unbound channel');
});

test('routeInbound ignores whitespace-only messages', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());
  const outcome = await runtime.routeInbound(
    { provider: 'discord', channelId: 'c', userId: 'u', text: '   ' },
    () => assert.fail('sink must not be called for empty text'),
  );
  assert.equal(outcome.status, 'empty');
});

test('handleCommand start/status/stop transitions the running flag', async () => {
  const { sdk, calls } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());
  assert.equal(runtime.status().running, false);
  await runtime.handleCommand('relay-start');
  assert.equal(runtime.status().running, true);
  const status = await runtime.handleCommand('relay-status');
  assert.match(status, /running/);
  await runtime.handleCommand('relay-stop');
  assert.equal(runtime.status().running, false);
  assert.ok(calls.toasts.length >= 2, 'start and stop each toast');
});

test('handleCommand rejects an unknown command', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());
  await assert.rejects(() => runtime.handleCommand('relay-nope'), /unknown relay command/);
});

test('relay-save-config persists namespaced settings + secrets and reloads config', async () => {
  const { sdk, calls } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  const message = await runtime.handleCommand('relay-save-config', {
    settings: { enabledProviders: 'discord', logLevel: 'debug', discordGuildId: 'g1' },
    // Blank/whitespace secrets are skipped so an empty field never clobbers a token.
    secrets: { discordToken: 'bot-token', slackAppToken: '   ' },
  });

  // Settings are written under the host-confined `plugins.<id>.*` namespace.
  assert.equal(await sdk.settings.get('plugins.sh.maestro.relay.enabledProviders'), 'discord');
  assert.equal(await sdk.settings.get('plugins.sh.maestro.relay.logLevel'), 'debug');
  assert.equal(await sdk.settings.get('plugins.sh.maestro.relay.discordGuildId'), 'g1');

  // reconnect() re-reads config from the freshly-saved settings.
  assert.deepEqual(runtime.config.enabledProviders, ['discord']);
  assert.equal(runtime.config.logLevel, 'debug');
  assert.equal(runtime.config.discord.guildId, 'g1');

  // Non-blank secret stored; whitespace-only secret ignored.
  assert.equal(await getSecret(sdk, 'discordToken'), 'bot-token');
  assert.equal(await getSecret(sdk, 'slackAppToken'), undefined);

  assert.match(message, /configuration saved/i);
  assert.ok(calls.toasts.some((t) => /configuration saved/i.test(t)), 'the save is toasted');
});

test('relay-save-config with empty enabledProviders disables every provider', async () => {
  const { sdk } = createFakeSdk({ settings: { enabledProviders: 'discord,slack' } });
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  await runtime.handleCommand('relay-save-config', { settings: { enabledProviders: '' }, secrets: {} });

  assert.deepEqual(runtime.config.enabledProviders, [], 'a saved empty string wins over the default');
});

test('relay-bind then relay-unbind manage a channel binding', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  const bound = await runtime.handleCommand('relay-bind', {
    provider: 'discord',
    channelId: 'c9',
    agentId: 'agent-7',
  });
  assert.match(bound, /Bound discord:c9/);
  assert.equal(await getBinding(sdk, conversationKey('discord', 'c9')), 'agent-7');

  const unbound = await runtime.handleCommand('relay-unbind', { provider: 'discord', channelId: 'c9' });
  assert.match(unbound, /Unbound discord:c9/);
  assert.equal(await getBinding(sdk, conversationKey('discord', 'c9')), undefined);

  const missing = await runtime.handleCommand('relay-unbind', { provider: 'discord', channelId: 'c9' });
  assert.match(missing, /No binding found/);
});

test('relay-bind rejects incomplete args without writing a binding', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  const res = await runtime.handleCommand('relay-bind', { provider: 'discord', channelId: '', agentId: 'a' });
  assert.match(res, /bind failed/i);
  assert.equal(await getBinding(sdk, conversationKey('discord', '')), undefined);
});

test('replaceProviders disconnects the old clients and connects new ones when running', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());
  const events: string[] = [];
  const makeClient = (name: string) => ({
    name,
    connect: async () => {
      events.push(`connect:${name}`);
    },
    disconnect: () => {
      events.push(`disconnect:${name}`);
    },
    connected: () => false,
  });

  runtime.registerProvider(makeClient('old'));
  runtime.start();
  await flush();
  runtime.replaceProviders([makeClient('new')]);
  await flush();

  assert.deepEqual(events, ['connect:old', 'disconnect:old', 'connect:new']);
});

test('registerBackgroundService registers a supervised service; unregister clears it', async () => {
  const { sdk, calls } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());
  assert.equal(runtime.status().supervised, false);

  await runtime.registerBackgroundService();
  assert.deepEqual(calls.backgroundRegistrations, [{ id: 'relay-bridge', name: 'Maestro Relay bridge' }]);
  assert.equal(runtime.status().supervised, true, 'status reports the child is supervised');

  // Idempotent: a second call while registered does not double-register.
  await runtime.registerBackgroundService();
  assert.equal(calls.backgroundRegistrations.length, 1);

  await runtime.unregisterBackgroundService();
  assert.deepEqual(calls.backgroundUnregisters, ['relay-bridge']);
  assert.equal(runtime.status().supervised, false);
});

test('onAgentStatusChanged records per-agent status surfaced by relay-status', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  runtime.onAgentStatusChanged({ agentId: 'agent-3', status: 'thinking' });
  assert.deepEqual(runtime.status().agentStatuses, [{ agentId: 'agent-3', status: 'thinking' }]);

  // Newest status wins for the same agent.
  runtime.onAgentStatusChanged({ agentId: 'agent-3', status: 'idle' });
  assert.deepEqual(runtime.status().agentStatuses, [{ agentId: 'agent-3', status: 'idle' }]);

  const line = await runtime.handleCommand('relay-status');
  assert.match(line, /agent-3=idle/);
});

test('onAgentStatusChanged ignores payloads missing agentId or status', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  runtime.onAgentStatusChanged({ status: 'thinking' });
  runtime.onAgentStatusChanged({ agentId: 'agent-3' });
  runtime.onAgentStatusChanged(null);
  assert.deepEqual(runtime.status().agentStatuses, []);
});

test('onAgentError toasts and records an error status for the agent', async () => {
  const { sdk, calls } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  runtime.onAgentError({ agentId: 'agent-4', errorType: 'rate_limit', recoverable: true });
  await flush();

  assert.deepEqual(runtime.status().agentStatuses, [{ agentId: 'agent-4', status: 'error:rate_limit' }]);
  assert.ok(
    calls.toasts.some((t) => /agent-4.*error.*rate_limit.*recoverable=yes/i.test(t)),
    'the error is surfaced as a toast',
  );
});

test('onAgentCompleted records the terminal status for its agent', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  runtime.onAgentCompleted({ sessionId: 'S1', agentId: 'agent-5', status: 'failed' });
  assert.deepEqual(runtime.status().agentStatuses, [{ agentId: 'agent-5', status: 'failed' }]);
});

test('routeInbound routes a room channel through the bus and posts masked personas via postAs', async () => {
  const { sdk, calls } = createFakeSdk({
    dispatchSessionId: 'S1',
    read: () => [{ id: 'e1', timestamp: 1, fullResponse: 'Hi, I am Ada' }],
  });
  await addParticipant(sdk, 'discord', 'room-1', 'agent-a', 'Ada');
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  const posts: Array<{ channelId: string; handle: string; text: string }> = [];
  runtime.registerProvider({
    name: 'discord',
    connect: async () => {},
    disconnect: () => {},
    connected: () => true,
    postAs: async (channelId, handle, text) => {
      posts.push({ channelId, handle, text });
    },
  });

  const routed = runtime.routeInbound(
    { provider: 'discord', channelId: 'room-1', userId: 'u1', text: '@Ada hello' },
    () => {},
  );
  await flush(40);
  assert.equal(runtime.status().activeReplies, 1, 'the room turn is tracked as an in-flight reply');

  runtime.onAgentCompleted({ sessionId: 'S1', status: 'completed' });
  const outcome = await routed;

  assert.equal(outcome.status, 'room');
  assert.equal(outcome.room?.status, 'drained');
  assert.equal(outcome.room?.targets, 1);
  assert.deepEqual(calls.dispatched.map((d) => d.agentId), ['agent-a']);
  assert.match(calls.dispatched[0].prompt, /You are @Ada in room/, 'the persona gets the room preamble');
  assert.match(calls.dispatched[0].prompt, /\[human\]: @Ada hello/, 'and the human utterance');
  assert.deepEqual(posts, [{ channelId: 'room-1', handle: 'Ada', text: 'Hi, I am Ada' }]);
  assert.equal(runtime.status().activeReplies, 0, 'the room handle is cleared after the turn');
});

test('routeInbound prefers the room bus over a 1:1 binding for a room channel', async () => {
  const { sdk, calls } = createFakeSdk({ dispatchSessionId: 'S1', read: () => [] });
  await addParticipant(sdk, 'discord', 'room-2', 'agent-a', 'Ada');
  // A stray 1:1 binding on the same channel must not fire once it is a room.
  await setBinding(sdk, conversationKey('discord', 'room-2'), 'agent-legacy');
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  // No @mention → the room has no target, so nothing dispatches at all.
  const outcome = await runtime.routeInbound(
    { provider: 'discord', channelId: 'room-2', userId: 'u1', text: 'just chatting' },
    () => {},
  );
  assert.equal(outcome.status, 'room');
  assert.equal(outcome.room?.status, 'no-target');
  assert.deepEqual(calls.dispatched, [], 'the legacy binding never dispatched');
});

test('room commands create, add personas, list, pause, remove, and delete', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());

  await runtime.handleCommand('relay-room-create', { provider: 'slack', channelId: 'C9', name: 'Standup' });
  let room = await getRoom(sdk, 'slack', 'C9');
  assert.ok(room, 'the room was created');
  assert.equal(room?.name, 'Standup');

  await runtime.handleCommand('relay-room-add', { provider: 'slack', channelId: 'C9', agentId: 'agent-a', displayName: 'Ada' });
  await runtime.handleCommand('relay-room-add', { provider: 'slack', channelId: 'C9', agentId: 'agent-b', displayName: 'Bob' });
  room = await getRoom(sdk, 'slack', 'C9');
  assert.deepEqual(room?.participants.map((p) => p.handle), ['Ada', 'Bob']);

  const listing = await runtime.handleCommand('relay-room-list');
  assert.match(listing, /slack:C9/);
  assert.match(listing, /@Ada/);
  assert.match(listing, /@Bob/);
  assert.match(listing, /\[active\]/);

  await runtime.handleCommand('relay-room-pause', { provider: 'slack', channelId: 'C9' });
  assert.equal((await getRoom(sdk, 'slack', 'C9'))?.status, 'paused');
  await runtime.handleCommand('relay-room-resume', { provider: 'slack', channelId: 'C9' });
  assert.equal((await getRoom(sdk, 'slack', 'C9'))?.status, 'active');

  const removed = await runtime.handleCommand('relay-room-remove', { provider: 'slack', channelId: 'C9', target: 'Ada' });
  assert.match(removed, /Removed/);
  assert.deepEqual((await getRoom(sdk, 'slack', 'C9'))?.participants.map((p) => p.handle), ['Bob']);

  const deleted = await runtime.handleCommand('relay-room-delete', { provider: 'slack', channelId: 'C9' });
  assert.match(deleted, /deleted/);
  assert.equal(await getRoom(sdk, 'slack', 'C9'), undefined);
});

test('relay-room-list reports when no rooms are configured', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());
  assert.equal(await runtime.handleCommand('relay-room-list'), 'No rooms configured.');
});

test('relay-room-add rejects missing args without mutating the registry', async () => {
  const { sdk } = createFakeSdk();
  const runtime = createRuntime(sdk, baseConfig, new ManualScheduler());
  const message = await runtime.handleCommand('relay-room-add', { provider: 'discord' });
  assert.match(message, /failed/);
  assert.deepEqual(await listRooms(sdk), [], 'no room was created by the rejected add');
});
