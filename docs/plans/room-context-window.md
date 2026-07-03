# Room context-window onboarding

Ported from **Maestro PR #1157** (`src/shared/crossAgentContext.ts`). When a bot
joins a room mid-conversation, it should get a *windowed transcript* of the
room-so-far — not just the preamble + the single trigger message.

## What was ported (pure, transport-agnostic only)

`src/core/room/contextWindow.ts` — dependency-free kernel TS:

- `type ContextWindowStrategy` — `full | recent-turns | recent-messages`.
- `inferContextStrategy(message)` — natural-language hints in the trigger
  (`"the last 5 messages"`, `"share the last N"`, `"this thread"`, `"most
  recent"`) narrow the slice; no hint → `full`.
- `selectContextWindow(logs, strategy)` + `tailByConversationalCount` /
  `isConversational` — tail-slice keeping interleaved non-conversational entries
  for coherence; fewer-than-N falls back to the whole transcript.
- `DEFAULT_RECENT_TURNS = 5`.

**Deliberately NOT ported:** the source's `@mention` grammar
(`parseAgentMentions` / `scanMentionSpans` from `mentionPatterns.ts`). The room
already owns its addressing grammar in `protocol.ts` (`parseMentions` against
handles). `contextWindow.ts` only does a *local* `@handle` strip (a copy of the
handle-char shape, not an import) so a handle in the prose can't masquerade as a
"recent" hint.

**Adapted to our source vocabulary:** `TranscriptEntryLike.source` is
`'human' | 'bot'` (matching `RoomSubmitOptions.fromKind`), both conversational —
not Maestro's `'user' | 'ai'`. Any other source is treated as non-conversational
context (kept in-range, never counted).

## Wiring point

`src/core/room/bus.ts`:

- An in-memory per-room ring buffer (`transcripts`, cap `TRANSCRIPT_CAP = 200`)
  records each **processed** message (`appendTranscript`, evict-oldest).
- In `processNext`, before the `maestro.send`: if the acting participant has **no
  maestro session yet** (`!self.session_id`) and history exists, prepend a
  windowed transcript block (`renderTranscript`). Strategy defaults to
  `recent-turns` of `DEFAULT_RECENT_TURNS`; a hint in the trigger
  (`inferContextStrategy`) overrides it. The window is taken **before** the
  current message is recorded, so the trigger isn't duplicated in its own block.
- `halt()` clears the buffer alongside the queue.

## Documented gaps (best-effort, not durable)

1. **In-memory only.** The buffer lives in the bus process; a restart loses room
   history, so a bot invited after a restart onboards with whatever has flowed
   since. Acceptable for an onboarding aid; a durable transcript would need a
   `room_messages` table.
2. **Addressed-only.** Only messages that reach `submitMessage` are recorded, and
   the Discord room listener (`roomMessageCreate.ts`) gates on the mention
   (`message.mentions.users.has(thisBotUserId)`), so **unaddressed room chatter
   never reaches the bus** and is absent from the window. Capturing full
   room history would mean feeding every room message to a transcript sink — a
   larger change to the inbound path, deferred.
3. **Session-scoped trigger.** Onboarding fires on the participant's *first*
   processed turn (no session). A `/room reset` clears sessions, so the next turn
   re-onboards from the current buffer — intentional.
