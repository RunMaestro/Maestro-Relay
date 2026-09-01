# Plan: GitHub-style callout embeds for outbound messages

**Status:** proposed (planning only — no implementation yet)
**Author:** Maestro-Relay
**Scope:** Discord + Slack (Teams = automatic text fallback, optional rich follow-up)

---

## 1. Goal

Outbound agent/relay text often contains GitHub-flavored **alert callouts**:

```markdown
> [!CAUTION]
> This will delete production data.
```

Today every outbound message is sent as a raw string, so Discord/Slack render this
as a plain grey blockquote with the literal text `[!CAUTION]` — no color, no icon,
no signal. We want each `> [!TYPE]` block to render as a **colored block** (Discord
embed / Slack colored attachment), **interleaved in order** with the surrounding
prose.

Chris has explicitly accepted that **a callout may go out as its own message**
(multiple messages per response is fine), which sidesteps the hard problem of
mixing an embed *inside* one Discord message body.

### Hard requirements (from the request)

1. **Auto-detect, no opt-in.** Every `> [!TYPE]` block becomes a callout
   automatically. No flag, **no change to `/api/send` callers**.
2. **New splitter** (`src/core/callouts.ts`): Markdown → `Segment[]` where a
   segment is `{ kind: 'text' | 'callout', variant?, title?, body }`. Robust to:
   multi-line `>` blocks, code fences **inside** a callout, multiple callouts, a
   callout at the very start/end, and **normal blockquotes** (`> ` with no
   `[!TYPE]`) which must pass through untouched as text.
3. **Sequential order.** Send segments one-by-one (`await` each) so Discord/Slack
   preserve ordering. Text segments still flow through `splitMessage()`; callout
   segments become an embed (Discord) / colored attachment (Slack).
4. **Color/emoji map** (GitHub palette): see §4.
5. **Slack:** one message per callout carrying **one** colored attachment
   (`color`) — this fixes the "attachments pile up at the bottom" problem because
   each callout message owns its attachment at the right point in the transcript.
6. **Tests:** unit test for the splitter + adapter test (N segments → N sends,
   embed/attachment fields correct, plain blockquotes stay text).
7. **Risks/edge-cases** named: §8.

---

## 2. Current architecture (verified against source)

There are **three** outbound paths that turn agent/relay text into provider
`send()` calls. The color/callout logic must sit at a seam common to the ones we
target.

| Path | File / line | Transform applied today | Notes |
|------|-------------|-------------------------|-------|
| **Push** (`/api/send`) | `src/core/api.ts:133-176` | `split(body.message)` only — **no `renderTables`** | retry×3 + `RateLimitError` backoff per part |
| **Agent reply** | `src/core/queue.ts:195-198` | `split(renderTables(result.response))` | simple `await` per part, no retry |
| **Room persona** | `src/core/room/bus.ts:489-491` | `renderNativeMentions(renderTables(...))` → `split` → `sendAs` | out of scope for v1 |

The **provider seam** is `provider.send(target, msg: OutgoingMessage)` (and
`sendAs` for rooms). Every path ultimately loops `for (part of parts) send({text})`.

Key existing building blocks we will reuse (do **not** reinvent):

- `src/core/splitMessage.ts` — `splitMessage(text, max)` (fence-aware chunking).
- `src/core/fences.ts` — `parseFenceLine`, `closesFence`, `Fence`. **This is how
  `renderTables` stays fence-aware; the callout splitter must use the same primitives.**
- `src/core/renderTables.ts` — `renderTables(text)` (already the model for a pure,
  provider-free, fence-aware line scanner — mirror its structure).
- `src/providers/discord/embed.ts` — `clampDescription` (`EMBED_DESCRIPTION_MAX =
  4096`), `clampTitle` (`EMBED_TITLE_MAX = 256`).
- `src/core/types.ts` — `OutgoingMessage` (currently `{ text; mention? }`).

---

## 3. Design

### 3.1 Data model — extend `OutgoingMessage` (not a new provider method)

