import type { Database } from 'better-sqlite3';
import { db } from '../../core/db';

export interface SlackAgentConversation {
  thread_ts: string;
  channel_id: string;
  agent_id: string;
  owner_user_id: string | null;
  session_id: string | null;
  created_at: number;
}

export function createConversationDb(database: Database) {
  return {
    register(
      threadTs: string,
      channelId: string,
      agentId: string,
      ownerUserId: string | null,
    ): void {
      database.prepare(
        `INSERT OR IGNORE INTO slack_agent_conversations (thread_ts, channel_id, agent_id, owner_user_id)
         VALUES (?, ?, ?, ?)`,
      ).run(threadTs, channelId, agentId, ownerUserId);
    },

    get(threadTs: string): SlackAgentConversation | undefined {
      return database
        .prepare('SELECT * FROM slack_agent_conversations WHERE thread_ts = ?')
        .get(threadTs) as SlackAgentConversation | undefined;
    },

    updateSession(threadTs: string, sessionId: string | null): void {
      database.prepare(
        'UPDATE slack_agent_conversations SET session_id = ? WHERE thread_ts = ?',
      ).run(sessionId, threadTs);
    },

    remove(threadTs: string): void {
      database.prepare('DELETE FROM slack_agent_conversations WHERE thread_ts = ?').run(threadTs);
    },

    listByChannel(channelId: string): SlackAgentConversation[] {
      return database
        .prepare(
          'SELECT * FROM slack_agent_conversations WHERE channel_id = ? ORDER BY created_at DESC',
        )
        .all(channelId) as SlackAgentConversation[];
    },

    getByAgentId(agentId: string): SlackAgentConversation | undefined {
      return database
        .prepare('SELECT * FROM slack_agent_conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(agentId) as SlackAgentConversation | undefined;
    },

    removeByChannel(channelId: string): void {
      database.prepare('DELETE FROM slack_agent_conversations WHERE channel_id = ?').run(channelId);
    },
  };
}

export const conversationDb = createConversationDb(db);
