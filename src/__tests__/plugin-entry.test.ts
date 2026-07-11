import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, type InboundMessage } from '../plugin/entry';
import type { RelayConfig } from '../plugin/registry';
import { conversationKey, getBinding, getSecret, setBinding } from '../plugin/registry';
import { ManualScheduler, createFakeSdk, flush } from './plugin-helpers';

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