Add an optional `callout` payload to `OutgoingMessage`. Rationale: a new
`sendCallout()` method would force every provider to reimplement thread/channel
resolution (Slack `thread_ts`, Discord thread-vs-channel, Teams conversation
ref). Extending the existing message type keeps **one** send entry point per
provider and gives **free graceful degradation**: a provider that ignores
`msg.callout` still posts `msg.text`.

```ts
// src/core/types.ts
export type CalloutVariant = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

export interface CalloutPayload {
  variant: CalloutVariant;
  /** Optional custom heading; when absent the provider derives "<emoji> <Label>". */
  title?: string;
  /** Callout body markdown (the `>`-stripped lines). May be empty. */
  body: string;
}

export interface OutgoingMessage {
  text: string;          // for a callout: the reconstructed raw blockquote (fallback)
  mention?: boolean;
  callout?: CalloutPayload;  // present → render rich; absent → plain text as today
}
```

**Fallback contract:** when `toOutgoing` (§3.3) emits a callout message, it also
sets `text` to the reconstructed `> [!TYPE]\n> body…` markdown. Any provider that
does not special-case `.callout` (Teams today) posts that string — no worse than
current behavior, and lossless.

### 3.2 The splitter — `src/core/callouts.ts` (pure, provider-free)

Mirror `renderTables`'s structure: a top-level, fence-aware line scanner.

```ts
export interface CalloutSegment {
  kind: 'callout';
  variant: CalloutVariant;
  title?: string;   // reserved; not populated from GitHub syntax in v1 (see §8)
  body: string;     // `>`-stripped body lines, joined by '\n'
}
export interface TextSegment { kind: 'text'; body: string; }
export type Segment = TextSegment | CalloutSegment;

export function splitCallouts(text: string): Segment[];
```

**Algorithm (line scan, fence-aware at the top level):**

1. Split into lines. Track an open top-level fence with `parseFenceLine` /
   `closesFence` (identical bookkeeping to `renderTables`). **While a top-level
   fence is open, never start a callout** — this prevents a `> [!NOTE]` line that
   lives *inside* a fenced code block from being mistaken for a callout.
2. When not inside a fence and the current line is a **callout opener**, flush any
   buffered text as a `TextSegment`, then consume the contiguous blockquote run.
3. Otherwise append the line to the text buffer.
4. Flush the final text buffer. Never emit empty text segments (a callout at the
   very start/end therefore produces no stray empty segment).

**Callout opener test:** after stripping ≤3 leading spaces, the line starts with
`>`, and its content (after the `>` and one optional space) matches
`^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$` (uppercase, GitHub-exact — see
§8 decision on case/trailing text).

**Blockquote-run consumption:** from the opener, keep consuming while the line
(after ≤3 spaces) starts with `>`. A bare `>` (empty body line) is part of the
run; the run ends at the first non-`>` line or a truly blank line. Strip the
`^ {0,3}> ?` prefix from each line. The **first** (marker) line is dropped from
the body; the remainder is the `body`. A fenced block *inside* the quote (each
line `>`-prefixed) is collected fine and, once `>`-stripped, becomes a real fence
in the body → renders as code in the embed/attachment.

**Plain blockquote pass-through:** `> just a quote` fails the opener test, so it
stays in the text buffer and is emitted verbatim inside a `TextSegment`. ✅ Req #2.

### 3.3 Composition helper — `toOutgoing`

To keep the "mention only on the very first outbound message" rule correct across
segments **and** avoid duplicating segmentation in both callers, add one composer
in `src/core/callouts.ts` that returns the ordered list of `OutgoingMessage`s:

```ts
export function toOutgoing(
  text: string,
  opts: {
    split: (t: string) => string[];        // injected splitMessage
    renderTables: (t: string) => string;    // injected renderTables
    mention?: boolean;
  },
): OutgoingMessage[];
```

Behavior:

- `segments = splitCallouts(text)`.
- For a `TextSegment`: `split(renderTables(body))` → one `OutgoingMessage`
  `{ text: part }` per chunk.
