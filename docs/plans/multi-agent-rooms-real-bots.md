# Plan: Multi-Agent Rooms — Real Bot Accounts (Design Delta)

**This is a design delta on [`multi-agent-rooms.md`](./multi-agent-rooms.md).** Read that plan first — it is the baseline. Everything about **routing, `@handle` addressing, per-(room, agent) sessions, budget caps, `/room` control commands, and kernel purity stays.** This document changes **only the identity + transport layer**: instead of *one shared bot wearing Discord-webhook masks / Slack `chat:write.customize`*, we run **N real, separate bot accounts — multiple genuine bots in one channel**, each with its own gateway connection.

## Why this delta (Chris's decision)

The webhook-mask approach makes personas *look* distinct but they are not real accounts:

- **Native pinging is impossible.** A webhook message can *render* `@Ada`, but it cannot fire a real Discord mention that another bot's gateway receives. Real bot accounts can natively `@Ben` each other, and that ping is a first-class gateway event.
- **Each identity is genuinely addressable.** A human can `@Ada` directly with a task; the mention resolves to a real user, shows presence, and is a real member of the channel.
- **Every persona is real and visible** — real avatar, real status, real member list entry.

Target scale: **~6 bots** in a room, not 3. At that scale the per-token rate-limit and process-management costs are negligible (see §Fallstricke).

## The core tension, and how it resolves

The baseline plan is emphatic: *routing is kernel-internal; persona posts are NEVER re-read from the gateway.* Real bots invert exactly that one rule — **the gateway becomes the transport for the A→B hop**. Bot A posts a message containing a real `<@BotB>` mention; Bot B's own gateway connection receives it and routes to Bot B's Maestro session. Discord itself is the bus for hops.

Everything else the baseline calls "the core" is preserved **as a shared in-process kernel module** that every gateway listener consults:

| Concern | Baseline (webhooks) | Real-bots delta |
|---|---|---|
| Handle registry + `parseMentions` + preamble (`protocol.ts`) | kernel-internal | **unchanged** — shared module |
| `rooms` / `room_participants` schema + `roomsDb` | kernel-internal | **unchanged** (+ a `bot_slot` column) |
| Budget ledger + loop brakes | enforced in the bus worker | **unchanged logic**, still enforced in one shared worker before every `maestro.send` |
| Per-(room, agent) sessions | kernel-internal | **unchanged** |
| `/room` commands | thin surface | **unchanged** (+ `invite` binds a bot slot) |
| **Transport of the A→B hop** | internal enqueue of parsed mentions | **Discord delivery** — Bot A posts a real `<@BotB>` mention; Bot B's gateway picks it up |
| **Identity** | 1 bot + webhook `username`/`avatarURL` | **N real bot accounts**, each its own gateway + token |
| **Self/peer filter** | drop all `author.bot` | **drop self + non-relay bots; ALLOW registered peer relay bots in a room** |

So the kernel keeps the brain; Discord provides the nervous system between bots. The single most important consequence: **we do NOT internally enqueue the next hop** in the real-bots model — posting the response *is* the enqueue, because a peer bot's gateway will deliver it. Doing both would double-route.

### The transport has no delivery guarantee (resolved — see Phase 3 §Reconciliation)

Making Discord the bus buys native pings but inherits Discord's semantics: **a `messageCreate` gateway event is best-effort, not durable.** The A→B hop is a single gateway push to Bot B. If Bot B's gateway is mid-reconnect (a transient WebSocket drop / `RESUME` gap) at the instant Bot A posts, **B never receives that `messageCreate`, there is no replay, and the conversation stalls** — with no crash, no error, and no budget spent. This is distinct from crash-fault isolation (which §Phase 3 already covers): the process is healthy, one client just missed one event.

This is the **one gap that touches the core mechanic**, so it is resolved before Phase 3/4 is built, via the reconciliation strategy in **Phase 3 §Reconciliation & stall detection**: on every `shardResume`/`shardReconnecting→ready` transition, each client re-fetches the room channels' messages since its last-seen id and re-routes any mention of itself it missed (idempotent — the mention-gate + a de-dupe on message id make re-delivery a no-op). Best-effort remains the honest contract; reconciliation shrinks the miss window from "until a human notices" to "until the next resume." See Phase 3 for the full mechanism and the guarantee we actually make.

---

## Architecture decisions (settled for this delta — do not re-litigate)

