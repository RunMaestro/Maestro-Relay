import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDispatchPermission,
  DISPATCH_REASON,
  injectAgentsDispatch,
  parseAgentIds,
} from '../plugin/packaging';

/**
 * The distributable manifest ships WITHOUT agents:dispatch; the operator's exact
 * agent ids are injected on a staged copy before signing (see pack-plugin.ts).
 * These are the pure pieces of that step: id validation must mirror Maestro's
 * allowlist rule (exact ids, no wildcard/whitespace) or the re-signed plugin
 * fails the host's parsePermissions at install and can never route messages.
 */

test('parseAgentIds trims, splits, and drops empty members', () => {
  assert.deepEqual(parseAgentIds(' a1 , a2,a3 '), ['a1', 'a2', 'a3']);
  assert.deepEqual(parseAgentIds('a1,,a2,'), ['a1', 'a2']);
});

test('parseAgentIds rejects an empty list', () => {
  assert.throws(() => parseAgentIds(''), /no agent ids/);
  assert.throws(() => parseAgentIds('  , ,'), /no agent ids/);
});

test('parseAgentIds rejects wildcards and interior whitespace (host allowlist rule)', () => {
  assert.throws(() => parseAgentIds('*'), /forbidden characters/);
  assert.throws(() => parseAgentIds('a1,ag *'), /forbidden characters/);
  assert.throws(() => parseAgentIds('good,bad id'), /forbidden characters/);
});

test('buildDispatchPermission joins ids into a comma-separated scope', () => {
  assert.deepEqual(buildDispatchPermission(['x', 'y']), {
    capability: 'agents:dispatch',
    scope: 'x,y',
    reason: DISPATCH_REASON,
  });
});

test('injectAgentsDispatch appends the permission without mutating the source', () => {
  const manifest = { id: 'sh.maestro.relay', permissions: [{ capability: 'net:connect' }] };
  const out = injectAgentsDispatch(manifest, ['a1', 'a2']);
  // source untouched
  assert.equal(manifest.permissions.length, 1);
  // clone carries the original plus the dispatch entry
  assert.deepEqual(out.permissions, [
    { capability: 'net:connect' },
    { capability: 'agents:dispatch', scope: 'a1,a2', reason: DISPATCH_REASON },
  ]);
});

test('injectAgentsDispatch replaces a pre-existing dispatch entry (idempotent)', () => {
  const manifest = {
    permissions: [
      { capability: 'net:connect' },
      { capability: 'agents:dispatch', scope: 'old', reason: 'stale' },
    ],
  };
  const out = injectAgentsDispatch(manifest, ['new1', 'new2']);
  const perms = out.permissions;
  assert.ok(Array.isArray(perms));
  const dispatch = perms.filter(
    (p) => typeof p === 'object' && p !== null && 'capability' in p && p.capability === 'agents:dispatch',
  );
  assert.equal(dispatch.length, 1, 'exactly one agents:dispatch entry survives');
  assert.deepEqual(dispatch[0], {
    capability: 'agents:dispatch',
    scope: 'new1,new2',
    reason: DISPATCH_REASON,
  });
});

test('injectAgentsDispatch tolerates a manifest with no permissions array', () => {
  const out = injectAgentsDispatch({ id: 'x' }, ['a1']);
  assert.deepEqual(out.permissions, [
    { capability: 'agents:dispatch', scope: 'a1', reason: DISPATCH_REASON },
  ]);
});
