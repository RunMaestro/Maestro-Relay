import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredTier,
  isAuthorized,
  configWarning,
  configError,
  type AccessLists,
} from '../providers/discord/access';

const NOBODY: AccessLists = { admins: [], viewers: [] };
const lists = (admins: string[], viewers: string[] = []): AccessLists => ({ admins, viewers });

// --- tier classification ---

test('commands that make an agent execute something require admin', () => {
  assert.equal(requiredTier('playbook', 'run'), 'admin');
  assert.equal(requiredTier('auto-run', 'start'), 'admin');
});

test('commands that change relay state require admin', () => {
  assert.equal(requiredTier('agents', 'new'), 'admin');
  assert.equal(requiredTier('agents', 'disconnect'), 'admin');
  assert.equal(requiredTier('agents', 'readonly'), 'admin');
});

test('publishing a transcript outward requires admin', () => {
  assert.equal(requiredTier('gist', null), 'admin');
});

test('read-only commands are open to viewers', () => {
  assert.equal(requiredTier('health', null), 'viewer');
  assert.equal(requiredTier('agents', 'list'), 'viewer');
  assert.equal(requiredTier('playbook', 'list'), 'viewer');
  assert.equal(requiredTier('session', 'list'), 'viewer');
  assert.equal(requiredTier('notes', 'history'), 'viewer');
});

test('an unclassified command defaults to admin', () => {
  assert.equal(requiredTier('some-future-command', null), 'admin');
});

test('an unclassified subcommand of a known command defaults to admin', () => {
  // The case that matters: `/agents` is partly viewer-visible, so a new
  // subcommand must not inherit that.
  assert.equal(requiredTier('agents', 'grant'), 'admin');
  assert.equal(requiredTier('playbook', 'delete'), 'admin');
});

test('a bare command name does not match its own subcommand entries', () => {
  // `/agents` with no subcommand is not `/agents list`.
  assert.equal(requiredTier('agents', null), 'admin');
});

// --- authorization ---

test('an empty admin list leaves the bot open, as before', () => {
  assert.equal(isAuthorized('anyone', 'admin', NOBODY), true);
  assert.equal(isAuthorized('anyone', 'viewer', NOBODY), true);
});

// Regression: a viewer list with an empty admin list used to short-circuit to
// `true` for every user at every tier, so setting only DISCORD_VIEWER_USER_IDS
// left /playbook run open to the whole guild.
test('a viewer list with no admin list does not fall open to everyone', () => {
  const l = lists([], ['viewer-1']);
  assert.equal(isAuthorized('stranger', 'admin', l), false);
  assert.equal(isAuthorized('stranger', 'viewer', l), false);
  assert.equal(isAuthorized('viewer-1', 'admin', l), false);
  assert.equal(isAuthorized('viewer-1', 'viewer', l), true);
});

// Regression: /session new writes (thread create + registry row) and
// /notes synopsis runs an AI inference on the host; neither is viewer-tier.
test('writes and host inference are admin-tier even though they look read-only', () => {
  assert.equal(requiredTier('session', 'new'), 'admin');
  assert.equal(requiredTier('notes', 'synopsis'), 'admin');

  const l = lists(['admin-1'], ['viewer-1']);
  assert.equal(isAuthorized('viewer-1', requiredTier('session', 'new'), l), false);
  assert.equal(isAuthorized('viewer-1', requiredTier('notes', 'synopsis'), l), false);
});

test('an admin may run every tier', () => {
  const l = lists(['admin-1']);
  assert.equal(isAuthorized('admin-1', 'admin', l), true);
  assert.equal(isAuthorized('admin-1', 'viewer', l), true);
});

test('a stranger may run nothing once an admin list exists', () => {
  const l = lists(['admin-1'], ['viewer-1']);
  assert.equal(isAuthorized('stranger', 'admin', l), false);
  assert.equal(isAuthorized('stranger', 'viewer', l), false);
});

test('a viewer may run viewer commands but not admin ones', () => {
  const l = lists(['admin-1'], ['viewer-1']);
  assert.equal(isAuthorized('viewer-1', 'viewer', l), true);
  assert.equal(isAuthorized('viewer-1', 'admin', l), false);
});

test('an empty viewer list reproduces the previous single-list behavior', () => {
  const l = lists(['admin-1']);
  assert.equal(isAuthorized('admin-1', 'admin', l), true);
  assert.equal(isAuthorized('someone-else', 'viewer', l), false);
});

test('being in both lists grants admin', () => {
  const l = lists(['both'], ['both']);
  assert.equal(isAuthorized('both', 'admin', l), true);
});

// --- configuration coherence ---

test('a viewer list with no admin list is a fatal configuration', () => {
  const err = configError(lists([], ['viewer-1']));
  assert.ok(err);
  assert.ok(err.includes('DISCORD_ALLOWED_USER_IDS'));
});

test('coherent list combinations produce no configuration error', () => {
  assert.equal(configError(NOBODY), null);
  assert.equal(configError(lists(['admin-1'])), null);
  assert.equal(configError(lists(['admin-1'], ['viewer-1'])), null);
});

test('a user in both lists is reported', () => {
  const warning = configWarning(lists(['dup'], ['dup']));
  assert.ok(warning);
  assert.ok(warning.includes('dup'));
});

test('a coherent configuration produces no warning', () => {
  assert.equal(configWarning(lists(['admin-1'], ['viewer-1'])), null);
  assert.equal(configWarning(NOBODY), null);
  assert.equal(configWarning(lists(['admin-1'])), null);
  assert.equal(configWarning(lists([], ['viewer-1'])), null);
});

// --- environment wiring ---

test('DISCORD_VIEWER_USER_IDS parses as a comma-separated list', async () => {
  const prev = process.env.DISCORD_VIEWER_USER_IDS;
  process.env.DISCORD_VIEWER_USER_IDS = ' 111 , 222 ';
  try {
    const { discordConfig } = await import('../providers/discord/config');
    assert.deepEqual(discordConfig.viewerUserIds, ['111', '222']);
  } finally {
    if (prev === undefined) delete process.env.DISCORD_VIEWER_USER_IDS;
    else process.env.DISCORD_VIEWER_USER_IDS = prev;
  }
});

test('an unset DISCORD_VIEWER_USER_IDS yields an empty list', async () => {
  const prev = process.env.DISCORD_VIEWER_USER_IDS;
  delete process.env.DISCORD_VIEWER_USER_IDS;
  try {
    const { discordConfig } = await import('../providers/discord/config');
    assert.deepEqual(discordConfig.viewerUserIds, []);
  } finally {
    if (prev !== undefined) process.env.DISCORD_VIEWER_USER_IDS = prev;
  }
});
