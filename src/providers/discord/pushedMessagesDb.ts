import { db } from '../../core/db';

/**
 * Registry of messages the bridge pushed into Discord on an agent's behalf
 * (`POST /api/send`).
 *
 * Its one job is to make an agent push *answerable*: Discord assigns a thread
 * created from a message the same snowflake as that message, so a thread id the
 * bridge has never seen before can be looked up here to discover which agent
 * (and which maestro session) posted the message the human just replied to.
 *
 * An anchor also carries the Discord user allowed to *inherit* that session
 * (`owner_user_id`). Without that gate any member who can open a thread on the
 * push would take over the referenced session and keep writing with its
 * context; adoption therefore only hands over `session_id` to that user, and
 * anyone else's reply starts fresh (see `messageCreate.adoptPushedThread`).
 *
 * Only ids are stored — never message content. Rows expire via
 * `purgeOlderThan`, since an anchor nobody has replied to in a month is dead
 * weight.
 */

export interface DiscordPushedMessage {
  message_id: string;
  channel_id: string;
  agent_id: string;
  session_id: string | null;
  /**
   * Discord user allowed to continue `session_id` by replying in a thread on
   * this message. Null means nobody was vetted, in which case such a reply gets
   * a fresh session instead of this one.
   */
  owner_user_id: string | null;
  created_at: number;
}

/** Default retention for push anchors. */
export const PUSHED_MESSAGE_RETENTION_DAYS = 30;

/**
 * Who may inherit a push's session: the user the caller vetted, else the
 * configured mention user (the human this bot's pushes are addressed to), else
 * nobody. Blank strings — `DISCORD_MENTION_USER_ID` is `''` when unset — must
 * collapse to null so an empty id never reads as a real owner.
 */
export function resolveAnchorOwner(
  recordOwnerUserId: string | null | undefined,
  mentionUserId: string | null | undefined,
): string | null {
  return recordOwnerUserId?.trim() || mentionUserId?.trim() || null;
}

export const pushedMessagesDb = {
  /**
   * Record a pushed message. `INSERT OR REPLACE` because a message id is
   * globally unique in Discord — a repeat is a re-record of the same message,
   * and the newest agent/session binding is the correct one.
   */
  record(
    messageId: string,
    channelId: string,
    agentId: string,
    sessionId: string | null = null,
    ownerUserId: string | null = null,
  ): void {
    db.prepare(
      `INSERT OR REPLACE INTO discord_pushed_messages (message_id, channel_id, agent_id, session_id, owner_user_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(messageId, channelId, agentId, sessionId, ownerUserId);
  },

  get(messageId: string): DiscordPushedMessage | undefined {
    return db
      .prepare('SELECT * FROM discord_pushed_messages WHERE message_id = ?')
      .get(messageId) as DiscordPushedMessage | undefined;
  },

  /**
   * Drop anchors older than `days`. Returns the number of rows removed so the
   * caller can log it. Safe to run on every startup.
   */
  purgeOlderThan(days: number = PUSHED_MESSAGE_RETENTION_DAYS): number {
    const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const result = db
      .prepare('DELETE FROM discord_pushed_messages WHERE created_at < ?')
      .run(cutoff);
    return result.changes;
  },

  /** Remove every anchor for a channel — used when a channel is unbound. */
  removeByChannel(channelId: string): void {
    db.prepare('DELETE FROM discord_pushed_messages WHERE channel_id = ?').run(channelId);
  },
};
