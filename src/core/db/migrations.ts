import type Database from 'better-sqlite3';

/**
 * Idempotent schema migrations. Runs on startup; safe to re-run.
 *
 * Migration history:
 *  1. Add `read_only` to agent_channels (legacy)
 *  2. Add `owner_user_id` to agent_threads (legacy)
 *  3. Add `provider` column + composite PK (provider, channel_id) to agent_channels
 *  4. Rename `agent_threads` → `discord_agent_threads`
 *  5. Add `slack_agent_conversations` thread/timestamp registry
 *  6. Create `telegram_agent_topics` for forum-topic-per-session tracking
 *  7. Add `teams_conversation_refs` proactive-messaging reference store
 *  8. Create multi-agent rooms tables (`rooms`, `room_participants`,
 *     `agent_bot_bindings`) — provider-agnostic kernel schema
 *  9. Create `room_bots` registry (slot → resolved bot_user_id; never the token)
 *     populated by the multi-client gateway manager
 * 10. Create `room_bot_cursors` (slot, channel_id → last_seen_message_id): the
 *     per-client low-water mark that reconnect-gap reconciliation replays from
 */
export function runMigrations(db: Database.Database): void {
  ensureReadOnlyColumn(db);
  ensureProviderColumn(db);
  renameAgentThreadsTable(db);
  ensureDiscordThreadsTable(db);
  ensureTelegramTopicsTable(db);
  ensureOwnerUserIdColumn(db);
  ensureSlackConversationsTable(db);
  ensureTeamsConversationRefsTable(db);
  ensureRoomsTables(db);
  ensureRoomBotsRegistryTable(db);
  ensureRoomBotCursorsTable(db);
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

function ensureSlackConversationsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS slack_agent_conversations (
      thread_ts     TEXT PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      owner_user_id TEXT,
      session_id    TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}

function ensureTelegramTopicsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS telegram_agent_topics (
      topic_id   INTEGER NOT NULL,
      chat_id    TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, topic_id)
    )
  `);
}

function ensureTeamsConversationRefsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS teams_conversation_refs (
      conversation_id TEXT PRIMARY KEY,
      reference_json  TEXT NOT NULL,
      service_url     TEXT NOT NULL,
      tenant_id       TEXT,
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}

/**
 * Multi-agent rooms schema (provider-agnostic kernel — no Discord client library).
 *
 * `rooms` mirrors the baseline Phase 1 shape (room_key PK = `${provider}:${channelId}`,
 * status/budget ledger) plus the real-bots additions `max_turns` / `turn_count`
 * (the burst-scoped turn-depth brake — see the Phase 4 bus). `room_participants`
 * carries the sanitized `handle`, per-(room, agent) `session_id`, and the new
 * `bot_slot` (the pool bot rendering this agent's identity in this room), unique
 * per room. `agent_bot_bindings` is the enforced global agent→bot mapping: an
 * agent bound to slot "Ada" in one room is "Ada" in every room.
 *
 * All three are created idempotently with `IF NOT EXISTS`, so re-running is safe
 * and existing provider tables are untouched.
 */
function ensureRoomsTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      room_key          TEXT PRIMARY KEY,
      provider          TEXT NOT NULL,
      channel_id        TEXT NOT NULL,
      thread_id         TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      budget_usd        REAL,
      spent_usd         REAL NOT NULL DEFAULT 0,
      max_mentions      INTEGER NOT NULL DEFAULT 2,
      max_turns         INTEGER NOT NULL DEFAULT 30,
      turn_count        INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS room_participants (
      room_key    TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      handle      TEXT NOT NULL,
      avatar_url  TEXT,
      session_id  TEXT,
      bot_slot    TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (room_key, agent_id)
    )
  `);

  // A bot slot renders at most one agent within a room. NULL bot_slots are
  // exempt (SQLite treats each NULL as distinct), so participants without a
  // bound slot never collide. The kernel roomsDb enforces this in code too.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_room_participants_bot_slot
      ON room_participants (room_key, bot_slot)
      WHERE bot_slot IS NOT NULL
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_bot_bindings (
      agent_id   TEXT PRIMARY KEY,
      bot_slot   TEXT NOT NULL
    )
  `);
}

/**
 * Multi-client gateway registry (provider-agnostic kernel — no Discord client library).
 *
 * `room_bots` maps a pool `slot` (the primary bot is slot "0"; pool bots are
 * "1".."N") to the `bot_user_id` the gateway manager resolved once that client
 * logged in. It stores the resolved bot user id ONLY — never the token — so the
 * outbound native-mention rewrite and the inbound self/peer filter can look up
 * a slot's account id without a live client. Idempotent `IF NOT EXISTS`.
 */
function ensureRoomBotsRegistryTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_bots (
      slot         TEXT PRIMARY KEY,
      bot_user_id  TEXT NOT NULL,
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}

/**
 * Reconnect-gap reconciliation cursor (provider-agnostic kernel — no Discord
 * client library).
 *
 * `room_bot_cursors` tracks, per `(slot, channel_id)`, the snowflake id of the
 * last room message that slot's gateway client processed or intentionally
 * skipped (`last_seen_message_id`). Because a `messageCreate` gateway push is
 * best-effort — a client mid-reconnect silently misses it — this low-water mark
 * is what a client re-fetches *after* on `resume`, replaying any mention it
 * missed through the same listener path. Stores the snowflake id ONLY, never
 * message content. Idempotent `IF NOT EXISTS`.
 */
function ensureRoomBotCursorsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS room_bot_cursors (
      slot                 TEXT NOT NULL,
      channel_id           TEXT NOT NULL,
      last_seen_message_id TEXT NOT NULL,
      updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (slot, channel_id)
    )
  `);
}
