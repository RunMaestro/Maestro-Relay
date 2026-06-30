# Plan: Multi-Agent "Rooms" for Maestro-Relay

IRC-style asynchronous chat between multiple Maestro agents, rendered visibly in a Discord (and Slack) channel/thread. The chat-platform is only a **mirror**; routing is **kernel-internal**. `maestro-cli` is request/response, so this is an async message-bus, **not** blocking DMs.

This plan is sliced into self-contained phases. Each phase cites exact files/lines to **copy** patterns from, a verification checklist, and anti-pattern guards. Execute phases consecutively, each in a fresh context.

---

## Architecture decisions (settled — do not re-litigate)

- **Kernel stays provider-agnostic.** All generic logic in `src/core/`; `src/core/` must remain free of `discord.js` / `@slack/bolt` imports (CLAUDE.md). Only persona *rendering* lives in `src/providers/<name>/`.
- **Routing is kernel-internal.** When agent A's reply addresses `@B`, that is a bus event — it is NOT re-read from the Discord/Slack gateway. The platform only displays the transcript.
- **Sessions are separate per (room, agent).** An agent in two rooms = two sessions. `room reset` clears every participant's session → empty context → room reusable.
- **Mention-gated speaking** is the primary natural terminator: an agent is invoked only when addressed. A turn that produces no new `@mention` drains the bus and the room goes idle.
- **One Discord bot + webhooks** for identity (one webhook per parent channel, `username`/`avatarURL` overridden per message). **Slack:** one app + `chat:write.customize`. Identity is a thin output-rendering concern.

---

## Phase 0: Documentation Discovery (consolidated findings)

These are verified against the actual codebase (read in full) and installed dependency source. **Treat as the Allowed-APIs list. Do not invent methods beyond these.**

### Kernel primitives (`src/core/`)

- **`types.ts`** — `BridgeProvider`, `IncomingMessage`, `OutgoingMessage` (`{ text; mention?: boolean }` — **no identity field today**), `ConversationRecord` (`{ agentId; sessionId: string|null; readOnly; persistSession(sessionId) }`), `ChannelTarget` (`{ provider; channelId }` — **channel-only, no threadId today**), `MessageTarget`, `KernelContext` (`{ enqueue(message, options?); logger }`), `KernelLogger`.
- **`queue.ts`** — `createQueue(deps: QueueDeps)` **factory** (not a class) → returns `{ enqueue }`. Keys on `` `${provider}:${channelId}` `` (`queue.ts:73-75`). State: `Map<string, QueueEntry[]>` + `processing: Set<string>` (`:70-71`). Serial per key, concurrent across keys. Session persist call: `if (!conv.sessionId && result.sessionId) conv.persistSession(result.sessionId)` (`:176-178`). maestro.send call site `:171-178`. **Copy this whole structure for the room bus.**
- **`db/index.ts`** — exported `db` handle (opened at `__dirname/../../../maestro-bot.db`, `:12` — reuse this handle, never open another). `channelDb` helper object `:41-97` with `register/get/getByAgentId/updateSession/setReadOnly/remove/listByAgentId/listByGuild`. Composite PK `(provider, channel_id)`.
- **`db/migrations.ts`** — `runMigrations(db)` calls each `ensureXTable` in order (`:13-20`). **Idempotent create-table template: `ensureSlackConversationsTable` `:125-136`** (`CREATE TABLE IF NOT EXISTS …`). Add-column template `:35-46` (try/catch on "duplicate column name").
- **`maestro.ts`** — `send(agentId, message, opts?: { sessionId?; readOnly?; openTab?; noSystemPrompt? }): Promise<SendResult>` (`:314-352`). **Omitting `sessionId` (`-s`) starts a NEW session.** `SendResult` (`:30-46`): `{ agentId; agentName; sessionId: string; response: string|null; success; error?; usage: { inputTokens; outputTokens; cacheReadInputTokens; cacheCreationInputTokens; totalCostUsd; contextWindow; contextUsagePercent } }`. **`usage.totalCostUsd` is the budget signal.**
- **`api.ts`** — `POST /api/send` (`handleSend` `:67-179`) pushes provider text directly, **bypassing queue + maestro**. Not the room path; left as-is.
- **`splitMessage.ts`** + `renderTables` — queue applies both before `provider.send` (see `queue.ts` drain loop). Reuse for persona posts.
- **`index.ts`** — orchestration order: import `./core/db` (migrates as side-effect) → `buildProviders` → `createQueue` → assemble `ctx` → `await provider.start(ctx)` each → `startServer(providers)` → graceful shutdown checkpoints WAL. **The room bus is wired here alongside the queue.**

