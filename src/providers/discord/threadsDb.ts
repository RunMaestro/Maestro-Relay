import { db } from '../../core/db';

export interface DiscordAgentThread {
  thread_id: string;
  channel_id: string;
  agent_id: string;
  owner_user_id: string | null;
  session_id: string | null;
  created_at: number;
}

export const threadDb = {
  register(threadId: string, channelId: string, agentId: string, ownerUserId: string): void {
    db.prepare(
      `INSERT INTO discord_agent_threads (thread_id, channel_id, agent_id, owner_user_id)
       VALUES (?, ?, ?, ?)`,
    ).run(threadId, channelId, agentId, ownerUserId);
  },

  get(threadId: string): DiscordAgentThread | undefined {
    return db
      .prepare('SELECT * FROM discord_agent_threads WHERE thread_id = ?')
      .get(threadId) as DiscordAgentThread | undefined;
  },

  updateSession(threadId: string, sessionId: string | null): void {
    db.prepare('UPDATE discord_agent_threads SET session_id = ? WHERE thread_id = ?').run(
      sessionId,
      threadId,
    );
  },

  listByChannel(channelId: string): DiscordAgentThread[] {
    return db
      .prepare(
        'SELECT * FROM discord_agent_threads WHERE channel_id = ? ORDER BY created_at DESC',
      )
      .all(channelId) as DiscordAgentThread[];
  },

  remove(threadId: string): void {
    db.prepare('DELETE FROM discord_agent_threads WHERE thread_id = ?').run(threadId);
  },

  getByAgentId(agentId: string): DiscordAgentThread[] {
    return db
      .prepare('SELECT * FROM discord_agent_threads WHERE agent_id = ?')
      .all(agentId) as DiscordAgentThread[];
  },

  removeByChannel(channelId: string): void {
    db.prepare('DELETE FROM discord_agent_threads WHERE channel_id = ?').run(channelId);
  },
};
