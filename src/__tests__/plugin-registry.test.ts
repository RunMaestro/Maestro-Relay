import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationKey,
  getBinding,
  getSecret,
  loadBindings,
  loadConfig,
  removeBinding,
  setBinding,
  setSecret,
} from '../plugin/registry';
import { createFakeSdk } from './plugin-helpers';

/**
 * The storage-backed registry replaces the Node service's SQLite tables and
 * `.env`: channel->agent bindings and bot tokens live in the plugin's private KV;
 * non-secret config is read (never written) from plugin settings.
 */

test('binds a conversation to an agent and reads it back', async () => {
  const { sdk } = createFakeSdk();
  const key = conversationKey('discord', 'chan-1');
  assert.equal(key, 'discord:chan-1');
  assert.equal(await getBinding(sdk, key), undefined);
  await setBinding(sdk, key, 'agent-42');
  assert.equal(await getBinding(sdk, key), 'agent-42');
  assert.deepEqual(await loadBindings(sdk), { 'discord:chan-1': 'agent-42' });
});

test('removeBinding reports whether a binding existed', async () => {
  const { sdk } = createFakeSdk();
  const key = conversationKey('slack', 'C123');
  assert.equal(await removeBinding(sdk, key), false);
  await setBinding(sdk, key, 'agent-1');
  assert.equal(await removeBinding(sdk, key), true);
  assert.equal(await getBinding(sdk, key), undefined);
});

test('stores secrets under a namespace distinct from the bindings blob', async () => {
  const { sdk, calls } = createFakeSdk();
  assert.equal(await getSecret(sdk, 'discordBotToken'), undefined);
  await setSecret(sdk, 'discordBotToken', 'the-token');
  assert.equal(await getSecret(sdk, 'discordBotToken'), 'the-token');
  await setBinding(sdk, conversationKey('discord', 'c'), 'a1');
  assert.ok(
    [...calls.storage.keys()].some((k) => k.includes('secret')),
    'the secret is stored under its own key',
  );
});

test('loadConfig parses csv lists and applies defaults for missing keys', async () => {
  const { sdk } = createFakeSdk({
    settings: {
      enabledProviders: 'discord, slack ',
      discordAllowedUserIds: 'u1,u2, u3',
    },
  });
  const cfg = await loadConfig(sdk);
  assert.deepEqual(cfg.enabledProviders, ['discord', 'slack']);
  assert.equal(cfg.logLevel, 'info', 'missing logLevel falls back to the default');
  assert.deepEqual(cfg.discord.allowedUserIds, ['u1', 'u2', 'u3']);
  assert.equal(cfg.slack.teamId, '');
});

test('loadConfig reads a value stored under the namespaced setting key', async () => {
  const { sdk } = createFakeSdk({
    pluginId: 'sh.maestro.relay',
    settings: { 'plugins.sh.maestro.relay.slackAppId': 'A999' },
  });
  const cfg = await loadConfig(sdk);
  assert.equal(cfg.slack.appId, 'A999');
});

test('loadConfig defaults enabledProviders to discord+slack', async () => {
  const { sdk } = createFakeSdk();
  const cfg = await loadConfig(sdk);
  assert.deepEqual(cfg.enabledProviders, ['discord', 'slack']);
});