### Discord provider (`src/providers/discord/`) — discord.js **14.25.1** (verified)

- **Webhook API (verified in installed source):**
  - Create on a **parent text channel** (never a thread): `guild.channels.createWebhook({ channel, name, avatar, reason })` → `Webhook` (carries `.id`, `.token`, `.url`).
  - List: `guild.channels.fetchWebhooks(channel)` → `Collection`. **`fetchWebhooks` is NOT available on `ThreadChannel`** — always operate on the parent channel.
  - Post: `webhook.send({ content, username, avatarURL, threadId })` — per-message `username` + `avatarURL` override + `threadId` to target a thread. `WebhookClient` (`new WebhookClient({ id, token })` or `{ url }`) has the identical `.send`.
- **Self/bot filter — the only guard:** `messageCreate.ts:55` → `if (message.author.bot) return;`. Webhook-authored messages have `author.bot === true`, so **persona posts are already dropped.** Field to use for explicit room-webhook awareness: `message.webhookId` (string on webhook messages, else null). No `webhookId` handling exists anywhere today (grep-confirmed).
- **Slash commands:** module exports `data: SlashCommandBuilder`, `execute(interaction)`, optional `autocomplete`. Subcommand template `commands/agents.ts:24-110` (builder `:24-66`, autocomplete `:68-82`, dispatch `:97-109`). Registration touches **two** spots: `adapter.ts:37-51` (`COMMANDS` array) and `deploy.ts:3-19` (`<cmd>.data.toJSON()`), deployed via `npm run deploy-commands`.
- **Threads:** `discord_agent_threads` table (`migrations.ts:112-123`). Created via `parentTextChannel.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek, reason })` then `threadDb.register(...)` — see `messageCreate.ts:93-104` and `commands/session.ts:100-106`.
- **`send()` rendering:** `adapter.ts:176-189` — `fetchSendable(channelId)` → optional mention prefix → `channel.send(text)`, wrapped in `toRateLimitError`. **No thread/identity targeting today.**
- **Permissions gap:** bot needs **`MANAGE_WEBHOOKS`** (bit `0x20000000`). Current invite permission integer (`agents.ts:20`, `permissions=11344`) does NOT include it. Must update the invite link + role.

### Slack provider (`src/providers/slack/`) — @slack/bolt **^4.6.0** (verified)

- **Self/bot filter:** `messageCreate.ts:14-17` → `if (event['bot_id'] || !text.trim()) return;`. Persona posts (same bot user) carry `bot_id` → already dropped.
- **`chat.postMessage` sends** at `adapter.ts:317-350` (`send()`); thread post `:337-341`, top-level `:343`. **None set `username`/`icon_url` today.**
- **Scope gap:** `chat:write.customize` is **NOT** in the documented scopes (`docs/slack.md:10-16`) — required for per-message `username`/`icon_url` override. No manifest in repo; scopes are manual in Slack UI + documented in `docs/slack.md`. App must be reinstalled after adding the scope.
- **thread_ts keying:** `slack_agent_conversations` PK `thread_ts` (`migrations.ts:127-135`); `conversationDb.get/register/updateSession` keyed on `thread_ts` (`conversationsDb.ts:15-59`). `send()` detects a thread_ts target and resolves parent `channel_id` via `conversationDb.get`.
- **Slash commands:** `app.command('/x', handler)` in `adapter.ts:266-268`; handler `ack()` → allowlist → `command.text.split(/\s+/)` subcommand switch (template `commands/session.ts:8-71`). **Not auto-deployed** — manual Slack-app entry + `docs/slack.md` update.

### Anti-patterns to avoid (from discovery)

- ❌ Do not create/fetch webhooks on a `ThreadChannel` — use the **parent** channel, pass `threadId` to `.send`.
- ❌ Do not open a second SQLite connection — reuse the exported `db`.
- ❌ Do not route persona posts back through the gateway — routing is kernel-internal.
- ❌ Do not assume `OutgoingMessage`/`ChannelTarget` carry identity or thread — they do not; add them deliberately in Phase 1.
- ❌ Do not put `discord.js`/`@slack/bolt` types in `src/core/`.
- ❌ `QueueDeps.maestro.send` declares a **narrower** structural type than `SendResult` (`sessionId?`, `usage?` optional). Match the narrow type or widen deliberately (known observation id 7413).

