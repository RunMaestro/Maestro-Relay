/**
 * The room addressing protocol — the single source of truth so the preamble,
 * the inbound mention parser, and the outbound native-mention renderer cannot
 * diverge. All three share ONE reserved-token set and ONE handle regex.
 *
 * Pure kernel: string-in / string-out, no provider client libraries. The
 * native-mention rewrite emits provider-neutral `<@id>` tokens (the ping
 * syntax the transport layer already understands); it never imports a chat
 * SDK and does no client lookup — it receives already-resolved bot user ids
 * on the participants it is handed.
 */

/** Reserved addressing tokens, recognized case-insensitively without the `@`. */
export const RESERVED = { all: 'all', human: 'human' } as const;

/**
 * Shared handle-token regex. Matches an `@` followed by a run of the safe
 * handle characters `sanitizeHandle` produces. Global + case-insensitive so a
 * single constant drives both parsing and rewriting.
 */
export const HANDLE_TOKEN = /@([A-Za-z0-9_-]+)/g;

/**
 * The participant shape the protocol operates on. Handles are the addressable
 * identity; `botUserId` is the resolved bot account id (its `clientId`) that
 * renders this agent, populated by the caller for outbound rewriting. Kept
 * self-contained (plain strings) so the protocol has no cross-module coupling.
 */
export interface Participant {
  agentId?: string;
  handle: string;
  avatarUrl?: string | null;
  /** Resolved bot account id used to fire a native ping. */
  botUserId?: string | null;
}

/** Minimal room shape the preamble needs — a display name and/or key. */
export interface PreambleRoom {
  name?: string;
  roomKey?: string;
}

export interface MentionOptions {
  /** The participant whose turn produced the text; never targeted/rewritten. */
  self?: Participant;
  /** Hard cap on how many peers a single message may address. Default 2. */
  maxMentions?: number;
}

export interface RenderOptions extends MentionOptions {
  /** Provider-configured human mention id used to expand `@human`. */
  humanMentionId?: string | null;
}

export interface ParsedMentions {
  /** Registered peers this message addresses (deduped, self-dropped, capped). */
  targets: Participant[];
  /** `@all` was present. */
  all: boolean;
  /** `@human` was present. */
  human: boolean;
}

const DEFAULT_MAX_MENTIONS = 2;

/**
 * Reduce a display name to a safe, addressable handle: keep only
 * `[A-Za-z0-9_-]`, drop the reserved provider substrings "discord"/"clyde",
 * clamp to 80 chars, and never return empty. Deterministic so callers can
 * append a short id suffix on collision.
 */
