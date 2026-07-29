import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  ensureDiscordPushedMessagesTable,
  ensureOwnerUserIdColumn,
  runMigrations,
} from '../core/db/migrations';

test('ensureOwnerUserIdColumn adds owner_user_id and is safe to rerun', () => {
  const database = new Database(':memory:');

  database.exec(`
    CREATE TABLE discord_agent_threads (
      thread_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  ensureOwnerUserIdColumn(database);
  ensureOwnerUserIdColumn(database);

  const columns = database
    .prepare('PRAGMA table_info(discord_agent_threads)')
    .all() as Array<{ name: string }>;

  assert.ok(columns.some((column) => column.name === 'owner_user_id'));
});

test('runMigrations upgrades a legacy schema: adds provider column, renames threads table', () => {
  const database = new Database(':memory:');

  // Legacy schema (pre-multi-provider): channel_id is the standalone PK,
  // agent_threads has the old name.
  database.exec(`
    CREATE TABLE agent_channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  database.exec(`
    CREATE TABLE agent_threads (
      thread_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  database
    .prepare('INSERT INTO agent_channels (channel_id, guild_id, agent_id, agent_name) VALUES (?, ?, ?, ?)')
    .run('ch-legacy', 'g1', 'a1', 'Legacy Agent');
  database
    .prepare('INSERT INTO agent_threads (thread_id, channel_id, agent_id) VALUES (?, ?, ?)')
    .run('th-legacy', 'ch-legacy', 'a1');

  runMigrations(database);

  // agent_channels now has the provider column with default 'discord'.
  const cols = database.prepare("PRAGMA table_info('agent_channels')").all() as Array<{
    name: string;
  }>;
  assert.ok(cols.some((c) => c.name === 'provider'));
  assert.ok(cols.some((c) => c.name === 'read_only'));

  const row = database
    .prepare('SELECT provider, channel_id, agent_id FROM agent_channels WHERE channel_id = ?')
    .get('ch-legacy') as { provider: string; channel_id: string; agent_id: string };
  assert.equal(row.provider, 'discord');
  assert.equal(row.agent_id, 'a1');

  // agent_threads has been renamed to discord_agent_threads with data preserved.
  const threadRows = database
    .prepare('SELECT thread_id FROM discord_agent_threads')
    .all() as Array<{ thread_id: string }>;
  assert.equal(threadRows.length, 1);
  assert.equal(threadRows[0].thread_id, 'th-legacy');

  // Old table is gone.
  const oldTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_threads'")
    .get();
  assert.equal(oldTable, undefined);
});

test('runMigrations is idempotent on the new schema', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE agent_channels (
      provider TEXT NOT NULL DEFAULT 'discord',
      channel_id TEXT NOT NULL,
      guild_id TEXT,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      session_id TEXT,
      read_only INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (provider, channel_id)
    )
  `);

  runMigrations(database);
  runMigrations(database);

  const cols = database.prepare("PRAGMA table_info('agent_channels')").all() as Array<{
    name: string;
  }>;
  assert.ok(cols.some((c) => c.name === 'provider'));
});

test('ensureDiscordPushedMessagesTable creates the anchor table and is safe to rerun', () => {
  const database = new Database(':memory:');

  ensureDiscordPushedMessagesTable(database);
  ensureDiscordPushedMessagesTable(database);

  const cols = database
    .prepare("PRAGMA table_info('discord_pushed_messages')")
    .all() as Array<{ name: string; pk: number; notnull: number }>;
  const byName = new Map(cols.map((c) => [c.name, c]));

  assert.deepEqual(
    cols.map((c) => c.name).sort(),
    ['agent_id', 'channel_id', 'created_at', 'message_id', 'owner_user_id', 'session_id'],
  );
  assert.equal(byName.get('message_id')!.pk, 1, 'message_id is the primary key');
  assert.equal(byName.get('session_id')!.notnull, 0, 'session_id is nullable');
  assert.equal(
    byName.get('owner_user_id')!.notnull,
    0,
    'owner_user_id is nullable — an anchor may have no vetted owner',
  );

  // The retention purge filters on created_at; it must be indexed.
  const indexes = database
    .prepare("PRAGMA index_list('discord_pushed_messages')")
    .all() as Array<{ name: string }>;
  assert.ok(indexes.some((i) => i.name === 'idx_discord_pushed_messages_created_at'));
});

test('runMigrations creates discord_pushed_messages on a legacy database', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE agent_channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  runMigrations(database);

  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discord_pushed_messages'")
    .get() as { name?: string } | undefined;
  assert.equal(table?.name, 'discord_pushed_messages');
});

test('runMigrations backfills owner_user_id on a pre-gate discord_pushed_messages table', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE agent_channels (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // The shape the table had before session handover was gated on an owner.
  database.exec(`
    CREATE TABLE discord_pushed_messages (
      message_id  TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      session_id  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  database
    .prepare(
      'INSERT INTO discord_pushed_messages (message_id, channel_id, agent_id, session_id) VALUES (?, ?, ?, ?)',
    )
    .run('m-1', 'ch-1', 'agent-1', 'session-1');

  runMigrations(database);
  // Idempotent: a second run must not trip over the now-existing column.
  runMigrations(database);

  const cols = database
    .prepare("PRAGMA table_info('discord_pushed_messages')")
    .all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === 'owner_user_id'));
  const row = database
    .prepare('SELECT owner_user_id FROM discord_pushed_messages WHERE message_id = ?')
    .get('m-1') as { owner_user_id: string | null };
  assert.equal(row.owner_user_id, null, 'existing anchors are unvetted, not silently owned');
});