---

## Phase 1: Kernel data model + room protocol

Pure, provider-free, fully unit-testable. No provider code touched.

### What to implement

1. **DB tables** — add two idempotent `ensureXTable` functions to `src/core/db/migrations.ts`, copying the **exact** shape of `ensureSlackConversationsTable` (`:125-136`) and registering them in `runMigrations` (`:13-20`):
   - `rooms`: `room_key TEXT PRIMARY KEY` (= `` `${provider}:${channelId}` ``), `provider`, `parent_channel_id`, `thread_id` (nullable), `status TEXT` (`active`|`paused`|`halted`), `budget_usd REAL`, `spent_usd REAL DEFAULT 0`, `max_mentions INTEGER DEFAULT 2`, `created_at`.
   - `room_participants`: composite PK `(room_key, agent_id)`, plus `handle TEXT` (sanitized display name), `avatar_url TEXT` nullable, `session_id TEXT` nullable, `created_at`. Mirror the `channelDb` helper style.
2. **`src/core/room/roomsDb.ts`** — query helpers over the exported `db` (copy the `channelDb` object pattern from `db/index.ts:41-97`): `createRoom`, `getRoom`, `setStatus`, `addSpend`, `resetBudget`, `addParticipant`, `getParticipant`, `listParticipants`, `removeParticipant`, `updateParticipantSession`, `resetAllSessions(roomKey)` (sets every participant `session_id = NULL`), `deleteRoom`.
3. **`src/core/room/protocol.ts`** — the single source of truth so preamble and parser cannot diverge:
   - `const RESERVED = { all: '@all', human: '@human' }` and a shared handle-token regex.
   - `sanitizeHandle(name): string` — strip to a safe handle; enforce Discord/Slack username rules (≤80 chars, no "discord"/"clyde", non-empty); on collision the caller appends a short id suffix.
   - `buildPreamble(room, self: Participant, participants: Participant[]): string` — room name, participant handle list, the addressing rule ("address peers with `@Handle`; no mention = to the room; you are only invoked when addressed; reply briefly; `@human` to hand back"), derived from the same participant list the parser uses.
   - `parseMentions(text, participants, opts: { maxMentions }): { targets: Participant[]; all: boolean; human: boolean }` — match `@handle` **only** against registered handles (case-insensitive), recognize `@all`/`@human`, **dedup**, **drop self-mention**, **cap at `maxMentions`**. Prose `@whatever` that matches no handle is ignored.
4. **`src/core/types.ts`** — add the minimal contract surface (no provider imports):
   - `export interface PersonaIdentity { name: string; avatarUrl?: string }`
   - Add optional `threadId?: string` to `ChannelTarget`.
   - Add optional capability to `BridgeProvider`: `sendAs?(target: ChannelTarget, identity: PersonaIdentity, msg: OutgoingMessage): Promise<void>;` (optional like `react?`/`sendTyping?`).
   - Define `RoomGateway` interface: `{ isRoom(provider: string, channelId: string): boolean; submitMessage(provider: string, channelId: string, from: string, text: string): void }` and add `rooms: RoomGateway` to `KernelContext`.

### Documentation references
- Migration create-table template: `src/core/db/migrations.ts:125-136`. Registration: `:13-20`.
- DB helper object pattern: `src/core/db/index.ts:41-97`.
- Contract style for optional capabilities: `BridgeProvider.react?`/`sendTyping?` in `src/core/types.ts`.

### Verification checklist
- `npm run build` compiles with no `discord.js`/`@slack/bolt` import in `src/core/room/`.
- `node --test` on `test/room-protocol.test.ts`: round-trip — every handle named in `buildPreamble` output is parseable by `parseMentions`; `@all`/`@human` detected; self-mention dropped; mention cap enforced; non-registered `@token` ignored; collision sanitization deterministic.
- DB test: `runMigrations` is idempotent (run twice, no throw); `resetAllSessions` nulls all participant sessions.

### Anti-pattern guards
- Preamble and parser MUST share one handle set + regex constant — no second hardcoded list.
- No second DB connection; import `db` from `core/db`.
- `maxMentions` default 2; never unbounded fan-out.