export function sanitizeHandle(name: string): string {
  let h = (name ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  h = h.replace(/discord/gi, '').replace(/clyde/gi, '');
  if (h.length > 80) h = h.slice(0, 80);
  if (h.length === 0) h = 'agent';
  return h;
}

/**
 * Build the system preamble handed to an agent on its turn. Lists the room's
 * peers by `@Handle` (excluding self) and states the addressing contract. The
 * roster is derived from the same participant list the parser matches against,
 * so a handle shown here is always one the parser will resolve.
 */
export function buildPreamble(
  room: PreambleRoom,
  self: Participant,
  participants: Participant[],
): string {
  const selfHandle = self.handle.toLowerCase();
  const peers = participants
    .filter((p) => p.handle.toLowerCase() !== selfHandle)
    .map((p) => `@${p.handle}`);
  const roster = peers.length > 0 ? peers.join(', ') : '(none yet)';
  const roomName = room.name ?? room.roomKey ?? 'this room';

  return [
    `You are @${self.handle} in room "${roomName}".`,
    `Other participants: ${roster}.`,
    'Address a peer by writing @Handle; a message with no @mention is spoken to the room.',
    'You are only invoked when you are addressed. Reply briefly.',
    'Write @human to hand the conversation back to a person.',
  ].join('\n');
}

/**
 * Parse the addressing intent out of a message. Matches `@handle` only against
 * registered participant handles (case-insensitive), recognizes the reserved
 * `@all` / `@human` tokens, dedups repeats, drops any self-mention, and caps
 * the explicit target list at `maxMentions`. Prose `@whatever` that matches no
 * registered handle is ignored.
 */
export function parseMentions(
  text: string,
  participants: Participant[],
  opts: MentionOptions = {},
): ParsedMentions {
  const maxMentions = opts.maxMentions ?? DEFAULT_MAX_MENTIONS;
  const selfHandle = opts.self?.handle.toLowerCase();
  const byHandle = new Map(participants.map((p) => [p.handle.toLowerCase(), p]));

  let all = false;
  let human = false;
  const targets: Participant[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(HANDLE_TOKEN)) {
    const lower = match[1].toLowerCase();
    if (lower === RESERVED.all) {
      all = true;
      continue;
    }
    if (lower === RESERVED.human) {
      human = true;
      continue;
    }
    if (selfHandle !== undefined && lower === selfHandle) continue; // never self
    if (seen.has(lower)) continue; // dedup
    const participant = byHandle.get(lower);
    if (participant === undefined) continue; // unregistered → prose, ignore
    seen.add(lower);
    targets.push(participant);
  }

  return { targets: targets.slice(0, maxMentions), all, human };
}

/**
 * Resolve a parsed handle (with or without a leading `@`) to the bot account id
 * of the participant that renders it, or null if the handle is unregistered or
 * has no bound bot id.
 */
export function resolveBotUserId(handle: string, participants: Participant[]): string | null {
  const lower = handle.replace(/^@/, '').toLowerCase();
  const participant = participants.find((p) => p.handle.toLowerCase() === lower);
  return participant?.botUserId ?? null;
}

/**
 * Rewrite the addressed `@Handle` tokens in an outgoing message into native
 * `<@id>` ping tokens so the transport fires a real notification:
 *  - a registered peer handle → `<@botUserId>` (only if the parser would have
 *    targeted it, so the `maxMentions` cap and self-drop apply identically);
 *  - `@human` → the configured human mention id (left literal if unconfigured);
 *  - `@all` → native mentions of every non-self participant with a bound bot id,
 *    capped at `maxMentions`;
 *  - the self handle is never rewritten; any unknown `@token` is left literal.
 *
 * Pure and provider-neutral: it emits the `<@id>` string the transport already
 * understands and performs no client lookup.
 */
export function renderNativeMentions(
  text: string,
  participants: Participant[],
  opts: RenderOptions = {},
): string {
  const maxMentions = opts.maxMentions ?? DEFAULT_MAX_MENTIONS;
  const selfHandle = opts.self?.handle.toLowerCase();

  // The authoritative explicit-target set: whatever the parser would address,
  // with the same dedup / self-drop / cap logic. Guarantees the round-trip
  // invariant that every handle we rewrite is one the parser targeted.
  const parsed = parseMentions(text, participants, {
    self: opts.self,
    maxMentions,
  });
  const targetHandles = new Set(parsed.targets.map((p) => p.handle.toLowerCase()));
  const byHandle = new Map(participants.map((p) => [p.handle.toLowerCase(), p]));

  const expandAll = (): string | null => {
    const ids = participants
      .filter((p) => selfHandle === undefined || p.handle.toLowerCase() !== selfHandle)
      .map((p) => p.botUserId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, maxMentions);
    return ids.length > 0 ? ids.map((id) => `<@${id}>`).join(' ') : null;
  };

  return text.replace(HANDLE_TOKEN, (matched, rawHandle: string) => {
    const lower = rawHandle.toLowerCase();

    if (lower === RESERVED.human) {
      return opts.humanMentionId ? `<@${opts.humanMentionId}>` : matched;
    }
    if (lower === RESERVED.all) {
      return expandAll() ?? matched;
    }
    if (selfHandle !== undefined && lower === selfHandle) return matched; // never self
    if (!targetHandles.has(lower)) return matched; // unregistered or over cap

    const botUserId = byHandle.get(lower)?.botUserId;
    return botUserId ? `<@${botUserId}>` : matched;
  });
}
