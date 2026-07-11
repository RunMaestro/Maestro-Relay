/**
 * Masked-persona multi-agent rooms for the relay plugin.
 *
 * A room is one chat channel bound to N Maestro agents ("personas"). A message
 * that addresses `@Handle` dispatches to that persona's agent; the reply is
 * posted back into the same channel under a `**Handle:**` prefix — masked-persona
 * mode. The plugin sandbox caps a plugin at four `net.connect` sockets (two are
 * already spent on the Discord + Slack gateways), so the real-bot room model
 * (one gateway per persona) from `docs/plans/multi-agent-rooms-real-bots.md` is
 * impossible here; a single bot mirrors every persona instead. See
 * `docs/plans/maestro-plugin-architecture.md` §8.
 *
 * Reuses the kernel room protocol (`src/core/room/protocol.ts`) for handle
 * sanitization, mention parsing, and the turn preamble, so the plugin and the
 * standalone bridge share exactly one addressing grammar.
 *
 * State lives in the per-plugin KV store under `relay:rooms` (the sandbox has no
 * SQLite handle), mirroring the bindings registry in `registry.ts`. The bus is
 * serial per room (one in-flight turn at a time, `processNext`-style, copied from
 * `src/core/queue.ts`) and self-terminating:
 *   - a message routes only to a persona it `@mentions`; an unaddressed reply
 *     drains the room and it goes idle;
 *   - a per-burst turn cap (re-armed only by a human message) bounds an A->B->A
 *     cascade;
 *   - an echo guard drops a persona's verbatim-repeated reply, breaking a
 *     two-agent ping-pong that keeps saying the same thing.
 *
 * Sandbox-safe: only `Map`/`Set`, `Promise`, `JSON`, and `console` are used — no
 * Node builtins, no timers. The agent dispatch and the channel post are injected
 * ({@link RoomBusDeps}) so the bus is provider-neutral and unit-testable.
 */

import type { MaestroSdk } from './sdk';
import { buildPreamble, parseMentions, sanitizeHandle } from '../core/room/protocol';
import { conversationKey } from './registry';

const ROOMS_KEY = 'relay:rooms';

/** Default cap on peers a single message may address (matches the kernel default). */
const DEFAULT_MAX_MENTIONS = 2;

/** Default cap on total agent turns a single human message may trigger. */
const DEFAULT_MAX_BURST_TURNS = 6;

/** A persona in a room: a Maestro agent rendered under an addressable handle. */
export interface RoomParticipant {
  agentId: string;
  /** Sanitized, unique-within-room display handle. */
  handle: string;
}

export type RoomStatus = 'active' | 'paused';

/** A room: one provider channel fronting many personas. */
export interface RoomRecord {
  /** `${provider}:${channelId}` — the stable room key. */
  roomKey: string;
  provider: string;
  channelId: string;
  /** Optional display name (falls back to the room key in the preamble). */
  name?: string;
  status: RoomStatus;
  maxMentions: number;
  participants: RoomParticipant[];
}

/** On-disk shape: keyed by room key. */
interface RoomMap {
  [roomKey: string]: RoomRecord;
}

function isRoomRecord(value: unknown): value is RoomRecord {
  if (value === null || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.roomKey === 'string' &&
    typeof r.provider === 'string' &&
    typeof r.channelId === 'string' &&
    Array.isArray(r.participants)
  );
}

function parseRooms(raw: string | null): RoomMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: RoomMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isRoomRecord(value)) out[key] = normalizeRoom(value);
    }
    return out;
  } catch {
    // A corrupt blob must not wedge the bridge; start from an empty registry.
    return {};
  }
}

/** Coerce a loaded record into a fully-populated {@link RoomRecord}. */
function normalizeRoom(r: RoomRecord): RoomRecord {
  const participants: RoomParticipant[] = Array.isArray(r.participants)
    ? r.participants
        .filter(
          (p): p is RoomParticipant =>
            p !== null &&
            typeof p === 'object' &&
            typeof (p as RoomParticipant).agentId === 'string' &&
            typeof (p as RoomParticipant).handle === 'string',
        )
        .map((p) => ({ agentId: p.agentId, handle: p.handle }))
    : [];
  return {
    roomKey: r.roomKey,
    provider: r.provider,
    channelId: r.channelId,
    name: typeof r.name === 'string' && r.name.length > 0 ? r.name : undefined,
    status: r.status === 'paused' ? 'paused' : 'active',
    maxMentions:
      typeof r.maxMentions === 'number' && r.maxMentions > 0
        ? Math.floor(r.maxMentions)
        : DEFAULT_MAX_MENTIONS,
    participants,
  };
}