- **Discord-first.** Real multi-bot is natural on Discord (each bot is a cheap application). It is **awkward-to-hostile on Slack and Teams** (you would need N separate Slack apps / N Azure bot registrations per workspace/tenant). Therefore: **Discord uses real bots; Slack and Teams keep the webhook/`chat:write.customize` masking from the baseline plan.** The two identity strategies coexist, split by provider. See §Phase 6 for the migration recommendation.
- **One process, N `Client` instances.** A single Node process owns ~6 discord.js `Client`s (one per token), all sharing the same `db` handle, the same in-memory budget ledger, and the same `protocol`/`roomsDb` modules. **Not** one process per bot (see §Phase 3 for the trade-off analysis and why one process wins at N~6).
- **The existing single-agent bot is bot slot 0.** `DISCORD_BOT_TOKEN` remains the control/host bot: it owns `/room` slash commands and can itself be a participant. Room bots are *additional* tokens layered on top; the existing single-agent bridge behavior is untouched.
- **Kernel stays provider-agnostic.** New generic code (config schema for a bot pool, the shared bus/ledger) lives in `src/core/`; discord.js-specific multi-client management lives in `src/providers/discord/`. No `discord.js` import leaks into `src/core/` (CLAUDE.md).
- **`@Handle` → `<@botUserId>` rewrite is mandatory.** Maestro agents emit human-friendly `@Ada`. For a *native* ping to fire, the kernel must rewrite the addressed handles to real Discord mention syntax `<@snowflake>` **before** posting. This rewrite is the join point between the kernel handle-registry and the real bot user IDs.
- **Bot token creation is NOT automatable.** Discord has no official API to mint bot tokens. Each bot is a one-time manual Developer-Portal setup, documented as an onboarding checklist (§Phase 6).

---

## Phase 0: Documentation Discovery (delta findings)

Verified against the current codebase and discord.js **14.25.1**. Baseline Phase 0 still applies for the kernel primitives (`queue.ts`, `roomsDb`, `maestro.ts`, migrations); the items below are **new or changed** for real bots.

### Current single-bot wiring (what we generalize)

- **`src/providers/discord/adapter.ts:59-138`** — `DiscordProvider.start()` builds **exactly one** `new Client({ intents: [Guilds, GuildMessages, MessageContent] })` and `client.login(discordConfig.token)`. Intents already include `MessageContent`. **This is the shape we must instantiate N times** (one per token). `client.user.id` (`adapter.ts:126` via `getBotUserId`) is the bot's own user id — the value each per-bot listener filters mentions against.
- **`src/providers/discord/config.ts:17-33`** — single-token config via lazy getters over `required('DISCORD_BOT_TOKEN')`. **We add a bot-pool schema alongside it** (§Phase 1). `discordConfig.clientId` (`config.ts:21-23`) is the application id; **for a bot account the application id equals the bot user id**, so the mention target `<@clientId>` is known from config *without logging in* — useful for the rewrite step and for the invite link.
- **`src/providers/discord/messageCreate.ts:54-55`** — `handleMessageCreate` opens with `if (message.author.bot) return;`. **This is the exact line that must change** for room channels: a *peer relay bot* must be allowed through; only *self* and *non-relay* bots stay filtered. The handler is a factory (`createMessageCreateHandler(deps)`), so we can bind a **distinct instance per `Client`** with that client's `botUserId` and a room-aware peer allowlist.
- **`message.author.id`** — for a peer bot message this is the *peer bot's user id*. Matching it against the room's registered bot user ids is how we distinguish "a relay peer in this room" from "some random bot / self."
- **`message.mentions.users.has(botUserId)`** (`messageCreate.ts:73`) — already the mention test. Reused verbatim per client.
- **`message.webhookId`** — irrelevant in the real-bots path (no webhooks). Left alone.

### discord.js multi-client facts (14.25.1)

- Multiple `Client` instances in one process are fully supported — each holds an independent gateway WebSocket, cache, and REST bucket set. No shared global state to trip over.
- Rate limits are **per bot token** (per REST client). N tokens = N independent buckets → N× headroom, not shared contention.
- **MESSAGE CONTENT is a privileged intent, per application.** Each of the N bots must have it enabled in *its own* Developer-Portal app, or `message.content` arrives empty for messages that don't mention that bot (mentions still deliver content, but transcript-awareness and cleanup want the full content). Enable it for every bot.
- A bot only receives `messageCreate` for guilds/channels it is a member of. **All N bots must be invited to the guild** (and have access to the room channel) — see the onboarding checklist.
- `MANAGE_WEBHOOKS` is **no longer needed** for the Discord path (that was a webhook-masking requirement). Each room bot needs only `View Channel` + `Send Messages` (+ `Read Message History`, `Send Messages in Threads` if rooms use threads).

### Anti-patterns to avoid (delta)

- ❌ Do **not** internally enqueue the next hop after posting a bot response — Discord delivery to the peer bot's gateway *is* the next hop. Enqueue-and-post = double routing.
- ❌ Do **not** relax the self-filter to "allow all bots." Allow **only** the registered peer relay bots of *this* room; still drop self and third-party bots.
- ❌ Do **not** post an agent response with raw `@Handle` text and expect a native ping — you must rewrite to `<@botUserId>` first.
- ❌ Do **not** store bot tokens in the DB. Tokens live only in env / secret store; the DB holds bot *user ids* and slot references.
- ❌ Do **not** put `discord.js` types in `src/core/`. The bot-pool *schema* is generic (strings); the *client management* is Discord-provider code.
- ❌ Do **not** run the budget/loop brakes independently per client. There is one shared ledger and one per-room serialization lock; every client's listener funnels through it.

---

## Phase 1: Config & secrets model (bot pool)

Provider-adjacent config only. No routing yet.

### What to implement

