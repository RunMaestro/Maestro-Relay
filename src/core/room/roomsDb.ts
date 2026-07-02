import { db } from '../db';

/**
 * Pure-kernel query helpers over the multi-agent rooms schema
 * (`rooms`, `room_participants`, `agent_bot_bindings`). Mirrors the
 * `channelDb` object pattern in `db/index.ts` — no provider client
 * libraries. Every key is a plain string so any provider can drive it.
 *
 * The real-bots deltas over the baseline surface:
 *  - `room_participants.bot_slot` — the pool bot rendering this agent's
 *    identity in this room. Unique per room (one bot = one agent).
 *  - `agent_bot_bindings` — the HARD, ENFORCED global agent→bot mapping. An
 *    agent bound to slot "Ada" in one room is "Ada" in every room. First
 *    invite allocates+writes the binding; later invites reuse it; binding an
 *    agent to a *different* slot is rejected (only a deliberate rebind may
 *    change it). Per-room `bot_slot` is a denormalized copy of this binding.
 *  - `rooms.turn_count` / `max_turns` — the burst-scoped turn-depth brake
 *    (see the Phase 4 bus).
 */

export type RoomStatus = 'active' | 'paused' | 'halted';

export interface RoomRecord {
  room_key: string;
  provider: string;
  channel_id: string;
  thread_id: string | null;
  status: RoomStatus;
  budget_usd: number | null;
  spent_usd: number;
  max_mentions: number;
  max_turns: number;
  turn_count: number;
  created_at: number;
}

export interface RoomParticipant {
  room_key: string;
  agent_id: string;
  handle: string;
  avatar_url: string | null;
  session_id: string | null;
  bot_slot: string | null;
  created_at: number;
}

export interface CreateRoomParams {
  roomKey: string;
  provider: string;
  channelId: string;
  threadId?: string | null;
  budgetUsd?: number | null;
  maxMentions?: number;
  maxTurns?: number;
}

export interface AddParticipantParams {
  roomKey: string;
  agentId: string;
  handle: string;
  avatarUrl?: string | null;
  sessionId?: string | null;
  botSlot?: string | null;
}

/**
 * Thrown when an invite/participant write would violate a slot invariant —
 * either the slot is already taken within the room, or it contradicts the
 * agent's standing global binding. Providers surface `.message` to the user.
 */
export class SlotConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotConflictError';
  }
}