async function loadRooms(sdk: MaestroSdk): Promise<RoomMap> {
  return parseRooms(await sdk.storage.get(ROOMS_KEY));
}

async function saveRooms(sdk: MaestroSdk, rooms: RoomMap): Promise<void> {
  await sdk.storage.set(ROOMS_KEY, JSON.stringify(rooms));
}

/** Every room, ordered by key for stable listings. */
export async function listRooms(sdk: MaestroSdk): Promise<RoomRecord[]> {
  const rooms = await loadRooms(sdk);
  return Object.keys(rooms)
    .sort()
    .map((key) => rooms[key]);
}

/** One room, or undefined when the channel is not a room. */
export async function getRoom(
  sdk: MaestroSdk,
  provider: string,
  channelId: string,
): Promise<RoomRecord | undefined> {
  const rooms = await loadRooms(sdk);
  return rooms[conversationKey(provider, channelId)];
}

/** True when the channel is registered as a room. */
export async function isRoomChannel(
  sdk: MaestroSdk,
  provider: string,
  channelId: string,
): Promise<boolean> {
  return (await getRoom(sdk, provider, channelId)) !== undefined;
}

/**
 * Create a room, or return the existing one unchanged. Idempotent: re-creating a
 * room never clears its participants (use {@link deleteRoom} first for a reset).
 */
export async function createRoom(
  sdk: MaestroSdk,
  provider: string,
  channelId: string,
  opts: { name?: string; maxMentions?: number } = {},
): Promise<RoomRecord> {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  const existing = rooms[key];
  if (existing) return existing;
  const record: RoomRecord = {
    roomKey: key,
    provider,
    channelId,
    name: opts.name && opts.name.length > 0 ? opts.name : undefined,
    status: 'active',
    maxMentions:
      typeof opts.maxMentions === 'number' && opts.maxMentions > 0
        ? Math.floor(opts.maxMentions)
        : DEFAULT_MAX_MENTIONS,
    participants: [],
  };
  rooms[key] = record;
  await saveRooms(sdk, rooms);
  return record;
}

/** Delete a room. Returns false when no room existed. */
export async function deleteRoom(
  sdk: MaestroSdk,
  provider: string,
  channelId: string,
): Promise<boolean> {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  if (!rooms[key]) return false;
  delete rooms[key];
  await saveRooms(sdk, rooms);
  return true;
}

/**
 * Derive a room-unique handle from a display name. Sanitizes to the kernel's
 * handle charset, then appends a short deterministic suffix on collision so two
 * personas can never share an addressable handle.
 */
