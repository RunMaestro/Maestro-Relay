import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vm from 'node:vm';
import { bundlePlugin, findSandboxViolations } from '../plugin/build';
import { createFakeSdk } from './plugin-helpers';

/**
 * Proves the esbuild output is loadable in the real plugin sandbox model:
 *   1. static scan — the bundle contains no `require`, `process`, `Buffer`, etc.;
 *   2. dynamic load — evaluating it in a bare `vm` realm that exposes ONLY the
 *      sandbox globals (no require/process/Buffer) yields `activate`/`deactivate`,
 *      and `activate(sdk)` registers the four contributed commands, subscribes to
 *      `agent.completed`, and toasts — all through the brokered SDK.
 */

interface PluginModule {
  activate?: (sdk: unknown) => Promise<void> | void;
  deactivate?: () => void;
}

test('the bundled entry.js contains nothing the sandbox forbids', async () => {
  const { code } = await bundlePlugin();
  assert.deepEqual(findSandboxViolations(code), [], 'bundle is sandbox-safe');
});

test('the bundle loads and activates in a bare sandbox realm', async () => {
  const { code } = await bundlePlugin();
  const moduleShim: { exports: PluginModule } = { exports: {} };

  // Mirror the real Maestro sandbox: expose only maestro/module/exports/console/
  // timers/Promise. Deliberately NO require, process, Buffer, or Node builtins —
  // if the bundle touched one, runInContext would throw a ReferenceError here.
  const context = vm.createContext({
    module: moduleShim,
    exports: moduleShim.exports,
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Promise,
  });
  vm.runInContext(code, context, { filename: 'plugin/entry.js' });

  const mod = moduleShim.exports;
  assert.equal(typeof mod.activate, 'function', 'exports an activate()');
  assert.equal(typeof mod.deactivate, 'function', 'exports a deactivate()');

  const { sdk, calls } = createFakeSdk({ settings: { enabledProviders: 'discord,slack' } });
  await mod.activate!(sdk);

  assert.deepEqual(
    [...calls.commands.keys()].sort(),
    ['relay-reload-config', 'relay-start', 'relay-status', 'relay-stop'],
    'registers all four contributed commands',
  );
  assert.ok(
    calls.subscriptions.some((topics) => topics.includes('agent.completed')),
    'subscribes to agent.completed for reply completion',
  );
  assert.ok(calls.toasts.length >= 1, 'toasts once on load');

  // A registered command handler runs inside the realm and reaches the SDK.
  const statusHandler = calls.commands.get('relay-status');
  assert.equal(typeof statusHandler, 'function');
  const result = await statusHandler!();
  assert.match(String(result), /Relay/);

  mod.deactivate!();
});
