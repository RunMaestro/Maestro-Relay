/**
 * Discord multi-agent rooms — bot-pool config loader (Phase 1).
 *
 * Loads N real, separate Discord bot identities from the environment so each
 * persona in a room is a genuine bot account (native `@`-pinging between them).
 * This module holds ONLY strings — it must never import the Discord client
 * library (the kernel-purity rule in CLAUDE.md; this is the pure config seam
 * that the Discord-specific multi-client manager consumes in later phases).
 *
 * Encoding (see `.env.example` / docs/plans/multi-agent-rooms-real-bots.md §Phase 1):
 *   - RECOMMENDED — indexed env vars, one discrete secret per token:
 *       DISCORD_ROOM_BOT_<n>_TOKEN        (secret)
 *       DISCORD_ROOM_BOT_<n>_CLIENT_ID    (= bot user id / application id)
 *       DISCORD_ROOM_BOT_<n>_NAME         (persona / @handle)
 *       DISCORD_ROOM_BOT_<n>_AVATAR_URL   (optional)
 *       DISCORD_ROOM_BOT_COUNT=<n>
 *   - FALLBACK — a single JSON blob DISCORD_ROOM_BOTS=[{...}] (used only when
 *     DISCORD_ROOM_BOT_COUNT is unset).
 *
 * Loaded lazily (called at provider `start()`, not import time) mirroring the
 * `discordConfig` getter style in `config.ts`, so a deployment with no room-bot
 * env set gets `[]` and NEVER throws — a single-agent Discord bridge is unaffected.
 *
 * Bindings key on `slot` / `clientId`, NEVER on the token value, so rotating a
 * token never orphans a room.
 */

/** One real Discord bot identity in the room pool. Strings only — no client-library types. */
export interface RoomBotIdentity {
  /** Stable slot id (e.g. `"1".."6"`); bindings key on this, never on the token. */
  slot: string;
  /** Bot token (secret). Never logged, never persisted to the DB. */
  token: string;
  /** Application id == bot user id; doubles as the native-mention target `<@clientId>`. */
  clientId: string;
  /** Default persona display name / `@handle`. */
  name: string;
  /** Optional portal avatar URL. */
  avatarUrl?: string;
}

/**
 * Docs anchor for the manual per-bot onboarding flow. Kept as a constant so the
 * error copy below and any future help text point at the same section.
 */
export const ROOM_BOT_ONBOARDING_DOC_REF =
  'docs/discord.md § Multi-agent rooms → onboarding checklist';

/**
 * User-facing error when `/room invite` (Phase 6) can't bind an agent because
 * every configured room-bot slot is already taken — or none are configured at
 * all. Exported so Phase 6's `/room` command reuses this exact wording instead
 * of re-inventing the pointer to the manual provisioning steps.
 */
export const NO_FREE_ROOM_BOT_SLOT_ERROR =
  `No free room-bot slot — see ${ROOM_BOT_ONBOARDING_DOC_REF} to provision another bot.`;

/**
 * Discord reserves usernames containing these substrings. A room persona name
 * doubles as an `@handle`, so we apply the same rule the baseline `sanitizeHandle`
 * enforces (docs/plans/multi-agent-rooms.md §Phase 1).
 */
const RESERVED_NAME_SUBSTRINGS = ['discord', 'clyde'];

/** Max handle length, matching the baseline handle rules (Discord/Slack username caps). */
const MAX_NAME_LENGTH = 80;

function fail(slot: string, detail: string): never {
  throw new Error(`Invalid Discord room bot config for slot "${slot}": ${detail}`);
}

/**
 * Validate a single identity's fields, throwing a clear startup error that names
 * the offending slot. Returns a normalized (trimmed) identity.
 */
