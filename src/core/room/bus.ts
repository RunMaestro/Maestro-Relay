/**
 * The multi-agent room bus (Phase 4) — the shared, per-room-serialized worker
 * that drives one auto-relay burst across many bots.
 *
 * Pure kernel: it speaks only via the `BridgeProvider` interface and the maestro
 * CLI wrapper, and it never imports a chat SDK (`discord.js`/`@slack/bolt`). It
 * mirrors `queue.ts`'s per-conversation FIFO (`Map<roomKey, RoutedMessage[]>` +
 * a `processing: Set`) so every message for a room is handled serially — even
 * when two bots are mentioned at once they queue behind one lock.
 *
 * The locked invariants (see `docs/plans/multi-agent-rooms-real-bots.md` §Phase
 * 4) this file enforces:
 *  - **Never internally enqueue the next hop.** Posting the response *is* the
 *    hop: the response carries native `<@botUserId>` mentions, so the addressed
 *    peer bot's own gateway re-enters via `submitMessage`. Enqueue-and-post
 *    would double-route.
 *  - **Budget + turn checks run BEFORE every `maestro.send`.**
 *  - **One per-room lock across ALL bots.**
 *  - **Rewrite (`@Handle`→`<@id>`) runs BEFORE `splitMessage`**, and the
 *    splitter is mention-token-aware, so a native ping is never torn across a
 *    chunk boundary.
 *
 * The bus does NOT re-derive *who* was addressed from the inbound text — the
 * Phase 3 gateway already resolved that and passes it as `toAgentId`.
 *
 * **Loop safety (two independent turn brakes, both checked before every send):**
 *  - `turn_count` is a **burst** counter: turns since the last human message. It
 *    re-arms ONLY on a human message — NOT on queue drain. In native real-bot
 *    routing every hop is a separate gateway round-trip, so the queue is empty
 *    between hops; resetting on drain would zero the counter on every hop and the
 *    brake would never trip. Counting turns-since-human instead bounds a runaway
 *    bot↔bot burst at `max_turns`.
 *  - `lifetime_turn_count` is the hard backstop: it survives human re-arms and
 *    only resets on `/room reset`, so a loop kept alive by repeated human pokes
 *    is still bounded at `max_lifetime_turns`. Combined with the default budget
 *    cap, two bots can never ping-pong without a turn OR cost stop.
 */

import { createHash } from 'crypto';
import type {
  BridgeProvider,
  ChannelTarget,
  KernelLogger,
  PersonaIdentity,
  ProviderName,
  RoomGateway,
  RoomSubmitOptions,
} from '../types';
import { splitMessage as defaultSplitMessage } from '../splitMessage';
import { renderTables as defaultRenderTables } from '../renderTables';
import {
  buildPreamble as defaultBuildPreamble,
  parseMentions as defaultParseMentions,
  renderNativeMentions as defaultRenderNativeMentions,
  type Participant,
} from './protocol';
import {
  inferContextStrategy,
  selectContextWindow,
  DEFAULT_RECENT_TURNS,
  type ContextWindowStrategy,
  type TranscriptEntryLike,
} from './contextWindow';
import { roomsDb } from './roomsDb';

/** A message accepted for a room, already routed to a specific agent. */
interface RoutedMessage {
  fromHandle: string;
  text: string;
  toAgentId: string;
  /** Author class, carried through so the transcript buffer can label the entry. */
  fromKind: 'human' | 'bot';
}

/**
 * One entry in a room's in-memory transcript buffer. Satisfies
 * `TranscriptEntryLike` (via `source`) so the context-window heuristics window
 * it directly, and carries `fromHandle` + `text` so a windowed slice renders
 * back into the same `[handle]: text` line shape the bus already uses.
 */
interface TranscriptEntry extends TranscriptEntryLike {
  source: 'human' | 'bot';
  fromHandle: string;
  text: string;
}

/**
 * Cap on the in-memory transcript buffer per room (oldest evicted). This is a
 * best-effort onboarding aid, not durable history, so a bounded ring is enough:
 * the window heuristics only ever look at the tail.
 */
const TRANSCRIPT_CAP = 200;

/** Kernel persistence seam — the room queries the bus needs, injectable for tests. */
export type RoomBusDbSeam = Pick<
  typeof roomsDb,
  | 'getRoom'
  | 'getRoomByChannel'
  | 'isRoom'
  | 'getParticipants'
  | 'incrementTurn'
  | 'incrementLifetimeTurn'
  | 'resetTurnCount'
  | 'addSpend'
  | 'setStatus'
  | 'updateParticipantSession'
  | 'getRoomBotUserId'