- For a `CalloutSegment`: **one** `OutgoingMessage` `{ text: rawBlockquote(seg),
  callout: { variant, body } }`. (Optionally run `renderTables` on the callout
  `body` too — see §8 decision.)
- Set `mention: true` on **exactly the first** message in the returned array (when
  `opts.mention`), so a multi-segment push pings once. All others `mention: false`.

Unit-testable in isolation with stub `split`/`renderTables`.

### 3.4 Shared callout metadata

```ts
// src/core/callouts.ts
export const CALLOUT_META: Record<CalloutVariant, { label: string; emoji: string; hex: string }> = {
  NOTE:      { label: 'Note',      emoji: 'ℹ️', hex: '#1f6feb' },
  TIP:       { label: 'Tip',       emoji: '💡', hex: '#238636' },
  IMPORTANT: { label: 'Important', emoji: '❗', hex: '#8957e5' },
  WARNING:   { label: 'Warning',   emoji: '⚠️', hex: '#d29922' },
  CAUTION:   { label: 'Caution',   emoji: '🛑', hex: '#da3633' },
};
```

Provider-agnostic *data*; each provider converts to its own color unit.
Default title = `` `${emoji} ${label}` ``.

### 3.5 Caller changes

**`src/core/api.ts` (push path).** Replace the `const parts = split(body.message)`
loop. Refactor the existing retry/backoff body into a local `sendPart(msg:
OutgoingMessage)` closure, then:

```ts
const messages = toOutgoing(body.message, { split, renderTables, mention: !!body.mention });
for (const m of messages) { await sendPart(m); }   // retry/RateLimitError logic unchanged, per message
```

No change to `SendRequest` or any caller of `/api/send`. ✅ Req #1.
(**Decision needed** — §8 #6 — whether to also start applying `renderTables` to
push text; today the push path does not. Wrapping text segments in `renderTables`
here would be a small, arguably-desirable behavior change.)

**`src/core/queue.ts` (agent-reply path).** Replace lines 195-198:

```ts
for (const m of toOutgoing(result.response, { split, renderTables, mention: false })) {
  await provider.send(target, m);
}
```

This preserves the existing `renderTables` behavior for text and adds callouts.

**Room path (`bus.ts`) is explicitly out of scope for v1** (personas + native
mentions + `sendAs` interaction needs its own design). Note as follow-up.

### 3.6 Provider rendering

**Discord — `src/providers/discord/adapter.ts` `send()` (~line 277) and
`postThrough()`.** When `msg.callout` is set, build an embed instead of a bare
string:

```ts
const meta = CALLOUT_META[msg.callout.variant];
const embed = {
  title: clampTitle(msg.callout.title ?? `${meta.emoji} ${meta.label}`),
  description: clampDescription(msg.callout.body),   // 4096 limit
  color: parseInt(meta.hex.slice(1), 16),            // #1f6feb → 0x1f6feb
};
const content = (msg.mention && discordConfig.mentionUserId)
  ? `<@${discordConfig.mentionUserId}>` : undefined;
await channel.send({ content, embeds: [embed] });
```

- Empty `body` → embed with title only (valid; Discord requires title **or**
  description). ✅
- Mention rides in `content` so the ping still fires alongside the embed.
- Same treatment in `postThrough()` for parity, but room `sendAs` is not yet a
  caller of callouts, so this can be a thin addition or deferred.

**Slack — `src/providers/slack/adapter.ts` `send()` (~line 317).** When
`msg.callout` is set, post one message with one attachment, reusing the **same**
channel/thread resolution already in `send()`:

```ts
const meta = CALLOUT_META[msg.callout.variant];
const attachments = [{
  color: meta.hex,                                   // hex string → colored left bar
  title: msg.callout.title ?? `${meta.emoji} ${meta.label}`,
  text: msg.callout.body,                            // mrkdwn
}];
const mentionText = (msg.mention && slackConfig.mentionUserId)
  ? `<@${slackConfig.mentionUserId}>` : '';
await this.client.chat.postMessage({ channel/thread_ts…, text: mentionText, attachments });
```