export const roomsDb = {
  // ---- rooms ----------------------------------------------------------------

  createRoom(params: CreateRoomParams): void {
    db.prepare(
      `INSERT INTO rooms (room_key, provider, channel_id, thread_id, budget_usd, max_mentions, max_turns)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.roomKey,
      params.provider,
      params.channelId,
      params.threadId ?? null,
      params.budgetUsd ?? null,
      params.maxMentions ?? 2,
      params.maxTurns ?? 30,
    );
  },

  getRoom(roomKey: string): RoomRecord | undefined {
    return db.prepare('SELECT * FROM rooms WHERE room_key = ?').get(roomKey) as
      | RoomRecord
      | undefined;
  },

  /**
   * The room for a (provider, channelId) pair, or undefined if none. Queries the
   * columns rather than reconstructing the `room_key`, so it never depends on the
   * key-encoding convention.
   */
  getRoomByChannel(provider: string, channelId: string): RoomRecord | undefined {
    return db
      .prepare('SELECT * FROM rooms WHERE provider = ? AND channel_id = ?')
      .get(provider, channelId) as RoomRecord | undefined;
  },

  /** A (provider, channelId) pair is a room iff a row exists for it. */
  isRoom(provider: string, channelId: string): boolean {
    const row = db
      .prepare('SELECT 1 FROM rooms WHERE provider = ? AND channel_id = ?')
      .get(provider, channelId);
    return row !== undefined;
  },

  setStatus(roomKey: string, status: RoomStatus): void {
    db.prepare('UPDATE rooms SET status = ? WHERE room_key = ?').run(status, roomKey);
  },

  addSpend(roomKey: string, usd: number): void {
    db.prepare('UPDATE rooms SET spent_usd = spent_usd + ? WHERE room_key = ?').run(usd, roomKey);
  },

  /** Increment the burst-scoped turn counter and return the new value. */
  incrementTurn(roomKey: string): number {
    const row = db
      .prepare(
        'UPDATE rooms SET turn_count = turn_count + 1 WHERE room_key = ? RETURNING turn_count',
      )
      .get(roomKey) as { turn_count: number } | undefined;
    return row?.turn_count ?? 0;
  },

  resetTurnCount(roomKey: string): void {
    db.prepare('UPDATE rooms SET turn_count = 0 WHERE room_key = ?').run(roomKey);
  },

  // ---- participants ---------------------------------------------------------

  /**
   * Add an agent to a room. Enforces, before the insert:
   *  1. slot-uniqueness within the room (the DB partial unique index backs this,
   *     but we pre-check for a clear error), and
   *  2. consistency with the global `agent_bot_bindings` — a slot that
   *     contradicts the agent's standing binding is rejected. On the first
   *     bind (no existing binding) the global binding is written here, so the
   *     participant row and the global mapping stay in lock-step.
   */
  addParticipant(params: AddParticipantParams): void {
    const slot = params.botSlot ?? null;

    const insert = db.transaction(() => {
      if (slot !== null) {
        // (2) global agent→bot binding consistency.
        const existing = this.getAgentBinding(params.agentId);
        if (existing !== null && existing !== slot) {
          throw new SlotConflictError(
            `Agent ${params.agentId} is globally bound to bot slot "${existing}", not "${slot}". ` +
              `Use "/room rebind" to deliberately change an agent's persona everywhere.`,
          );
        }

        // (1) slot uniqueness within the room.
        const taken = db
          .prepare(
            'SELECT agent_id FROM room_participants WHERE room_key = ? AND bot_slot = ? AND agent_id != ?',
          )
          .get(params.roomKey, slot, params.agentId) as { agent_id: string } | undefined;
        if (taken !== undefined) {
          throw new SlotConflictError(
            `Bot slot "${slot}" is already used by agent ${taken.agent_id} in this room.`,
          );
        }

        if (existing === null) {
          this.setAgentBinding(params.agentId, slot);
        }
      }

      db.prepare(
        `INSERT INTO room_participants (room_key, agent_id, handle, avatar_url, session_id, bot_slot)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        params.roomKey,
        params.agentId,
        params.handle,
        params.avatarUrl ?? null,
        params.sessionId ?? null,
        slot,
      );
    });

    insert();
  },

  getParticipants(roomKey: string): RoomParticipant[] {
    return db
      .prepare('SELECT * FROM room_participants WHERE room_key = ? ORDER BY created_at')
      .all(roomKey) as RoomParticipant[];
  },

  updateParticipantSession(roomKey: string, agentId: string, sessionId: string | null): void {
    db.prepare(
      'UPDATE room_participants SET session_id = ? WHERE room_key = ? AND agent_id = ?',
    ).run(sessionId, roomKey, agentId);
  },

  // ---- global agent→bot bindings -------------------------------------------

  /** The bot slot this agent is globally bound to, or null if unbound. */
  getAgentBinding(agentId: string): string | null {
    const row = db
      .prepare('SELECT bot_slot FROM agent_bot_bindings WHERE agent_id = ?')
      .get(agentId) as { bot_slot: string } | undefined;
    return row?.bot_slot ?? null;
  },

  /** Upsert the global agent→bot binding (used on first invite and by rebind). */
  setAgentBinding(agentId: string, slot: string): void {
    db.prepare(
      `INSERT INTO agent_bot_bindings (agent_id, bot_slot) VALUES (?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET bot_slot = excluded.bot_slot`,
    ).run(agentId, slot);
  },

  /**
   * First configured slot not yet used by a participant in this room, or null
   * if every configured slot is taken. Preserves the order of `configuredSlots`
   * so allocation is deterministic.
   */
  allocateFreeSlot(roomKey: string, configuredSlots: string[]): string | null {
    const used = new Set(
      (
        db
          .prepare(
            'SELECT bot_slot FROM room_participants WHERE room_key = ? AND bot_slot IS NOT NULL',
          )
          .all(roomKey) as Array<{ bot_slot: string }>
      ).map((r) => r.bot_slot),
    );
    return configuredSlots.find((slot) => !used.has(slot)) ?? null;
  },

  // ---- gateway bot registry (slot → resolved bot user id) -------------------

  /**
   * Record the bot user id the gateway manager resolved for a slot once its
   * client logged in. Idempotent per slot — a rotated token that yields the
   * same account keeps the same row; a re-slotted account overwrites it. Stores
   * the bot user id ONLY, never the token.
   */
  upsertRoomBot(slot: string, botUserId: string): void {
    db.prepare(
      `INSERT INTO room_bots (slot, bot_user_id, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(slot) DO UPDATE SET bot_user_id = excluded.bot_user_id, updated_at = unixepoch()`,
    ).run(slot, botUserId);
  },

  /** The bot user id registered for a slot, or null if the slot has no client. */
  getRoomBotUserId(slot: string): string | null {
    const row = db
      .prepare('SELECT bot_user_id FROM room_bots WHERE slot = ?')
      .get(slot) as { bot_user_id: string } | undefined;
    return row?.bot_user_id ?? null;
  },

  /** All registered (slot, bot_user_id) pairs, ordered by slot. */
  getRoomBots(): Array<{ slot: string; bot_user_id: string }> {
    return db
      .prepare('SELECT slot, bot_user_id FROM room_bots ORDER BY slot')
      .all() as Array<{ slot: string; bot_user_id: string }>;
  },
};