---

## Phase 2: Room bus / routing engine + budget & loop brakes

The kernel-internal async bus. Provider-free; tested against a stub provider.

### What to implement

1. **`src/core/room/bus.ts`** — `createRoomBus(deps)` factory copying the serialization structure of `createQueue` (`queue.ts:65-241`): `Map<roomKey, RoutedMessage[]>` + `processing: Set<roomKey>`. `deps = { maestro, getProvider, logger, roomsDb }`. Returns the `RoomGateway` (`isRoom`, `submitMessage`) plus internal `processNext(roomKey)`.
   - **RoutedMessage**: `{ roomKey; fromHandle: string; toAgentId: string; text: string }`.
   - **`submitMessage(provider, channelId, from, text)`** (human or external input): resolve `roomKey`, `parseMentions(text, participants)` → enqueue one RoutedMessage per target (or all participants on `@all`). No mention from a human → optionally broadcast to all (configurable) OR no-op; default: require an explicit mention to start.
   - **Worker `processNext`** (serial per room, mirrors queue drain loop `:87-238`):
     1. Pre-check room `status` (`paused`/`halted` → skip) and **budget**: if `spent_usd >= budget_usd`, halt (Phase-2 brake) — set status `halted`, post a system notice via `sendAs` (a reserved "system"/room persona), return.
     2. Build input = `buildPreamble(...)` + `\n\n[${fromHandle}]: ${text}`.
     3. `maestro.send(toAgentId, input, { sessionId: participant.session_id ?? undefined })`. New session when null; persist via `roomsDb.updateParticipantSession` when `result.sessionId` and none stored (mirror `queue.ts:176-178`).
     4. `roomsDb.addSpend(roomKey, result.usage.totalCostUsd)`.
     5. Render: `splitMessage` + `renderTables` (as queue does), then `provider.sendAs(target, { name: handle, avatarUrl }, { text: part })` for each part.
     6. **Echo guard:** hash the response; if it equals this agent's previous response (keep last hash per `(roomKey, agentId)` in memory), suppress further routing from it and log.
     7. `parseMentions(result.response, participants, { maxMentions })` → enqueue RoutedMessages for each target (dedup, self-mention dropped). `@human` or no targets → enqueue nothing.
     8. Tail-call `processNext(roomKey)`; when queue empty, `processing.delete(roomKey)`.
2. **Wire into `src/index.ts`** — after `createQueue`, create the bus: `const roomBus = createRoomBus({ maestro, getProvider, logger, roomsDb })`. Add it to `ctx`: `ctx.rooms = roomBus`. (Bus shares the `getProvider` closure with the queue.)
3. **Loop/cost brakes (Phase-2 scope, all enforced in the worker):**
   - Hard per-room **cost cap** (`budget_usd`) — checked before every send.
   - **Mention-gated** invocation (already structural via `parseMentions`).
   - **`maxMentions` cap** + self-mention dedup (from Phase 1).
   - **Echo detection** (step 6).
   - `status === 'paused'|'halted'` short-circuits (human circuit-breaker, driven by Phase 4 commands).

### Documentation references
- Serialization + drain structure to copy: `src/core/queue.ts:65-241` (keying `:73-75`, state `:70-71`, session persist `:176-178`, maestro call `:171-178`).
- Split/render-before-send: queue drain loop in `queue.ts`.
- maestro send + usage: `src/core/maestro.ts:314-352`, `SendResult.usage.totalCostUsd` `:37-45`.

### Verification checklist
- `node --test` on `test/room-bus.test.ts` with a **stub provider** implementing `sendAs` + a **stub maestro** returning canned `SendResult`s:
  - A→`@B` routes exactly one send to B's session; B's reply with no mention drains the bus (terminates).
  - Budget cap: once cumulative `totalCostUsd` ≥ `budget_usd`, room halts and no further sends occur.
  - `maxMentions=2`: a reply naming 3 handles routes to only 2.
  - Self-mention by the speaker is dropped.
  - Echo: identical consecutive replies suppress re-routing.
  - Two rooms process concurrently; one room is strictly serial.
- No `discord.js`/`@slack/bolt` import in `src/core/room/`.

### Anti-pattern guards
- Never re-enter a room's worker concurrently (respect the `processing` set).
- Budget check is **before** the send, not after.
- Do not block on inter-agent DMs — every hop is an enqueue, never an await-on-peer.