1. **Bot-pool schema** — a pool of N real bot identities. Each entry is a secret bundle:
   - `slot` (stable integer/string id, e.g. `1`..`6`), `token` (secret), `clientId` (= bot user id / application id), `name` (default persona display name), `avatarUrl?` (optional; real bots also carry a portal avatar).
2. **Env encoding** — keep it flat and secret-manager friendly. Preferred: **indexed env vars** so each token is an isolated secret (easy rotation, easy per-secret ACLs):
   ```
   DISCORD_ROOM_BOT_1_TOKEN=...      DISCORD_ROOM_BOT_1_CLIENT_ID=...   DISCORD_ROOM_BOT_1_NAME=Ada
   DISCORD_ROOM_BOT_2_TOKEN=...      DISCORD_ROOM_BOT_2_CLIENT_ID=...   DISCORD_ROOM_BOT_2_NAME=Ben
   ...
   DISCORD_ROOM_BOT_COUNT=6
   ```
   (A single JSON blob `DISCORD_ROOM_BOTS=[{...}]` is the fallback, but indexed vars keep each token as a discrete secret — better for leak isolation and rotation, worse only for verbosity.) Document both in `.env.example`; recommend indexed.
3. **`src/providers/discord/roomBots.ts`** (or extend `config.ts`) — loader that reads the pool lazily (same pattern as `discordConfig` getters at `config.ts:17-33`, so a deployment with no room bots never fails startup). Returns `RoomBotIdentity[]`. Validates: non-empty token, valid clientId, unique slots, `sanitizeHandle`-compatible name. Slot 0 is the existing `DISCORD_BOT_TOKEN` (control/host bot), included in the pool implicitly.
4. **Secrets hygiene / rotation / leak isolation** — document in `docs/discord.md`:
   - Each token is an **independent secret**; a leaked token compromises **only that one persona**, and can be rotated in that bot's portal + swapped in env with **zero impact** on the other N-1 bots or on any room binding (bindings key on `slot`/`clientId`, not the token).
   - Tokens are **never** written to the DB, never logged (guard the logger — never log a value that matches a token shape), never returned by `/room status`.
   - Rotation runbook: regenerate in Portal → update `DISCORD_ROOM_BOT_<n>_TOKEN` → restart process → that bot's gateway reconnects with the new token; `clientId`/user id is stable so all room bindings survive.

### Verification checklist
- `npm run build` clean; no `discord.js` import in the pure schema portion.
- Loader returns [] (not throw) when no room-bot env is set; a Discord-only-single-agent deployment is unaffected.
- Duplicate slot / malformed clientId → clear startup error naming the offending slot.
- Grep: no token value can reach `logger.*` (add a redaction test).

### Anti-pattern guards
- One secret per token — no shared "master token."
- Binding keys on `slot`/`clientId`, never on the token value (so rotation doesn't orphan rooms).

---

## Phase 2: Kernel data model + protocol (reuse baseline Phase 1, with a bot binding)

**This is baseline Phase 1 nearly verbatim.** Implement `rooms`, `room_participants`, `roomsDb`, `protocol.ts` exactly as the baseline specifies. The deltas:

1. **`room_participants` gains `bot_slot TEXT` (nullable → required for Discord rooms)** — the pool bot that renders this agent's identity in this room. Composite PK stays `(room_key, agent_id)`. A given bot slot is **unique per room** (one bot = one agent within a room; enforce on `invite`).
   - **Stable global agent→bot mapping is the hard default (enforced), not a preference.** An agent that is bot "Ada" in one room must be "Ada" in *every* room. Rationale: humans (and the agents themselves) build a mental model of "Ada = that persona"; letting the same real bot account be Ada here and Ben there is genuinely confusing and undermines the whole point of real, recognizable identities. Implement a persistent `agent_bot_bindings` table `(agent_id PRIMARY KEY, bot_slot)`: the **first** `/room invite` of an agent allocates a free slot and writes this global binding; **every subsequent** invite of that agent (any room) reuses the bound slot. `/room invite` must **reject** an attempt to bind an agent to a different slot while its global binding stands (error points at an explicit `/room rebind` escape hatch for the rare deliberate reassignment). The per-room `bot_slot` on `room_participants` is thus a denormalized copy of the global binding, kept consistent with it.
   - Slot-in-use conflict: if an agent's globally-bound slot is already taken by a *different* agent in the target room, that is a hard error (the invariant "one slot = one agent per room" plus "one slot = one agent globally" together mean this can only happen from manual DB tampering or a stale binding — surface it, don't silently remap).
2. **`protocol.ts` — add the native-mention rewrite.** Alongside `parseMentions`, add:
   - `resolveBotUserId(handle, participants): string | null` — map a parsed handle to its bound bot's `clientId` (= bot user id).
   - `renderNativeMentions(text, targets: Participant[]): string` — replace each addressed `@Handle` token in the outgoing text with `<@botUserId>` so Discord fires a real ping. `@human` maps to the configured human mention id (reuse `discordConfig.mentionUserId`, `config.ts:30-32`); `@all` expands to the native mentions of all non-self participants (still subject to `maxMentions`). This function lives in `protocol.ts` (pure, string-in/string-out — no discord.js) and is the join between handles and real user ids.
