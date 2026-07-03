/**
 * Pure heuristics for windowing a room transcript when a bot joins
 * mid-conversation.
 *
 * Ported from Maestro PR #1157 (`src/shared/crossAgentContext.ts`), keeping only
 * the transport-agnostic, side-effect-free parts: it decides *how much* of the
 * room-so-far to hand a persona that has no context yet. The default is the
 * entire transcript; natural-language hints in the triggering message ("the last
 * 5 messages", "this thread", "share the last N") narrow the slice.
 *
 * Every export here is a pure function — no IO, no logger, no globals, no
 * provider client libraries — so it unit-tests in isolation and stays inside the
 * provider-agnostic kernel. Deliberately NOT ported from the source: its
 * `@mention` grammar (`parseAgentMentions` / `scanMentionSpans`). The room owns
 * its own addressing grammar in `protocol.ts` (`parseMentions` against handles);
 * this file only needs a lightweight local strip so a `@handle` in the prose
 * cannot masquerade as a "recent" hint, and never imports the room protocol.
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * How large a slice of the room transcript to forward.
 * - `full`            — the entire transcript, verbatim (default)
 * - `recent-turns`    — the last N author↔author pairs
 * - `recent-messages` — the last N conversational (human/bot) messages
 */
export type ContextWindowStrategy =
  | { kind: 'full' }
  | { kind: 'recent-turns'; turns: number }
  | { kind: 'recent-messages'; messages: number };

/**
 * Minimal shape the window heuristics read from a transcript entry: just the
 * `source` discriminant. Our room transcript entries classify their author with
 * the same vocabulary as `RoomSubmitOptions.fromKind` — `'human'` for a person,
 * `'bot'` for a peer relay bot — and both are *conversational* (they count
 * against the window). Any other source (a future `'system'` / `'tool'` marker)
 * is treated as non-conversational context: it is kept inside the window range
 * for coherence but never counted. A richer entry type (carrying handle + text)
 * satisfies this, so callers get their own entry type back via inference.
 */