>;

/** Maestro CLI surface the bus needs (same send shape as `queue.ts`). */
export type RoomBusMaestro = {
  send: (
    agentId: string,
    message: string,
    opts?: { sessionId?: string },
  ) => Promise<{
    success: boolean;
    response: string | null;
    error?: string;
    sessionId?: string;
    usage?: { totalCostUsd?: number };
  }>;
};

export type RoomBusDeps = {
  db: RoomBusDbSeam;
  maestro: RoomBusMaestro;
  /** Resolve provider name → BridgeProvider (for `sendAs` / system notices). */
  getProvider: (name: ProviderName) => BridgeProvider | undefined;
  /** Provider-configured human mention id used to expand `@human` (optional). */
  humanMentionId?: string | null;
  logger: KernelLogger;
  // --- pure-function seams (default to the real kernel impls) ---
  splitMessage?: (text: string) => string[];
  renderTables?: (text: string) => string;
  buildPreamble?: typeof defaultBuildPreamble;
  parseMentions?: typeof defaultParseMentions;
  renderNativeMentions?: typeof defaultRenderNativeMentions;
};

/**
 * Build the shared room bus. Returns a `RoomGateway` (`isRoom` + `submitMessage`)
 * so it can be assigned to `ctx.rooms`.
 */
export function createRoomBus(deps: RoomBusDeps): RoomGateway {
  const split = deps.splitMessage ?? defaultSplitMessage;
  const renderTables = deps.renderTables ?? defaultRenderTables;
  const buildPreamble = deps.buildPreamble ?? defaultBuildPreamble;
  const parseMentions = deps.parseMentions ?? defaultParseMentions;
  const renderNativeMentions = deps.renderNativeMentions ?? defaultRenderNativeMentions;
  const { db, maestro, logger } = deps;

  /** Per-room FIFO backlog and the single per-room processing lock. */
  const queues = new Map<string, RoutedMessage[]>();
  const processing = new Set<string>();
  /** Echo guard: last posted response hash keyed by `roomKey agentId`. */
  const lastResponseHash = new Map<string, string>();
  /**
   * Per-room in-memory transcript ring buffer. Records each message the room has
   * *processed*, in order, so a persona invited mid-conversation (one with no
   * maestro session yet) can be onboarded with a windowed transcript of the
   * room-so-far. In-memory + addressed-only by design (see `appendTranscript`).
   */
  const transcripts = new Map<string, TranscriptEntry[]>();

  /** Append one entry to a room's transcript buffer, evicting the oldest past the cap. */
  function appendTranscript(roomKey: string, entry: TranscriptEntry): void {
    const buf = transcripts.get(roomKey) ?? [];
    buf.push(entry);
    if (buf.length > TRANSCRIPT_CAP) buf.splice(0, buf.length - TRANSCRIPT_CAP);
    transcripts.set(roomKey, buf);
  }

  /**
   * Render a windowed transcript slice into a preamble block. Mirrors the bus's
   * existing `[handle]: text` line shape so onboarding history reads identically
   * to the live trigger line the agent also sees.
   */
  function renderTranscript(entries: TranscriptEntry[]): string {
    const lines = entries.map((e) => `[${e.fromHandle}]: ${e.text}`).join('\n');
    return `Conversation so far (you were invited mid-conversation):\n${lines}`;
  }

  function isRoom(provider: ProviderName, channelId: string): boolean {
    return db.isRoom(provider, channelId);
  }

  function submitMessage(
    provider: ProviderName,
    channelId: string,
    from: string,
    text: string,
    opts: RoomSubmitOptions = {},
  ): void {
    const room = db.getRoomByChannel(provider, channelId);
    if (!room) {
      logger.warn('room-bus:submit', `no room for ${provider}:${channelId}`);
      return;
    }
    const toAgentId = opts.toAgentId;
    if (!toAgentId) {
      // The gateway must resolve the addressee; without one there is nothing to route.
      logger.warn('room-bus:submit', `dropping message with no toAgentId room=${room.room_key}`);
      return;
    }

    // A human message re-arms the burst turn counter — the ONLY thing that does
    // (the queue drain deliberately does not; see `processNext`).
    if (opts.fromKind === 'human') {
      db.resetTurnCount(room.room_key);
    }

    const backlog = queues.get(room.room_key) ?? [];
    backlog.push({ fromHandle: from, text, toAgentId, fromKind: opts.fromKind ?? 'human' });
    queues.set(room.room_key, backlog);

    if (!processing.has(room.room_key)) {
      void processNext(room.room_key);
    }
  }

  /** Post a one-off system notice via the primary bot (slot 0). Best-effort. */
  async function postSystemNotice(
    provider: BridgeProvider | undefined,
    target: ChannelTarget,
    text: string,
  ): Promise<void> {
    if (!provider) return;
    try {
      await provider.send(target, { text });
    } catch (err) {
      void logger.error(
        'room-bus:system-notice',
        `provider=${target.provider} channel=${target.channelId} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Stop the room: mark halted, clear its backlog, release the lock. */
  function halt(roomKey: string): void {
    db.setStatus(roomKey, 'halted');
    queues.delete(roomKey);
    processing.delete(roomKey);
    transcripts.delete(roomKey);
  }

  async function processNext(roomKey: string): Promise<void> {
    const backlog = queues.get(roomKey);
    if (!backlog || backlog.length === 0) {
      // Drain: just drop the lock. Do NOT reset the burst turn counter here — in
      // native real-bot routing each hop is a separate gateway round-trip, so the
      // queue is empty between every hop; a drain reset would zero the counter on
      // every hop and the turn brake would never trip. The burst counter re-arms
      // only on a human message (see `submitMessage`).
      processing.delete(roomKey);
      return;
    }

    processing.add(roomKey);
    const msg = backlog.shift()!;

    const room = db.getRoom(roomKey);
    if (!room) {
      logger.warn('room-bus:process', `room ${roomKey} vanished; dropping backlog`);
      queues.delete(roomKey);
      processing.delete(roomKey);
      return;
    }

    const provider = deps.getProvider(room.provider);
    const target: ChannelTarget = {
      provider: room.provider,
      channelId: room.channel_id,
      threadId: room.thread_id ?? undefined,
    };

    // --- Step 1: status + budget, BEFORE any send. ---
    if (room.status === 'paused') {
      // Hold, don't drop: put the message back at the front of the backlog and
      // release the lock. A paused room retains its in-flight messages; they
      // replay in order the next time the room processes (a `/room resume`
      // followed by any new room message re-kicks the drain via `submitMessage`).
      backlog.unshift(msg);
      queues.set(roomKey, backlog);
      processing.delete(roomKey);
      return;
    }
    if (room.status !== 'active') {
      // Halted (terminal): drop this message, keep draining the rest quietly.
      void processNext(roomKey);
      return;
    }
    if (room.budget_usd !== null && room.spent_usd >= room.budget_usd) {
      halt(roomKey);
      await postSystemNotice(
        provider,
        target,
        `🛑 Room halted: budget of $${room.budget_usd.toFixed(2)} reached ` +
          `(spent $${room.spent_usd.toFixed(2)}).`,
      );
      return;
    }

    // --- Step 2: turn brakes, BEFORE the send. ---
    // (a) Burst-scoped: turns since the last human message.
    const turn = db.incrementTurn(roomKey);
    if (turn > room.max_turns) {
      halt(roomKey);
      await postSystemNotice(
        provider,
        target,
        `🛑 Room halted: turn limit of ${room.max_turns} reached since the last human ` +
          `message. A human message resets this.`,
      );
      return;
    }
    // (b) Lifetime hard backstop: total turns, only reset by `/room reset`. Guards
    //     against a loop kept alive by repeated human pokes re-arming the burst.
    const lifetimeTurn = db.incrementLifetimeTurn(roomKey);
    if (lifetimeTurn > room.max_lifetime_turns) {
      halt(roomKey);
      await postSystemNotice(
        provider,
        target,
        `🛑 Room halted: lifetime turn limit of ${room.max_lifetime_turns} reached. ` +
          `Use \`/room reset\` to clear it.`,
      );
      return;
    }

    // --- Resolve the acting participant and the room roster. ---
    const participants = db.getParticipants(roomKey);
    const self = participants.find((p) => p.agent_id === msg.toAgentId);
    if (!self) {
      logger.warn(
        'room-bus:process',
        `agent ${msg.toAgentId} is not a participant of ${roomKey}; skipping`,
      );
      void processNext(roomKey);
      return;
    }

    // Participants carry their resolved bot user id so the mention renderer can
    // emit real `<@id>` pings and self-exclude the acting persona.
    const roster: Participant[] = participants.map((p) => ({
      agentId: p.agent_id,
      handle: p.handle,
      avatarUrl: p.avatar_url,
      botUserId: p.bot_slot ? db.getRoomBotUserId(p.bot_slot) : null,
    }));
    const selfProto: Participant = {
      agentId: self.agent_id,
      handle: self.handle,
      avatarUrl: self.avatar_url,
      botUserId: self.bot_slot ? db.getRoomBotUserId(self.bot_slot) : null,
    };

    try {
      // --- Step 3: build the input. ---
      const preamble = buildPreamble({ roomKey: room.room_key }, selfProto, roster);

      // Onboarding: a participant with no maestro session yet has never seen the
      // room. Prepend a windowed transcript of the room-so-far so it joins
      // mid-conversation with context instead of just the preamble + trigger.
      // Default is recent-turns; a natural-language hint in the trigger ("share
      // the last 3 messages", "this thread") narrows or widens it. The window is
      // taken BEFORE this message is recorded, so the trigger isn't duplicated in
      // its own onboarding block.
      let contextBlock = '';
      const history = transcripts.get(roomKey) ?? [];
      if (!self.session_id && history.length > 0) {
        const inferred = inferContextStrategy(msg.text);
        const strategy: ContextWindowStrategy =
          inferred.kind === 'full'
            ? { kind: 'recent-turns', turns: DEFAULT_RECENT_TURNS }
            : inferred;
        const windowed = selectContextWindow(history, strategy);
        if (windowed.length > 0) contextBlock = `${renderTranscript(windowed)}\n\n`;
      }

      // Record this message into the room transcript AFTER windowing above, so the
      // buffer stays the ordered log of processed messages for the next onboarding.
      appendTranscript(roomKey, {
        source: msg.fromKind,
        fromHandle: msg.fromHandle,
        text: msg.text,
      });

      const input = `${preamble}\n\n${contextBlock}[${msg.fromHandle}]: ${msg.text}`;

      // --- Step 4: send; persist session on the first reply. ---
      const result = await maestro.send(msg.toAgentId, input, {
        sessionId: self.session_id ?? undefined,
      });
      if (!self.session_id && result.sessionId) {
        db.updateParticipantSession(roomKey, msg.toAgentId, result.sessionId);
      }

      // --- Step 5: charge the room. ---
      db.addSpend(roomKey, result.usage?.totalCostUsd ?? 0);

      if (!result.response) {
        if (result.error) {
          void logger.error(
            'room-bus:agent-failure',
            `agent=${msg.toAgentId} room=${roomKey} error=${result.error}`,
          );
        }
        void processNext(roomKey);
        return;
      }

      // --- Step 6: parse the intended targets (for logging; render re-derives). ---
      const parsed = parseMentions(result.response, roster, {
        self: selfProto,
        maxMentions: room.max_mentions,
      });
      logger.debug(
        'room-bus:route',
        `room=${roomKey} agent=${msg.toAgentId} targets=[${parsed.targets
          .map((p) => p.handle)
          .join(', ')}]${parsed.human ? ' +@human' : ''}`,
      );

      // --- Step 7: echo guard — suppress a stuck agent repeating itself. ---
      const echoKey = `${roomKey} ${msg.toAgentId}`;
      const hash = createHash('sha1').update(result.response).digest('hex');
      if (lastResponseHash.get(echoKey) === hash) {
        logger.warn(
          'room-bus:echo',
          `suppressed duplicate reply from ${msg.toAgentId} in ${roomKey}`,
        );
        void processNext(roomKey);
        return;
      }
      lastResponseHash.set(echoKey, hash);

      // --- Step 8: render → rewrite (before split) → split (mention-atomic) → post. ---
      const rendered = renderNativeMentions(renderTables(result.response), roster, {
        self: selfProto,
        maxMentions: room.max_mentions,
        humanMentionId: deps.humanMentionId ?? null,
      });
      const parts = split(rendered);

      const identity: PersonaIdentity = {
        name: self.handle,
        avatarUrl: self.avatar_url ?? undefined,
        botUserId: selfProto.botUserId ?? undefined,
      };
      for (const part of parts) {
        // Post as the acting bot. The native `<@id>` mentions in `part` are the
        // ONLY thing that fires the next hop — a peer bot's gateway delivers it.
        // We must NEVER internally enqueue the next hop here.
        if (provider?.sendAs) {
          await provider.sendAs(target, identity, { text: part });
        } else if (provider) {
          await provider.send(target, { text: part });
        }
      }
    } catch (err) {
      void logger.error(
        'room-bus:process',
        `agent=${msg.toAgentId} room=${roomKey} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // --- Step 8 (tail): drain any inbound backlog; drain-reset when empty. ---
    void processNext(roomKey);
  }

  return { isRoom, submitMessage };
}
