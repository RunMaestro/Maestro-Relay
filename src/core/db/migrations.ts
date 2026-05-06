import type Database from 'better-sqlite3';

/**
 * Idempotent schema migrations. Runs on startup; safe to re-run.
 *
 * Migration history:
 *  1. Add `read_only` to agent_channels (legacy)
 *  2. Add `owner_user_id` to agent_threads (legacy)
 *  3. Add `provider` column + composite PK (provider, channel_id) to agent_channels
 *  4. Rename `agent_threads` → `discord_agent_threads`
 */
export function runMigrations(db: Database.Database): void {
  ensureReadOnlyColumn(db);
  ensureProviderColumn(db);
  renameAgentThreadsTable(db);
  ensureDiscordThreadsTable(db);
  ensureOwnerUserIdColumn(db);
}

export function ensureOwnerUserIdColumn(database: Database.Database): void {
  try {
    database.exec('ALTER TABLE discord_agent_threads ADD COLUMN owner_user_id TEXT');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.toLowerCase().includes('duplicate column name')
    ) {
      throw error;
    }
  }
}

export function ensureReadOnlyColumn(database: Database.Database): void {
  try {
    database.exec('ALTER TABLE agent_channels ADD COLUMN read_only INTEGER DEFAULT 0');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.toLowerCase().includes('duplicate column name')
    ) {
      throw error;
    }
  }
}

/**
 * Add `provider` column to agent_channels and re-create the table with a
 * composite PK (provider, channel_id). Existing rows default to 'discord'.
 */
function ensureProviderColumn(database: Database.Database): void {
  const cols = database
    .prepare("PRAGMA table_info('agent_channels')")
    .all() as Array<{ name: string }>;
  const hasProvider = cols.some((c) => c.name === 'provider');
  if (hasProvider) return;
  if (cols.length === 0) return; // table doesn't exist yet — index.ts CREATE handles it

  // Re-create the table with the new schema, copy data, swap. SQLite cannot
  // change a primary key in place.
  database.exec('BEGIN');
  try {
    database.exec(`
      CREATE TABLE agent_channels_new (
        provider     TEXT NOT NULL DEFAULT 'discord',
        channel_id   TEXT NOT NULL,
        guild_id     TEXT,
        agent_id     TEXT NOT NULL,
        agent_name   TEXT NOT NULL,
        session_id   TEXT,
        read_only    INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (provider, channel_id)
      )
    `);
    database.exec(`
      INSERT INTO agent_channels_new (provider, channel_id, guild_id, agent_id, agent_name, session_id, read_only, created_at)
      SELECT 'discord', channel_id, guild_id, agent_id, agent_name, session_id, COALESCE(read_only, 0), created_at
      FROM agent_channels
    `);
    database.exec('DROP TABLE agent_channels');
    database.exec('ALTER TABLE agent_channels_new RENAME TO agent_channels');
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
}

function renameAgentThreadsTable(database: Database.Database): void {
  const oldExists =
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_threads'")
        .get() as { name?: string } | undefined
    )?.name === 'agent_threads';
  const newExists =
    (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='discord_agent_threads'",
        )
        .get() as { name?: string } | undefined
    )?.name === 'discord_agent_threads';

  if (oldExists && !newExists) {
    database.exec('ALTER TABLE agent_threads RENAME TO discord_agent_threads');
  }
}

function ensureDiscordThreadsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS discord_agent_threads (
      thread_id     TEXT PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      owner_user_id TEXT,
      session_id    TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}
