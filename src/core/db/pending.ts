import { db } from './index';

/**
 * Durable inbound-message queue.
 *
 * The in-memory queue in `core/queue.ts` is destroyed by any restart, and
 * Discord does not redeliver a message the gateway already handed over. That
 * combination silently ate real user messages: the bot left its ⏳ reaction in
 * place and simply never answered.
 *
 * Every accepted message is recorded here before work starts and deleted once
 * a reply has been sent, so a crash, a deploy, or a `launchctl kickstart`
 * leaves a work list behind that startup can replay.
 *
 * `raw` is deliberately not persisted — it holds a live discord.js object that
 * cannot be serialised. Replay therefore reconstructs the message from the
 * plain fields, which is everything the queue actually reads.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_messages (
    provider     TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    channel_id   TEXT NOT NULL,
    author_id    TEXT NOT NULL,
    author_name  TEXT NOT NULL,
    content      TEXT NOT NULL,
    attachments  TEXT NOT NULL DEFAULT '[]',
    is_thread    INTEGER NOT NULL DEFAULT 0,
    options      TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (provider, message_id)
  )
`);

export interface PendingRow {
  provider: string;
  message_id: string;
  channel_id: string;
  author_id: string;
  author_name: string;
  content: string;
  attachments: string;
  is_thread: number;
  options: string | null;
  attempts: number;
  created_at: number;
}

/**
 * Replaying a message forever would be worse than dropping it — a prompt that
 * reliably crashes the agent would be retried on every boot. Two attempts is
 * enough to survive an unlucky restart without becoming a loop.
 */
export const MAX_REPLAY_ATTEMPTS = 2;

export const pendingDb = {
  /** Record a message as accepted-but-unanswered. */
  add(
    msg: {
      provider: string;
      messageId: string;
      channelId: string;
      authorId: string;
      authorName: string;
      content: string;
      attachments: unknown[];
      isThread: boolean;
    },
    options?: unknown,
  ): void {
    db.prepare(
      `INSERT OR REPLACE INTO pending_messages
         (provider, message_id, channel_id, author_id, author_name, content,
          attachments, is_thread, options, attempts,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
               COALESCE((SELECT attempts FROM pending_messages
                         WHERE provider = ? AND message_id = ?), 0),
               unixepoch())`,
    ).run(
      msg.provider,
      msg.messageId,
      msg.channelId,
      msg.authorId,
      msg.authorName,
      msg.content,
      JSON.stringify(msg.attachments ?? []),
      msg.isThread ? 1 : 0,
      options ? JSON.stringify(options) : null,
      msg.provider,
      msg.messageId,
    );
  },

  /** Mark a message as answered. Called once a reply has actually been sent. */
  clear(provider: string, messageId: string): void {
    db.prepare('DELETE FROM pending_messages WHERE provider = ? AND message_id = ?').run(
      provider,
      messageId,
    );
  },

  /** Every message still awaiting a reply, oldest first. */
  all(): PendingRow[] {
    return db
      .prepare('SELECT * FROM pending_messages ORDER BY created_at ASC')
      .all() as PendingRow[];
  },

  /** Count still-unanswered messages — the relay's "am I busy?" signal. */
  count(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM pending_messages').get() as { n: number }).n;
  },

  /** Record a replay attempt and report whether the message may run again. */
  bumpAttempts(provider: string, messageId: string): number {
    db.prepare(
      'UPDATE pending_messages SET attempts = attempts + 1 WHERE provider = ? AND message_id = ?',
    ).run(provider, messageId);
    const row = db
      .prepare('SELECT attempts FROM pending_messages WHERE provider = ? AND message_id = ?')
      .get(provider, messageId) as { attempts: number } | undefined;
    return row?.attempts ?? 0;
  },
};