Each callout is its own message → its attachment sits at the correct point in the
thread, solving the pile-up. ✅ Req #5.

**Teams — no change required for v1.** `send()` reads `msg.text` and ignores
unknown fields, so a callout automatically degrades to its raw-markdown blockquote
(rendered with `textFormat: 'markdown'`). Optional follow-up: an Adaptive Card
with a colored container. Note in `docs/teams.md`.

---

## 4. Color / emoji map (canonical)

| Variant | Emoji | Hex | Discord int |
|---------|-------|------|-------------|
| NOTE | ℹ️ | `#1f6feb` | `2059499` |
| TIP | 💡 | `#238636` | `2328118` |
| IMPORTANT | ❗ | `#8957e5` | `8984549` |
| WARNING | ⚠️ | `#d29922` | `13801762` |
| CAUTION | 🛑 | `#da3633` | `14300723` |

Embed/attachment **title** = `"<emoji> <Label>"`; **body** = the callout markdown
via `clampDescription` (Discord) / `text` (Slack).

---

## 5. Files touched

| File | Change |
|------|--------|
| `src/core/callouts.ts` | **new** — `splitCallouts`, `toOutgoing`, `CALLOUT_META`, types |
| `src/core/types.ts` | add `CalloutVariant`, `CalloutPayload`, `OutgoingMessage.callout` |
| `src/core/api.ts` | segment the push body via `toOutgoing`; wrap retry in `sendPart` |
| `src/core/queue.ts` | replace reply send-loop with `toOutgoing` |
| `src/providers/discord/adapter.ts` | render embed when `msg.callout` (in `send`, optionally `postThrough`) |
| `src/providers/slack/adapter.ts` | render colored attachment when `msg.callout` |
| `docs/discord.md`, `docs/slack.md`, `docs/api.md` | document callout rendering |
| `.env.example` | no new vars (none needed) |

No new dependencies.

---

## 6. Testing plan

Follow existing patterns (`node --test`; `src/__tests__/embed.test.ts`,
`split-mentions.test.ts`, `renderTables.test.ts`, `mockProvider.test.ts`).

### 6.1 `src/__tests__/callouts.test.ts` (splitter unit tests)