---

## Phase 3: Provider persona rendering + self-filter hardening

The only provider-specific phase. Implements `sendAs` and confirms self-filtering.

### What to implement — Discord (`src/providers/discord/`)

1. **`src/providers/discord/webhooks.ts`** — a per-parent-channel webhook cache:
   - `ensureWebhook(guild, parentChannelId): Promise<{ id; token }>` — `guild.channels.fetchWebhooks(parentChannelId)` → reuse an existing relay-owned webhook (match by name, e.g. `maestro-relay-rooms`) or `guild.channels.createWebhook({ channel: parentChannelId, name, reason })`. Cache `{id, token}` in memory + persist webhook id on the `rooms` row (defensive registry per Phase-0 self-filter note). **Operate on the parent channel, never the thread.**
2. **`adapter.ts` — implement `sendAs(target, identity, msg)`:** resolve guild + `target.channelId` (parent) + `target.threadId`; `ensureWebhook`; `new WebhookClient({ id, token }).send({ content: msg.text, username: sanitize(identity.name), avatarURL: identity.avatarUrl, threadId: target.threadId })`. Wrap in `toRateLimitError` like `send()` (`adapter.ts:176-189`).
3. **`findOrCreateAgentChannel` is not used for rooms** — rooms are created by the `/room` command (Phase 4). `sendAs` only needs the parent channel + threadId from the `rooms` row.
4. **Self-filter (`messageCreate.ts`)** — keep `if (message.author.bot) return;` (already drops persona webhook posts). **Before** the normal single-agent routing, add: if `ctx.rooms.isRoom('discord', message.channelId)` and the author is a **real user** (not bot), call `ctx.rooms.submitMessage('discord', message.channelId, message.author.username, message.content)` and return. Defensive: log if `message.webhookId` is set and matches a room webhook (should already be dropped by `author.bot`).
5. **Permissions/docs:** add `MANAGE_WEBHOOKS` (`0x20000000`) to the invite permission integer (`agents.ts:20`) and document it + the webhook approach in `docs/discord.md`.

### What to implement — Slack (`src/providers/slack/`)

1. **`adapter.ts` — implement `sendAs(target, identity, msg)`:** `chat.postMessage({ channel: parentChannel, thread_ts: target.threadId, text: msg.text, username: identity.name, icon_url: identity.avatarUrl })` (copy the existing `send()` thread-resolution at `adapter.ts:317-350`, add the identity fields). Requires `chat:write.customize`.
2. **Self-filter (`messageCreate.ts`)** — keep `event['bot_id']` drop; add the room-submit branch for real-user messages mirroring Discord (`ctx.rooms.isRoom('slack', channelId)` → `submitMessage`).
3. **Scope/docs:** add `chat:write.customize` to `docs/slack.md:10-16` and note the app must be reinstalled.

### Documentation references
- Webhook API: `Webhook.send({ content, username, avatarURL, threadId })`, `WebhookClient`, `guild.channels.createWebhook/fetchWebhooks` (Phase 0). Parent-channel-only rule.
- Discord send wrapper to mirror: `adapter.ts:176-189`. Self-filter: `messageCreate.ts:55`.
- Slack send to extend: `adapter.ts:317-350`. Self-filter: `messageCreate.ts:14-17`. Scopes: `docs/slack.md:10-16`.

### Verification checklist
- `npm run build` passes; `sendAs` present on both adapters and typed against `PersonaIdentity`.
- Manual Discord smoke: a room thread shows two posts under two distinct usernames/avatars from one bot.
- Confirm a persona webhook post does **not** re-trigger the bus (watch logs — no `submitMessage` for `author.bot`/`webhookId` authors).
- Slack smoke (if app reinstalled with scope): two distinct usernames in one thread.

### Anti-pattern guards
- ❌ Never `createWebhook`/`fetchWebhooks` on a thread channel.
- ❌ Do not loosen the `author.bot` / `bot_id` self-filter — routing is internal; gateway never feeds personas back.
- ❌ Do not exceed 80-char usernames or include "discord"/"clyde" (use `sanitizeHandle`).
- Reuse one webhook per parent channel (cache) — do not create one per message/agent (15/channel limit).

---

## Phase 4: Control commands (`/room`)

Thin provider surface over `roomsDb` + the bus.

### What to implement