function uniqueHandle(name: string, agentId: string, taken: Set<string>): string {
  const base = sanitizeHandle(name);
  if (!taken.has(base.toLowerCase())) return base;
  const idSuffix = sanitizeHandle(agentId).slice(0, 4) || 'x';
  let candidate = `${base}-${idSuffix}`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}-${idSuffix}-${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * Add a persona to a room (creating the room if needed). Re-adding the same
 * agent id is idempotent and returns the existing participant. Returns
 * `undefined` if the room does not exist and cannot be created — never happens
 * here, but keeps the signature total.
 */
export async function addParticipant(
  sdk: MaestroSdk,
  provider: string,
  channelId: string,
  agentId: string,
  displayName: string,
): Promise<RoomParticipant> {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  let room = rooms[key];
  if (!room) {
    room = {
      roomKey: key,
      provider,
      channelId,
      status: 'active',
      maxMentions: DEFAULT_MAX_MENTIONS,
      participants: [],
    };
    rooms[key] = room;
  }
  const existing = room.participants.find((p) => p.agentId === agentId);
  if (existing) return existing;
  const taken = new Set(room.participants.map((p) => p.handle.toLowerCase()));
  const participant: RoomParticipant = {
    agentId,
    handle: uniqueHandle(displayName || agentId, agentId, taken),
  };
  room.participants.push(participant);
  await saveRooms(sdk, rooms);
  return participant;
}

/** Remove a persona by agent id or handle (case-insensitive). Returns false if absent. */
export async function removeParticipant(
  sdk: MaestroSdk,
  provider: string,
  channelId: string,
  agentIdOrHandle: string,
): Promise<boolean> {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  const room = rooms[key];
  if (!room) return false;
  const lower = agentIdOrHandle.toLowerCase();
  const before = room.participants.length;
  room.participants = room.participants.filter(
    (p) => p.agentId !== agentIdOrHandle && p.handle.toLowerCase() !== lower,
  );
  if (room.participants.length === before) return false;
  await saveRooms(sdk, rooms);
  return true;
}

/** Pause or resume a room. Returns false when no room exists. */
export async function setRoomStatus(
  sdk: MaestroSdk,
  provider: string,
  channelId: string,
  status: RoomStatus,
): Promise<boolean> {
  const rooms = await loadRooms(sdk);
  const key = conversationKey(provider, channelId);
  const room = rooms[key];
  if (!room) return false;
  room.status = status;
  await saveRooms(sdk, rooms);
  return true;
}

// --------------------------------------------------------------------------
// Bus
// --------------------------------------------------------------------------

/** A masked persona post the bus asks the transport to render into the channel. */
export interface RoomPost {
  /** The persona handle this reply speaks as. */
  handle: string;
  /** The reply body (before any `**Handle:**` masking the transport applies). */
  text: string;
}

/**
 * Dispatch a room turn to one agent and resolve with its assembled reply plus
 * the session id to continue that persona's context. Injected so the bus stays
 * provider-neutral and unit-testable; the runtime wires this to
 * {@link collectAgentReply}.
 */
export type RoomDispatch = (
  agentId: string,
  prompt: string,
  sessionId?: string,
) => Promise<{ text: string; sessionId?: string }>;

/** Post a masked persona reply into a room's channel. */
export type RoomSendAs = (room: RoomRecord, post: RoomPost) => void | Promise<void>;

/** Minimal logger the bus needs; defaults to `console`. */
export interface RoomLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface RoomBusDeps {
  sdk: MaestroSdk;
  dispatch: RoomDispatch;
  sendAs: RoomSendAs;
  logger?: RoomLogger;
  /** Total agent turns a single human message may trigger. Default 6. */
  maxBurstTurns?: number;
}

export type RoomSubmitStatus = 'no-room' | 'no-target' | 'queued' | 'drained';

export interface RoomSubmitResult {
  status: RoomSubmitStatus;
  /** Personas addressed by the triggering message (0 for `no-room`/`no-target`). */
  targets: number;
  /** Agent turns produced while draining (only meaningful for `drained`). */
  turns: number;
  /** `@human` was addressed by the triggering message. */
  human: boolean;
}

/** The room gateway the runtime consumes: a room check + an inbound submit. */
export interface RoomBus {
  isRoom(provider: string, channelId: string): Promise<boolean>;
  /**
   * Feed an inbound human/room message. Parses its `@mentions`, routes one turn
   * per addressed persona, and drains the resulting cascade. Resolves once the
   * room is idle (or immediately with `queued` if a drain is already running for
   * that room — the in-flight drain will pick the new work up).
   */
  submitMessage(
    provider: string,
    channelId: string,
    fromHandle: string,
    text: string,
  ): Promise<RoomSubmitResult>;
}

/** A single routed work item: one turn owed to one persona. */
interface RoutedTurn {
  fromHandle: string;
  text: string;
  toAgentId: string;
}

export function createRoomBus(deps: RoomBusDeps): RoomBus {
  const { sdk, dispatch, sendAs } = deps;
  const logger = deps.logger ?? {
    warn: (m: string) => console.warn('[relay:room] ' + m),
    error: (m: string) => console.error('[relay:room] ' + m),
  };
  const maxBurstTurns =
    typeof deps.maxBurstTurns === 'number' && deps.maxBurstTurns > 0
      ? Math.floor(deps.maxBurstTurns)
      : DEFAULT_MAX_BURST_TURNS;

  /** Per-room FIFO backlog and the single per-room processing lock. */
  const queues = new Map<string, RoutedTurn[]>();
  const processing = new Set<string>();
  /** Turns triggered by the current human burst, keyed by room key. */
  const burst = new Map<string, number>();
  /** Per-(room, agent) maestro session id for persona context continuity. */
  const sessions = new Map<string, string>();
  /** Echo guard: last posted reply text, keyed by (room key, agent id). */
  const lastPost = new Map<string, string>();

  async function drain(key: string): Promise<number> {
    if (processing.has(key)) return 0;
    processing.add(key);
    let turns = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const rooms = await loadRooms(sdk);
        const room = rooms[key];
        if (!room) break;
        if (room.status === 'paused') break; // hold the backlog until resumed
        const backlog = queues.get(key);
        if (!backlog || backlog.length === 0) break;

        if ((burst.get(key) ?? 0) >= maxBurstTurns) {
          logger.warn(
            `room ${key}: burst cap ${maxBurstTurns} reached; dropping ${backlog.length} queued turn(s)`,
          );
          queues.set(key, []);
          break;
        }

        const item = backlog.shift()!;
        const participant = room.participants.find((p) => p.agentId === item.toAgentId);
        if (!participant) continue; // persona removed since it was queued

        const preamble = buildPreamble(
          { name: room.name, roomKey: room.roomKey },
          participant,
          room.participants,
        );
        const prompt = `${preamble}\n\n[${item.fromHandle}]: ${item.text}`;
        // NUL-joined (room, agent) key for this persona's session + echo guard.
        const sessKey = `${key}\u0000${participant.agentId}`;

        let reply: { text: string; sessionId?: string };
        try {
          reply = await dispatch(participant.agentId, prompt, sessions.get(sessKey));
        } catch (error) {
          logger.error(
            `room ${key}: dispatch to ${participant.handle} (${participant.agentId}) failed: ${String(error)}`,
          );
          continue;
        }
        burst.set(key, (burst.get(key) ?? 0) + 1);
        turns += 1;
        if (reply.sessionId) sessions.set(sessKey, reply.sessionId);

        const text = (reply.text ?? '').trim();
        if (text.length === 0) continue; // silent turn: drains without a post

        if (lastPost.get(sessKey) === text) {
          logger.warn(`room ${key}: echo from ${participant.handle} suppressed`);
          continue; // break the ping-pong: same reply again, do not re-route
        }
        lastPost.set(sessKey, text);

        try {
          await sendAs(room, { handle: participant.handle, text });
        } catch (error) {
          logger.error(`room ${key}: sendAs for ${participant.handle} failed: ${String(error)}`);
        }

        // Masked mode re-routes internally: there is no separate gateway per
        // persona, so a peer only "hears" a reply if we enqueue the next hop.
        const parsed = parseMentions(text, room.participants, {
          self: participant,
          maxMentions: room.maxMentions,
        });
        const followups = parsed.all
          ? room.participants.filter((p) => p.agentId !== participant.agentId)
          : parsed.targets;
        for (const target of followups) {
          const agentId = target.agentId;
          if (!agentId) continue;
          backlog.push({ fromHandle: participant.handle, text, toAgentId: agentId });
        }
      }
    } finally {
      processing.delete(key);
    }
    return turns;
  }

  return {
    async isRoom(provider, channelId): Promise<boolean> {
      return isRoomChannel(sdk, provider, channelId);
    },
    async submitMessage(provider, channelId, fromHandle, text): Promise<RoomSubmitResult> {
      const key = conversationKey(provider, channelId);
      const rooms = await loadRooms(sdk);
      const room = rooms[key];
      if (!room) return { status: 'no-room', targets: 0, turns: 0, human: false };

      const parsed = parseMentions(text, room.participants, {
        maxMentions: room.maxMentions,
      });
      const targets = parsed.all ? room.participants.slice() : parsed.targets;
      if (targets.length === 0) {
        return { status: 'no-target', targets: 0, turns: 0, human: parsed.human };
      }

      const backlog = queues.get(key) ?? [];
      for (const target of targets) {
        const agentId = target.agentId;
        if (!agentId) continue;
        backlog.push({ fromHandle, text, toAgentId: agentId });
      }
      queues.set(key, backlog);
      // A human message re-arms the burst counter — the only thing that does.
      burst.set(key, 0);

      if (processing.has(key)) {
        return { status: 'queued', targets: targets.length, turns: 0, human: parsed.human };
      }
      const turns = await drain(key);
      return { status: 'drained', targets: targets.length, turns, human: parsed.human };
    },
  };
}
