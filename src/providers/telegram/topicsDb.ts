import { db } from '../../core/db';

export interface TelegramAgentTopic {
  topic_id: number;
  chat_id: string;
  agent_id: string;
  session_id: string | null;
  created_at: number;
}

export const topicDb = {
  register(topicId: number, chatId: string, agentId: string): void {
    // Idempotent: ignore conflicts on (chat_id, topic_id) so reprocessing the
    // same forum topic doesn't throw. created_at is preserved from the first
    // insert via INSERT OR IGNORE.
    db.prepare(
      `INSERT OR IGNORE INTO telegram_agent_topics (topic_id, chat_id, agent_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(topicId, chatId, agentId, Date.now());
  },

  get(chatId: string, topicId: number): TelegramAgentTopic | undefined {
    return db
      .prepare('SELECT * FROM telegram_agent_topics WHERE chat_id = ? AND topic_id = ?')
      .get(chatId, topicId) as TelegramAgentTopic | undefined;
  },

  getByAgentId(agentId: string): TelegramAgentTopic[] {
    // ORDER BY created_at ASC so topics[0] is the original/default topic for
    // the agent. NOTE: returns rows from *every* chat the agent has ever had
    // topics in. Use `getByAgentIdInChat` when you need to scope to the
    // current bound chat (e.g. `findOrCreateAgentChannel`).
    return db
      .prepare('SELECT * FROM telegram_agent_topics WHERE agent_id = ? ORDER BY created_at ASC')
      .all(agentId) as TelegramAgentTopic[];
  },

  getByAgentIdInChat(chatId: string, agentId: string): TelegramAgentTopic[] {
    // Chat-scoped variant of getByAgentId. Always prefer this in routing /
    // outbound paths so a stale row from a previous TELEGRAM_CHAT_ID can't
    // produce a (currentChatId, oldTopicId) pair that doesn't exist on
    // Telegram.
    return db
      .prepare(
        'SELECT * FROM telegram_agent_topics WHERE chat_id = ? AND agent_id = ? ORDER BY created_at ASC',
      )
      .all(chatId, agentId) as TelegramAgentTopic[];
  },

  updateSession(chatId: string, topicId: number, sessionId: string | null): void {
    db.prepare(
      'UPDATE telegram_agent_topics SET session_id = ? WHERE chat_id = ? AND topic_id = ?',
    ).run(sessionId, chatId, topicId);
  },

  remove(chatId: string, topicId: number): void {
    db.prepare('DELETE FROM telegram_agent_topics WHERE chat_id = ? AND topic_id = ?').run(
      chatId,
      topicId,
    );
  },

  listByChat(chatId: string): TelegramAgentTopic[] {
    return db
      .prepare('SELECT * FROM telegram_agent_topics WHERE chat_id = ? ORDER BY created_at DESC')
      .all(chatId) as TelegramAgentTopic[];
  },
};