- Single callout → one `callout` segment, correct `variant`, `body` = stripped lines.
- Prose → callout → prose ⇒ `[text, callout, text]` **in order**.
- Callout at the very **start** and very **end** ⇒ no empty text segments.
- **Multiple** callouts, different variants.
- **Multi-line** body; bare `>` (empty) body line preserved.
- **Fence inside** the callout — `>`-quoted ` ```bash ` block survives in `body`.
- **Top-level fence containing `> [!NOTE]`** ⇒ stays text (NOT a callout). ← key robustness case.
- **Plain blockquote** `> quote` (no `[!TYPE]`) ⇒ single text segment, verbatim.
- Unknown tag `> [!FOOBAR]` ⇒ text (only the five variants match).
- `toOutgoing`: mention set on first message only across mixed segments;
  text segments run through injected `split`/`renderTables`; callout carries
  reconstructed `text` fallback + `callout` payload.

### 6.2 Adapter tests

- **Discord** (`src/__tests__/discord-callout.test.ts`, mock `channel.send`):
  input with 1 callout + 2 prose blocks ⇒ **N `send` calls in order**; the callout
  call passes `{ embeds: [{ title, description, color }] }` with the right color
  int and title; prose calls pass strings; a plain blockquote yields a string
  (no embed). Assert 4096 clamp on an oversized body.
- **Slack** (`src/__tests__/slack-callout.test.ts`, mock `chat.postMessage`):
  callout ⇒ one `postMessage` with `attachments:[{ color:'#…', title, text }]`;
  thread routing (`thread_ts`) preserved; N segments → N posts in order.
- **Kernel-level** (extend `mockProvider.test.ts` style): a `MockProvider`
  recording `msg.callout` confirms `toOutgoing` wiring end-to-end via the queue.

---

## 7. Rollout / sequencing

1. `types.ts` + `callouts.ts` + `callouts.test.ts` (pure core, no provider risk).
2. Wire `queue.ts` and `api.ts` through `toOutgoing` (text-only paths still pass —
   callout messages just fall back to text until providers render them).
3. Discord embed rendering + test.
4. Slack attachment rendering + test.
5. Docs.
6. (Follow-up) room `bus.ts` + Teams Adaptive Card.

Each step is independently green; providers degrade gracefully between steps.

---

## 8. Risks & edge cases

1. **Rate limits from many segments.** N callouts ⇒ N messages ⇒ N API calls.
   `api.ts` already retries with `RateLimitError` backoff per message, so the push
   path is covered; `queue.ts` does not retry (unchanged risk — a burst of
   callouts could 429). *Mitigation:* rely on existing api.ts backoff; consider a
   small inter-segment delay only if observed. Document that callout-heavy output
   fans out into multiple messages.
2. **Discord embed description 4096 / title 256.** Long callout bodies are clamped
   via `clampDescription`/`clampTitle` (lossy, ellipsized). *Decision:* accept
   truncation for v1 (per request) rather than splitting one callout across
   multiple embeds. Note it.
3. **Empty / body-less callout** (`> [!NOTE]` alone). Discord: title-only embed
   (valid). Slack: attachment with color + title, empty text (valid — colored bar).
   Ensure we never send a Discord embed with neither title nor description.
4. **Interaction with fence splitting.** The splitter is fence-aware at the top
   level (reuses `fences.ts`) so a fenced block that *contains* `> [!TYPE]` is not
   misread. Callout **bodies** are not re-run through `splitMessage` (a single
   callout is one message); if a body exceeds 4096 it is clamped, not fence-split
   — acceptable, but note that a very long fenced block inside a callout loses its
   tail.
5. **Interaction with `renderTables`.** A markdown table *inside* a callout body
   would render as raw pipes in a Discord embed / Slack attachment unless we run
   `renderTables` on the body. **Decision:** run `renderTables` on callout bodies
   too (cheap, consistent with prose). Flag: embeds render the fenced ASCII table
   fine; confirm Slack attachment `text` also renders the code fence (it does via
   mrkdwn).
6. **Push path `renderTables` gap.** `api.ts` currently does **not** apply
   `renderTables` to pushed text. Routing push text through `toOutgoing` gives a
   natural place to add it. **Decision needed:** (a) keep push text as-is (only
   add callouts), or (b) also start rendering tables on pushes. Recommend (b) for
   consistency, but it is a behavior change — call out in the PR.
7. **Case sensitivity / trailing text on the marker.** GitHub matches uppercase
   `[!NOTE]` alone on the line. **Decision:** match uppercase only; a marker with
   trailing prose (`> [!NOTE] hi`) is treated as a plain blockquote (text) in v1.
   Revisit if agents emit lowercase/titled variants — `title?` in the segment
   type is reserved for that.
8. **Mention placement.** Only the first outbound message carries the mention;
   verify the ping still fires when the first message is a callout embed (Discord:
   mention in `content`; Slack: mention in top-level `text` beside the attachment).
9. **Room path unaddressed.** `bus.ts` still sends plain strings, so personas
   won't get colored callouts in v1. Intentional; listed as follow-up.

---

## 9. Open decisions for Chris

- **#6** — Should the push (`/api/send`) path also start applying `renderTables`
  (currently it doesn't), or keep it callouts-only? (Recommend: apply it.)
- **#5** — Run `renderTables` on callout **bodies**? (Recommend: yes.)
- **#7** — Uppercase-only, marker-alone matching (GitHub-exact)? (Recommend: yes.)
- **Room scope** — confirm rooms (`bus.ts`) are a follow-up, not v1.
- **Teams** — text fallback for v1, Adaptive Card later? (Recommend: yes.)
</content>
</invoke>