**Subcommands:** `new` (create a room thread in the current channel, set `budget_usd`), `invite <agentId>` (resolve agent name → sanitized handle, `addParticipant`), `kick <handle>`, `pause`/`resume` (`setStatus`), `stop` (halt + optional archive), `reset` (`resetAllSessions` + `resetBudget` → reusable room), `budget <usd>` (update cap), `status` (post participants, status, `spent_usd`/`budget_usd` as a subtext line — reuse the existing usage-subtext rendering pattern from the queue).

1. **Discord:** `src/providers/discord/commands/room.ts` — copy the subcommand builder + dispatch from `commands/agents.ts:24-110` (agent option uses `.setAutocomplete(true)` like `agents.ts`). `new` creates the thread via `channel.threads.create({...})` (copy `session.ts:100-106`), then `roomsDb.createRoom`. Register in `adapter.ts` `COMMANDS` (`:37-51`) and `deploy.ts` (`:3-19`); run `npm run deploy-commands`.
2. **Slack:** `src/providers/slack/commands/room.ts` — copy `commands/session.ts:8-71` (ack → allowlist → `command.text` subcommand switch). `new` creates a thread parent message, registers the room. Register `app.command('/room', ...)` in `adapter.ts:266-268`; document the manual Slack-app `/room` entry in `docs/slack.md`.

### Documentation references
- Discord subcommands + autocomplete + dispatch: `commands/agents.ts:24-110`. Thread create: `commands/session.ts:100-106`. Registration: `adapter.ts:37-51`, `deploy.ts:3-19`.
- Slack command template: `commands/session.ts:8-71`. Registration: `adapter.ts:266-268`.

### Verification checklist
- `/room new` creates a thread and a `rooms` row; `/room invite` adds a participant with a unique sanitized handle (collision → id suffix).
- `/room reset` nulls all sessions and zeroes `spent_usd`; a subsequent message starts fresh sessions.
- `/room pause` stops routing; `/room resume` continues; `/room stop` halts.
- `/room status` posts budget/spend/participants.

### Anti-pattern guards
- Commands only mutate `roomsDb` + call bus status setters — no routing logic duplicated here.
- Handle collisions resolved via `sanitizeHandle` + id suffix, never silently overwritten.

---

## Phase 5: Verification & docs

### What to do
1. **Full suite:** `node --test` green (protocol, bus, plus existing tests unbroken). `npm run build` clean.
2. **Boundary grep:** `grep -rn "discord.js\|@slack/bolt" src/core/` returns **nothing** (kernel purity).
3. **Anti-pattern grep:** no `createWebhook(`/`fetchWebhooks(` targeting a thread; no second `new Database(`; self-filters intact (`grep -n "author.bot" src/providers/discord/messageCreate.ts`, `grep -n "bot_id" src/providers/slack/messageCreate.ts`).
4. **Loop-safety review:** confirm budget check precedes every send; confirm no `await` on a peer agent inside the worker (every hop is an enqueue).
5. **End-to-end smoke (Discord):** `/room new` → `/room invite` two agents → a human message mentioning one agent → observe an A↔B exchange that **terminates** when no `@mention` remains; force budget cap and confirm halt; `/room stop`.
6. **Docs:** update `docs/discord.md` (webhook identity, `MANAGE_WEBHOOKS`), `docs/slack.md` (`chat:write.customize`, `/room`), `.env.example` if any new env added, and add a short "Rooms" section to `CLAUDE.md`/`AGENTS-providers.md` describing the kernel-internal bus + `sendAs` capability.

### Success criteria (MVP)
A single room with 2–3 agents in a Discord thread, each posting under its own identity, mention-routed, with a hard cost cap, self-filter intact, control commands working, and **provable termination** when the conversation runs out of addressees.

---

## Build order summary

| Phase | Deliverable | Provider-touching? |
|---|---|---|
| 1 | DB tables + `roomsDb` + `protocol.ts` + contract additions | No |
| 2 | `bus.ts` routing engine + budget/echo brakes + index wiring | No |
| 3 | `sendAs` (Discord webhook / Slack customize) + self-filter | Yes |
| 4 | `/room` commands (Discord + Slack) | Yes |
| 5 | Tests, grep guards, smoke, docs | — |

Phases 1–2 are pure kernel and fully unit-testable before any provider work. Phase 3 is where Discord/Slack credentials and the `MANAGE_WEBHOOKS` / `chat:write.customize` setup come into play.