function validateIdentity(raw: RoomBotIdentity): RoomBotIdentity {
  const slot = String(raw.slot ?? '').trim();
  if (!slot) {
    throw new Error('Invalid Discord room bot config: entry is missing a non-empty "slot"');
  }

  const token = String(raw.token ?? '').trim();
  if (!token) fail(slot, 'token is empty');

  const clientId = String(raw.clientId ?? '').trim();
  if (!clientId) fail(slot, 'clientId is empty');
  if (!/^\d+$/.test(clientId)) {
    fail(slot, `clientId "${clientId}" must be a numeric Discord snowflake`);
  }

  const name = String(raw.name ?? '').trim();
  if (!name) fail(slot, 'name is empty');
  if (name.length > MAX_NAME_LENGTH) {
    fail(slot, `name exceeds ${MAX_NAME_LENGTH} characters`);
  }
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    fail(slot, `name "${name}" must be a valid @handle (letters, numbers, underscore only)`);
  }
  const lowerName = name.toLowerCase();
  for (const bad of RESERVED_NAME_SUBSTRINGS) {
    if (lowerName.includes(bad)) {
      fail(slot, `name "${name}" contains the reserved substring "${bad}"`);
    }
  }

  const avatarUrl = raw.avatarUrl != null ? String(raw.avatarUrl).trim() : undefined;

  return {
    slot,
    token,
    clientId,
    name,
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

/** Read the indexed `DISCORD_ROOM_BOT_<n>_*` vars for n = 1..count. */
function loadIndexed(count: number): RoomBotIdentity[] {
  const bots: RoomBotIdentity[] = [];
  for (let n = 1; n <= count; n++) {
    const slot = String(n);
    const prefix = `DISCORD_ROOM_BOT_${n}_`;
    const token = process.env[`${prefix}TOKEN`];
    const clientId = process.env[`${prefix}CLIENT_ID`];
    const name = process.env[`${prefix}NAME`];
    const avatarUrl = process.env[`${prefix}AVATAR_URL`];

    if (!token) fail(slot, `${prefix}TOKEN is not set`);
    if (!clientId) fail(slot, `${prefix}CLIENT_ID is not set`);
    if (!name) fail(slot, `${prefix}NAME is not set`);

    bots.push(
      validateIdentity({
        slot,
        token,
        clientId,
        name,
        ...(avatarUrl ? { avatarUrl } : {}),
      }),
    );
  }
  return bots;
}

/** Parse the `DISCORD_ROOM_BOTS` JSON-blob fallback. */
function loadJsonBlob(rawJson: string): RoomBotIdentity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(
      `DISCORD_ROOM_BOTS is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('DISCORD_ROOM_BOTS must be a JSON array of bot identities');
  }
  return parsed.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`DISCORD_ROOM_BOTS[${i}] is not an object`);
    }
    return validateIdentity(entry as RoomBotIdentity);
  });
}

/**
 * Lazily load the Discord room bot pool from the environment.
 *
 * Resolution order:
 *   1. `DISCORD_ROOM_BOT_COUNT` set → read indexed vars for n = 1..count.
 *   2. else `DISCORD_ROOM_BOTS` set → parse the JSON-blob fallback.
 *   3. else → return `[]` (no room bots; deployment unaffected).
 *
 * Throws a clear startup error — naming the offending slot — on any invalid
 * entry, or on a duplicate slot across the pool.
 */
export function loadRoomBots(): RoomBotIdentity[] {
  const countRaw = process.env.DISCORD_ROOM_BOT_COUNT?.trim();
  const jsonRaw = process.env.DISCORD_ROOM_BOTS?.trim();

  let bots: RoomBotIdentity[];
  if (countRaw) {
    const count = Number(countRaw);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(
        `DISCORD_ROOM_BOT_COUNT must be a non-negative integer, got "${countRaw}"`,
      );
    }
    bots = loadIndexed(count);
  } else if (jsonRaw) {
    bots = loadJsonBlob(jsonRaw);
  } else {
    return [];
  }

  // Enforce unique slots across the whole pool (indexed vars are inherently
  // unique, but the JSON fallback can carry duplicates).
  const seen = new Set<string>();
  for (const bot of bots) {
    if (seen.has(bot.slot)) {
      fail(bot.slot, 'duplicate slot (each room bot must use a unique slot)');
    }
    seen.add(bot.slot);
  }

  return bots;
}
