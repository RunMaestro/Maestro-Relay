import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureOwnerUserIdColumn, runMigrations } from '../core/db/migrations';

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