3. **`types.ts`** — the baseline's `PersonaIdentity`, `ChannelTarget.threadId?`, `RoomGateway` all still apply. The `sendAs?` capability is still declared (Slack/Teams use it via webhooks; Discord's implementation posts via the bound bot's client — see Phase 4). Add `botUserId?: string` to `PersonaIdentity` (kernel-generic string) so the renderer can self-exclude and the transport can pick the right client.

### Verification checklist
- Baseline Phase-1 checklist, plus: `renderNativeMentions` round-trips — every handle it rewrites is one `parseMentions` would have targeted; self handle never rewritten; `@all` respects `maxMentions`; unknown `@token` left as literal text.
- `bot_slot` uniqueness within a room enforced (invite of a second agent to an already-used slot → rejected with a clear error).
- **Global agent→bot binding enforced:** inviting the same agent into two different rooms binds it to the **same** slot in both; an attempt to bind that agent to a *different* slot is rejected (only `/room rebind` can change it). Assert `agent_bot_bindings` is written on first invite and reused thereafter.

### Anti-pattern guards
- Preamble, `parseMentions`, and `renderNativeMentions` share **one** handle set + regex constant (baseline rule, now three consumers).
- `renderNativeMentions` stays pure — no `discord.js`, no client lookup (it receives resolved bot user ids from `participants`).

---

## Phase 3: Multi-gateway manager + inbound routing

The heart of the delta. One process, N gateway connections, one shared listener logic bound per client.

### Single shared process vs. one process per bot — decision

| | **One process, N clients (RECOMMENDED)** | One process per bot |
|---|---|---|
| Budget ledger / loop brakes | trivial — shared in-memory ledger + one per-room lock | hard — needs shared DB with atomic spend + cross-process room lock (SQLite single-writer contention, or a lock table) |
| `roomsDb` / SQLite | one `db` handle (baseline rule) | N processes contending on one SQLite file, or N DBs (breaks the "one connection" rule) |
| Deployment / ops | one unit, one restart, one log stream | N units, N restarts, fan-out logs; more moving parts |
| Fault isolation | one crash takes all bots | a crash isolates one bot |
| Horizontal scale | bounded by one event loop | scales past one core |
| Memory | ~6 caches in one heap | ~6 heaps |

**Verdict: one process, N `Client` instances.** At N~6 the event loop is nowhere near saturated (each bot is mostly idle, waiting on mentions), and the shared-ledger simplicity is decisive — the loop brakes *require* a single source of truth, which one process gives for free. Per-bot processes only earn their keep at much larger N or when you need OS-level fault isolation, neither of which applies. Note the trade-off explicitly in the plan; if fault isolation ever matters, the escape hatch is a shared Redis/DB ledger + advisory lock, not a rewrite of the routing logic.

### What to implement (`src/providers/discord/`)

1. **`src/providers/discord/roomGateways.ts`** — a manager that, on `start()`, instantiates one `Client` per pool entry (copy the client construction from `adapter.ts:60-66`, intents `Guilds | GuildMessages | MessageContent`), logs each in with its token, and records `client.user.id` per slot into an in-memory `slot → { client, botUserId }` map (also upserted to a small `room_bots` registry table keyed on `slot`, storing `bot_user_id` for the rewrite/self-filter — never the token). Graceful `stop()` destroys all clients (mirror `adapter.ts:140-145`).
2. **Per-client room listener** — bind a **room-aware** variant of `createMessageCreateHandler` per client, with that client's `botUserId`. The listener logic for a **room channel** (i.e. `ctx.rooms.isRoom('discord', channelId)`):
   - **Self-filter (the changed line):** replace `if (message.author.bot) return;` with:
     - `if (message.author.id === thisBotUserId) return;` — always drop own messages (prevents self-loop).
     - allow through if the author is a **real user** OR a **registered peer relay bot of this room** (`message.author.id ∈ room bot user ids` and `!= self`).
     - drop any other bot (third-party bots stay filtered).
   - **Mention gate:** proceed only if `message.mentions.users.has(thisBotUserId)` (this bot is addressed). Every bot receives every room message; only the addressed bot(s) act. This is the natural dedup — a message mentioning only Ben is a no-op for Ada's listener.
   - **Route:** resolve the participant bound to `thisBotUserId`, strip the bot's own mention from content (reuse the `mentionPattern` cleanup at `messageCreate.ts:107-110`), then `ctx.rooms.submitMessage('discord', channelId, fromHandle, cleanedText, { toAgentId })`. `fromHandle` = the author's room handle (peer bot → its participant handle; human → their display name).
