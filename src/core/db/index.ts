import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from './migrations';

/**
 * Provider-aware channel registry. Each row binds a (provider, channel_id)
 * pair to a maestro agent and (optionally) an active session. Provider-
 * specific tables (e.g. Discord threads) live alongside this in adapter-
 * owned modules.
 */

export const db = new Database(path.join(__dirname, '../../../maestro-bot.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_channels (
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

runMigrations(db);

export interface AgentChannel {
  provider: string;
  channel_id: string;
  guild_id: string | null;
  agent_id: string;
  agent_name: string;
  session_id: string | null;
  read_only: number;
  created_at: number;
}

export const channelDb = {
  register(
    provider: string,
    channelId: string,
    agentId: string,
    agentName: string,
    guildId: string | null = null,
  ): void {
    db.prepare(
      `INSERT INTO agent_channels (provider, channel_id, guild_id, agent_id, agent_name)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(provider, channelId, guildId, agentId, agentName);
  },

  get(provider: string, channelId: string): AgentChannel | undefined {
    return db
      .prepare('SELECT * FROM agent_channels WHERE provider = ? AND channel_id = ?')
      .get(provider, channelId) as AgentChannel | undefined;
  },

  getByAgentId(provider: string, agentId: string): AgentChannel | undefined {
    return db
      .prepare('SELECT * FROM agent_channels WHERE provider = ? AND agent_id = ?')
      .get(provider, agentId) as AgentChannel | undefined;
  },

  updateSession(provider: string, channelId: string, sessionId: string | null): void {
    db.prepare(
      'UPDATE agent_channels SET session_id = ? WHERE provider = ? AND channel_id = ?',
    ).run(sessionId, provider, channelId);
  },

  setReadOnly(provider: string, channelId: string, readOnly: boolean): void {
    db.prepare(
      'UPDATE agent_channels SET read_only = ? WHERE provider = ? AND channel_id = ?',
    ).run(readOnly ? 1 : 0, provider, channelId);
  },

  remove(provider: string, channelId: string): void {
    db.prepare('DELETE FROM agent_channels WHERE provider = ? AND channel_id = ?').run(
      provider,
      channelId,
    );
  },

  listByAgentId(provider: string, agentId: string): AgentChannel[] {
    return db
      .prepare('SELECT * FROM agent_channels WHERE provider = ? AND agent_id = ?')
      .all(provider, agentId) as AgentChannel[];
  },

  listByGuild(guildId: string): AgentChannel[] {
    return db
      .prepare("SELECT * FROM agent_channels WHERE provider = 'discord' AND guild_id = ?")
      .all(guildId) as AgentChannel[];
  },
};