export interface TranscriptEntryLike {
  source: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default window for soft "recent" hints (and room onboarding) with no explicit count. */
export const DEFAULT_RECENT_TURNS = 5;

/**
 * Local handle-token strip. Matches the room's safe handle characters
 * (`sanitizeHandle` output) — a deliberate copy of the shape, NOT an import of
 * the protocol, so this file stays dependency-free. Used only to blank `@handle`
 * tokens before hint matching so they cannot be mistaken for prose.
 */
const HANDLE_TOKEN = /@[A-Za-z0-9_-]+/g;

// ============================================================================
// CONTEXT STRATEGY INFERENCE
// ============================================================================

/** Explicit count with a unit: "last 5 messages", "last 3 turns", "last 2 exchanges". */
const EXPLICIT_UNIT = /\blast\s+(\d+)\s+(messages?|turns?|exchanges?)\b/;
/**
 * Unit-less share: "share the last 10". Captures the word immediately after the
 * count (group 2, if any) so we can reject a competing *non-conversational* noun
 * — "share the last 2 commits" must NOT force a tiny window (see `inferContextStrategy`).
 */
const SHARE_LAST = /\bshare\s+(?:the\s+)?last\s+(\d+)(?:\s+([a-z]+))?/;
/**
 * Function/connector words that may legitimately follow a unit-less "share the
 * last N" without naming a competing noun ("share last 4 with them"). Anything
 * NOT in this set (e.g. "commits", "files") is read as a non-conversational noun,
 * so the unit-less share is declined and we fall back to the full transcript.
 */
const UNITLESS_SHARE_CONNECTORS = new Set([
  'with', 'to', 'for', 'from', 'of', 'in', 'on', 'and', 'so', 'then',
  'please', 'here', 'there', 'now', 'again', 'them', 'us', 'it', 'plz',
]);
/**
 * Conversational nouns that anchor a soft "recent"/"most recent" hint to the
 * dialogue itself. Bare "most recent" (as in "the most recent commit") must NOT
 * match — only "most recent message(s)/turn(s)/exchange(s)/thread/conversation/…".
 */
const CONV_NOUN = 'context|conversation|discussion|thread|topic|matter|exchanges?|messages?|turns?';
/** Soft "recent" hints that imply a small trailing window — bound to conversational vocab. */
const SOFT_HINT = new RegExp(
  `most recent (?:${CONV_NOUN})|this (?:matter|topic|thread|conversation|discussion)|` +
    `recent (?:${CONV_NOUN})|pull .* in on this`,
);

/** Blank every `@handle` token so hint matching runs against prose, not addressing. */
function stripMentions(message: string): string {
  return message.replace(HANDLE_TOKEN, ' ');
}

/**
 * Infer a context-window strategy from a message.
 *
 * Matching is case-insensitive and runs against the message with its `@handle`
 * tokens stripped out. Priority order (first hit wins):
 *   1. An explicit count with a unit → recent-messages / recent-turns.
 *   1b. A unit-less "share the last N" → recent-messages.
 *   2. A soft "recent" hint → recent-turns of DEFAULT_RECENT_TURNS.
 *   3. Otherwise → full transcript.
 *
 * An explicit count always wins over a soft hint because it is checked first.
 */
export function inferContextStrategy(message: string): ContextWindowStrategy {
  const cleaned = stripMentions(message).toLowerCase();

  // Priority 1: explicit count with an explicit unit.
  const unitMatch = cleaned.match(EXPLICIT_UNIT);
  if (unitMatch) {
    const count = Number.parseInt(unitMatch[1], 10);
    if (count > 0) {
      // "message(s)" → messages; "turn(s)" / "exchange(s)" → turns.
      return unitMatch[2].startsWith('message')
        ? { kind: 'recent-messages', messages: count }
        : { kind: 'recent-turns', turns: count };
    }
  }

  // Priority 1b: "share (the) last N" with no unit → messages. A conversational
  // unit ("share the last 2 messages") was already caught by priority 1; here a
  // trailing noun can only be a competing non-conversational one ("share the last
  // 2 commits"), so we accept ONLY when nothing — or a mere connector word —
  // follows the count, and otherwise fall through (conservatively) to `full`.
  const shareMatch = cleaned.match(SHARE_LAST);
  if (shareMatch) {
    const count = Number.parseInt(shareMatch[1], 10);
    const trailing = shareMatch[2];
    if (count > 0 && (trailing === undefined || UNITLESS_SHARE_CONNECTORS.has(trailing))) {
      return { kind: 'recent-messages', messages: count };
    }
  }

  // Priority 2: soft "recent" hints → a sensible default window of turns.
  if (SOFT_HINT.test(cleaned)) {
    return { kind: 'recent-turns', turns: DEFAULT_RECENT_TURNS };
  }

  // Priority 3: everything else → the full transcript.
  return { kind: 'full' };
}

// ============================================================================
// CONTEXT WINDOW SELECTION
// ============================================================================

/** Conversational entries are the ones we count against; the rest are context. */
function isConversational(entry: TranscriptEntryLike): boolean {
  return entry.source === 'human' || entry.source === 'bot';
}

/**
 * Tail-slice `logs` so the result contains the last `count` conversational
 * (human/bot) entries, keeping any interleaved non-conversational entries that
 * fall inside that bounding range so the slice stays coherent. If there are
 * fewer than `count` conversational entries, the whole transcript is returned.
 */
function tailByConversationalCount<T extends TranscriptEntryLike>(logs: T[], count: number): T[] {
  if (count <= 0) return [];

  let seen = 0;
  for (let i = logs.length - 1; i >= 0; i--) {
    if (isConversational(logs[i])) {
      seen++;
      if (seen === count) return logs.slice(i);
    }
  }

  // Fewer conversational entries than requested — forward everything.
  return logs.slice();
}

/**
 * Select the slice of `logs` to forward for the given strategy.
 *
 * - `full`            → a shallow clone of every entry (never the input array
 *   reference, so callers can't mutate the source store through the result).
 * - `recent-messages` → the last N human/bot entries plus any interleaved
 *   non-conversational entries that fall inside that window.
 * - `recent-turns`    → the last N author↔author pairs, treated as 2*N
 *   conversational entries (a turn ~= a pair), same coherence rule.
 *
 * Generic over the entry type so a `T[]` in returns a `T[]` out.
 */
export function selectContextWindow<T extends TranscriptEntryLike>(
  logs: T[],
  strategy: ContextWindowStrategy,
): T[] {
  switch (strategy.kind) {
    case 'full':
      return logs.slice();
    case 'recent-messages':
      return tailByConversationalCount(logs, strategy.messages);
    case 'recent-turns':
      return tailByConversationalCount(logs, strategy.turns * 2);
  }
}