3. **Keep the existing non-room path intact.** For channels that are *not* rooms, only the control/host bot (slot 0) runs the current single-agent `handleMessageCreate` unchanged. Room bots (slots 1..N) ignore non-room channels entirely.
4. **Slot 0 has two independent bindings — keep them cleanly separated.** The control/host bot wears two hats and they must not collide:
   - **Command host** — slot 0's client is the *only* one bound to `interactionCreate` for `/room` slash commands (registration stays on slot 0 exactly as today; room bots register **no** slash commands). This is a distinct listener from message handling.
   - **Optional room participant** — *if and only if* slot 0 is also invited as a participant, its client additionally runs the room `messageCreate` listener (same per-client logic as slots 1..N, with slot 0's `botUserId`).

   These are two separate event bindings (`interactionCreate` vs `messageCreate`) on the same client; they share no state and must be wired independently so the command surface never routes chat and the room listener never intercepts interactions. Concretely: bind `interactionCreate` once (command dispatch) and bind the room `messageCreate` listener only when slot 0 participates — a slot-0-not-a-participant deployment has the command host with **no** room listener attached. Guard against double-binding the room listener on slot 0 (idempotent attach).

### Reconciliation & stall detection (transient reconnect-gap recovery — MUST)

Because the A→B hop is a best-effort gateway push (see §"The transport has no delivery guarantee"), a client that is mid-reconnect when a peer posts silently misses its mention and the room stalls. We close this with per-client catch-up on reconnect:

1. **Track last-seen per (slot, room channel).** Add a `room_bot_cursors` table `(slot, channel_id, last_seen_message_id)` (or an in-memory map flushed to DB) updated to `message.id` every time a client's listener *processes or intentionally skips* a room message. This is the low-water mark that reconnection replays from. Never store content — just the snowflake id.
2. **Hook the gateway lifecycle.** On each `Client`, listen for `shardResume` and the `shardReady`-after-`shardReconnecting` transition (discord.js `ClientEvents`). On fire, for each room channel the bot participates in, run reconciliation.
3. **Reconciliation fetch.** `channel.messages.fetch({ after: last_seen_message_id, limit: 100 })` (paginate if needed), oldest-first. Feed each fetched message through **the exact same listener path** (self-filter → peer allowlist → mention-gate → route). Because routing is idempotent — the mention-gate no-ops messages that don't address this bot, and the bus de-dupes on `message.id` (step 4) — replaying already-seen messages is harmless.
4. **Idempotency guard (de-dupe on message id).** The room bus keys a small recently-routed set / the cursor on `message.id`; a hop already routed (because the live event *did* arrive, and reconciliation also refetched it) is dropped the second time. This makes "fetch a slightly-too-wide window" safe, so the cursor can lag conservatively.
5. **Stall detection (belt-and-suspenders / honest fallback).** Independently of reconnects, if a room has an in-flight expectation (a mention was posted addressing a bot) and no follow-up within a timeout, surface it rather than hang silently: log a `room stall suspected` warning and optionally post a system notice (`@human — no response from @Ada in Ns`). This is the documented **best-effort** floor for anything reconciliation still can't recover (e.g. a message deleted before refetch).

**Guarantee we actually make:** best-effort delivery with automatic reconnect-time catch-up. A hop lost to a reconnect gap is recovered on the next `resume` (typically seconds); a hop lost to something reconciliation cannot see is caught by stall detection and escalated to a human. We do **not** claim exactly-once — we claim "no silent permanent stall from a transient gateway gap."

### Verification checklist
- `npm run build` clean; N clients construct and log in; each records a distinct `botUserId`.
- **Reconciliation:** simulate a missed `messageCreate` (feed a room message only via the reconciliation `fetch` path, not the live listener) → the addressed bot still routes exactly once. Feed the *same* message through both live listener and reconciliation → routed exactly once (de-dupe on `message.id` holds).
- **Cursor:** last-seen advances monotonically per (slot, channel); reconciliation fetches only `after` the cursor.
- A message mentioning Ben in a room: **only** Ben's listener calls `submitMessage`; Ada/others no-op (assert via a stub `submitMessage` spy across N bound handlers).
- Self message (Ben's own post) never routes on Ben's listener.
- A peer relay bot's post mentioning Ben **does** route on Ben's listener (peer allowlist works); a third-party bot's post does not.
- Non-room channel behavior for slot 0 is byte-for-byte the current behavior.
- **Slot 0 dual-role:** `/room` slash commands dispatch via slot 0's `interactionCreate` only; when slot 0 is *not* a room participant, no room `messageCreate` listener is attached to it (a room message does not route to slot 0); when slot 0 *is* invited, both bindings coexist without the command host swallowing chat or the room listener swallowing interactions. The room listener is attached at most once on slot 0 (no double-binding).

### Anti-pattern guards
- Exactly one process; one `db`; one ledger.
- Self-filter drops **self**, not "all bots."
- Room bots never touch non-room channels.
- Reconciliation reuses the **same** listener path (no parallel routing logic) and is idempotent — replay must never double-route (de-dupe on `message.id`).
- Do **not** treat the gateway as a durable queue — reconciliation + stall detection are mandatory, not optional; the honest contract is best-effort-with-catch-up, never exactly-once.

---

## Phase 4: Native routing bus + outbound send-as-bot + budget & loop brakes

The bus, adapted so **Discord is the transport** and the response is posted by the *right real bot* with native mentions.

### What to implement

1. **`src/core/room/bus.ts`** — reuse the baseline bus factory and its per-room serialization (`Map<roomKey, RoutedMessage[]>` + `processing: Set`, copied from `queue.ts:65-241`). The `RoomGateway.submitMessage` now takes an explicit `toAgentId` (the addressed bot's agent), because the gateway already resolved *who* was mentioned — the bus does **not** re-derive targets from the inbound text.
2. **Worker `processNext(roomKey)`** (serial per room, across all bots):
   1. Pre-check `status` (`paused`/`halted` → skip) and **budget**: if `spent_usd >= budget_usd` → set `halted`, post one system halt notice (via slot 0 / a reserved "system" persona), return. **Budget is checked before every `maestro.send`.**
   2. **Turn-depth brake (new, important for native model) — BURST counter, not lifetime:** maintain a per-room `turn_count`. Increment it on each **agent** turn (each `maestro.send` in the auto-relay chain); if it exceeds `max_turns` (new `rooms` column, default e.g. 30) → halt + notice. **`max_turns` bounds a single ping-pong burst, NOT the room's lifetime** — a healthy long-lived room must never be killed just for accumulating 30 agent turns over its life. Therefore the counter has an explicit **reset trigger**, and resets to `0` when **either**:
      - a **human** message is submitted into the room (a real user, not a peer relay bot) — a human turn re-arms the burst budget, because a human in the loop is the signal that the exchange is wanted; **and/or**
      - the room queue **drains** — when the worker finds no more inbound backlog and calls `processing.delete(roomKey)`, the auto-relay burst is over, so zero the counter for the next burst.

      Concretely: the counter climbs only across a *contiguous* agent↔agent chain and is cleared by human involvement or by the chain terminating. This makes `max_turns` a runaway-burst circuit-breaker (kills a tight A↔B loop between budget checks) without capping how long a room can usefully live. `/room reset` also zeroes it (see Phase 6).
   3. Build input = `buildPreamble(...)` + `\n\n[${fromHandle}]: ${text}`.
   4. `maestro.send(toAgentId, input, { sessionId: participant.session_id ?? undefined })`; persist session on first reply (mirror `queue.ts:176-178` via `roomsDb.updateParticipantSession`).
   5. `roomsDb.addSpend(roomKey, result.usage.totalCostUsd)`.
   6. `parseMentions(result.response, participants, { maxMentions })` → the ≤2 intended targets (self dropped, `@human`/none detected).
   7. **Echo guard:** hash the response; if equal to this agent's previous response in this room, suppress posting and log (kills a stuck agent repeating itself).
   8. **Render + rewrite:** `renderTables` → `renderNativeMentions(text, targets)` (turn `@Handle` into real `<@botUserId>`) → `splitMessage`. Two ordering/atomicity requirements, both mandatory:
      - **Rewrite before split** so mention *ordering* is fixed and mentions land in the first chunk.
      - **`splitMessage` must be mention-token-aware.** Rewrite-before-split fixes ordering but does **not** prevent the splitter from cutting *inside* a `<@snowflake>` token when content exceeds the 2000-char limit — a `<@12345` / `6789>` split yields two broken tokens that fire **no** ping, silently killing the hop. So `splitMessage` must treat any `<@…>` / `<@!…>` / `<@&…>` (and `<#…>`) token as **indivisible**: never place a chunk boundary inside one; if a token would straddle the boundary, break *before* it and carry the whole token to the next chunk. Undersized-token edge case: a single token longer than the chunk size is impossible in practice (snowflakes are ~20 digits), but assert the invariant anyway.
   9. **Outbound as the bound bot:** post via **that agent's bot client** (`slot → client` from the gateway manager) into the room channel/thread — `client.channels.fetch(...).send(...)` wrapped in `toRateLimitError` (mirror `adapter.ts:176-189`). Because the post contains real `<@BotB>` mentions, **Bot B's gateway will receive it and re-enter via `submitMessage`** — this *is* the next hop.
   10. **Do NOT internally enqueue the next hop.** (Model B.) If `parseMentions` found no targets, or only `@human`, the conversation drains naturally — nobody's gateway is pinged. `@human` additionally posts the configured human mention.
   11. Tail-call `processNext(roomKey)` to drain any *inbound* backlog for this room; when empty, `processing.delete(roomKey)`.
3. **`sendAs` on the Discord adapter** — implement the baseline's `sendAs(target, identity, msg)` capability for Discord as "post via the client bound to `identity.botUserId`/slot," not via a webhook. This keeps the `BridgeProvider.sendAs?` contract uniform: Slack/Teams `sendAs` masks via `chat:write.customize` (baseline), Discord `sendAs` picks the real bot client. The bus calls `provider.sendAs` regardless of provider; only the Discord implementation routes to a specific client.
4. **Wire into `src/index.ts`** — after `createQueue`, start the gateway manager (Phase 3) and `createRoomBus(...)`; set `ctx.rooms = roomBus`. The manager and bus share the `slot → client` map so the bus can pick the right client for outbound.

### Loop / cost brakes (full set, in the shared worker)

- **Hard per-room cost cap** (`budget_usd`) — before every send. Ultimate brake.
- **Turn-depth cap** (`max_turns`) — new; cheap guard tuned for the native ping-pong risk. **Burst-scoped, not lifetime:** resets to 0 on any human message into the room and on queue drain (`processing.delete`), so it caps a runaway agent↔agent burst without limiting the room's lifespan (see worker step 4.2). The human-message reset is applied where `submitMessage` classifies `fromHandle` as a real user (Phase 3 route step); the drain reset is at `processing.delete(roomKey)`.
- **Mention-gating** — an agent acts only when a real `<@botUserId>` names it. No mention anywhere → silence → room drains.
- **`maxMentions` cap + self-mention drop** — bounds fan-out per turn (baseline).
- **Echo detection** — suppresses a repeating agent.
- **`status` pause/halt** — human circuit-breaker (`/room pause|stop`), read by *every* bot's listener, so a halt instantly silences all N bots.

### Verification checklist
- `node --test` on `test/room-bus.test.ts` with a **stub gateway manager** (fake `slot → client` whose `.send` records posts) and **stub maestro**:
  - A message mentioning B routes one `maestro.send` to B's session; the posted text contains `<@B_userId>` when B's reply addresses C, and **no internal enqueue** happens for the C hop (assert the bus queue stays empty; the C hop would arrive only via a simulated gateway event).
  - Budget cap: cumulative `totalCostUsd ≥ budget_usd` → room halts, no further sends.
  - Turn cap: `max_turns` reached → halt.
  - `maxMentions=2`: a reply naming 3 handles rewrites+posts only 2 native mentions.
  - Self-mention dropped; echo suppresses a duplicate reply.
  - `renderNativeMentions` output posted verbatim contains real `<@id>` (not literal `@Handle`).
- **`splitMessage` mention-atomicity:** a >2000-char message with a `<@id>` mention placed right at the chunk boundary splits *before* the token — every emitted chunk that contains a mention contains the *whole* token (assert no chunk ends mid-`<@…>` and no chunk starts with a dangling `id>`).
- No `discord.js` import in `src/core/room/`.

### Anti-pattern guards
- **Never** enqueue the next hop internally — posting is the hop.
- Budget + turn checks **before** the send.
- One per-room lock across all bots (no concurrent worker for the same room even if two bots were mentioned at once — they serialize).
- Rewrite (`@Handle`→`<@id>`) runs **before** `splitMessage`, **and** `splitMessage` treats `<@…>` mention tokens as indivisible (never cuts a chunk boundary inside one).

---

## Phase 5: Onboarding checklist (manual bot creation — NOT automatable)

**There is no official Discord API to create bot tokens.** Each bot is a one-time manual Developer-Portal step. Ship this as a documented checklist in `docs/discord.md` (and reference it from `/room` errors when a slot is unconfigured).

**Per bot (repeat N times):**

1. **Create the application** — https://discord.com/developers/applications → *New Application* → name it (this becomes the persona, e.g. "Ada").
2. **Add the bot** — *Bot* tab → set username + avatar (the real, visible identity).
3. **Enable MESSAGE CONTENT INTENT** — *Bot* tab → *Privileged Gateway Intents* → toggle **Message Content Intent** on. (Server Members intent not required.)
4. **Copy the token** — *Reset Token* → copy → store as `DISCORD_ROOM_BOT_<n>_TOKEN`. **This is shown once.**
5. **Copy the Application (Client) ID** — *General Information* → store as `DISCORD_ROOM_BOT_<n>_CLIENT_ID` (this is also the bot's user id, used for native mentions).
6. **Invite to the guild** — *OAuth2 → URL Generator* → scopes `bot` → permissions `View Channel`, `Send Messages`, `Read Message History`, `Send Messages in Threads` (NOT `Manage Webhooks` — unneeded here) → open URL → add to the guild. Ensure the bot can see the room channel.

**Then, once, in the app config:** fill `DISCORD_ROOM_BOT_<n>_{TOKEN,CLIENT_ID,NAME}` and bump `DISCORD_ROOM_BOT_COUNT`; restart. `/room invite <agentId>` then binds an agent to the next free bot slot.

Automatable parts: **none of the token creation**; the invite URL can be pre-generated per client id, and `/room invite`/binding is fully automated. Make the checklist copy-pasteable and note the "token shown once" gotcha prominently.

---

## Phase 6: `/room` commands, migration/compat, verification & docs

### `/room` commands (baseline Phase 4, with slot binding)

Implement the baseline `/room` subcommands (`new`, `invite`, `kick`, `pause`/`resume`, `stop`, `reset`, `budget`, `status`) on the **control/host bot (slot 0)**. Deltas:

- **`invite <agentId>`** — resolves the agent, then honors the **global agent→bot binding** (Phase 2 §1): if the agent already has a bound slot, reuse it; otherwise allocate the **next free bot slot**, write the global binding, and bind it here. Enforces slot-uniqueness-per-room *and* the global one-agent-one-slot invariant; `addParticipant` with `bot_slot`. Reject an explicit `slot` that contradicts the agent's standing global binding (point at `/room rebind`). If no free/configured slot for a first-time bind → error pointing at the onboarding checklist (§Phase 5).
- **`rebind <agentId> <slot>`** (escape hatch) — the *only* sanctioned way to change an agent's global bot binding; updates `agent_bot_bindings` and warns that the agent's persona changes everywhere. Rare, deliberate, human-invoked.
- **`status`** — lists participants **with their bot persona** (handle + which real bot), status, `spent_usd`/`budget_usd`, and turn count. **Never** prints tokens.
- **`kick`** — frees the bot slot for reuse.
- `budget`/`reset`/`pause`/`resume`/`stop` unchanged from baseline (`reset` also zeroes the turn counter).

Slash-command registration for slot 0 unchanged (`adapter.ts:37-51` `COMMANDS`, `deploy.ts:3-19`, `npm run deploy-commands`).

### Migration / compatibility — recommendation

**Recommendation: keep BOTH, split by provider — do not delete the webhook path.**

- **Discord → real bots (primary).** Native pinging is the entire point; the webhook `sendAs` for Discord becomes a **documented fallback** for deployments that don't want to provision N bots (single-bot "masked personas" still work for a purely-mirrored, no-native-ping room). Gate on config: if room-bot slots are configured, use real bots; else fall back to the baseline webhook `sendAs`. This keeps the baseline plan shippable and lets a user opt into real bots incrementally.
- **Slack & Teams → keep webhook / `chat:write.customize` masking.** Real N-bots on Slack means N separate Slack apps per workspace, and on Teams N Azure bot registrations per tenant — operationally heavy and not what Chris asked for (his motivation is Discord-native pinging). So Slack/Teams stay on the baseline masking approach; the `sendAs` contract is the seam that lets one bus drive all three.
- **Net:** the baseline plan is **not** replaced — it is the substrate. This delta swaps *only Discord's* transport to real bots and adds a bot pool + multi-gateway manager. A deployment can run the webhook style everywhere, or real bots on Discord + masking on Slack/Teams, from the same kernel.

### Verification & docs (baseline Phase 5, plus delta items)

1. **Full suite green** + `npm run build` clean.
2. **Boundary grep:** `grep -rn "discord.js\|@slack/bolt" src/core/` → nothing (bot-pool schema + bus stay pure).
3. **Delta grep:** no bot token value in logs (redaction test); no internal next-hop enqueue in `bus.ts` for the Discord native path (code review + the bus test).
4. **Self-filter review:** room listener drops self, allows peer relay bots, drops third-party bots.
5. **Loop-safety review:** budget + turn checks precede every send; one per-room lock across all bots; rewrite-before-split.
6. **End-to-end smoke (Discord, ~3 real bots first, then scale to 6):** provision 2–3 bots via the checklist → `/room new` → `/room invite` two agents (each bound to a real bot) → human `@Ada` a task → observe Ada post as her real bot with a native `<@Ben>` mention → Ben's gateway picks it up → an A↔B exchange that **terminates** when a reply carries no mention; force the budget cap and confirm all bots go silent; hit the turn cap; `/room pause` mid-exchange and confirm instant silence; `/room stop`.
7. **Docs:** update `docs/discord.md` (bot-pool env, onboarding checklist, permissions delta — no `MANAGE_WEBHOOKS`, native-ping model, rotation runbook), `.env.example` (`DISCORD_ROOM_BOT_*`), and add a "Rooms — real bots vs. masking" note to `CLAUDE.md`/`AGENTS-providers.md` explaining the provider split and the `sendAs` seam.

### Success criteria (MVP)

A single Discord room with **2–6 real bot accounts**, each posting under its own genuine identity, **natively `@`-pinging each other** through the gateway, mention-routed by the shared kernel, with a hard cost cap + turn cap + echo/pause brakes, self/peer filter correct, `/room` commands working, and **bounded termination**: an exchange ends *organically* when a reply runs out of addressees, and is *forcibly* bounded by the turn/budget caps otherwise. We do **not** claim *provable* termination — two LLMs can mention each other indefinitely, so the actual guarantee is the burst turn-cap + cost cap, not a proof that the agents will stop on their own. Slack/Teams continue to work on the baseline masking path from the same bus.

---

## Build order summary

| Phase | Deliverable | Provider-touching? |
|---|---|---|
| 1 | Bot-pool config + secrets/rotation model | Discord config only |
| 2 | Baseline kernel data model + `bot_slot` + `renderNativeMentions` | No (kernel) |
| 3 | Multi-gateway manager + per-bot room listener + self/peer filter | Yes (Discord) |
| 4 | Native routing bus + send-as-bot + budget/turn/echo brakes + index wiring | Kernel + Discord |
| 5 | Manual bot-creation onboarding checklist | Docs |
| 6 | `/room` (slot binding) + migration recommendation + verification + docs | Yes |

Phase 2 is pure kernel (reuses the baseline). Phases 3–4 are where the real-bot tokens, multi-client gateways, and the native-ping transport come into play. The baseline webhook plan remains the fallback and the Slack/Teams path.
