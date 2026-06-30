# Research: Microsoft Teams as a Maestro Relay provider

**Status:** Research / feasibility — no code written yet.
**Date:** 2026-06-30
**Author:** Maestro-Relay agent

## TL;DR

Teams **fits the kernel cleanly — zero kernel changes required**. The `BridgeProvider`
contract in `src/core/types.ts` already anticipates Teams, and the Slack provider is a
good structural template. The work is entirely in a new `src/providers/teams/` directory
plus **one** Teams-specific concept the other providers don't have: a persisted
**conversation reference** per binding.

Teams is meaningfully *heavier to set up and operate* than Slack, for four reasons:

1. **No Socket Mode equivalent.** Teams bots are inbound-webhook only — production needs a
   public HTTPS endpoint; local dev needs a tunnel (Dev Tunnels / ngrok).
2. **Proactive sends require a stored `conversationReference`** (and the bot to be
   pre-installed in the team/chat). You can't "post to a channel id" with just a token the
   way Slack does.
3. **Bots cannot add reactions** in Teams — the `⏳` queued indicator has to be replaced
   (typing indicator or a status message).
4. **Setup is Azure-flavored**: an Azure Bot resource, an Entra app registration
   (single-tenant), an app **manifest** packaged as a zip and uploaded to the org catalog,
   and — if we want Slack-style auto-create-a-channel — admin-consented Graph permissions.

**Recommendation:** Feasible and worth doing. Ship it in two phases (below). Effort is
comparable to the Slack provider for the code, plus extra ops/docs surface for Azure +
manifest. Verdict: **green-light, phased.**

---

## 0. Scope decision — all conversation scopes, one app, DM-first phasing

> Revised after review. The earlier draft scoped this to personal/DM only; we then
> established that **channels can be supported by the same provider with the same binding
> code**, so the manifest declares all three scopes. The *phasing* below is the recommended
> rollout. See [`teams-provider-implementation-plan.md`](./teams-provider-implementation-plan.md)
> for the build steps.

Teams has **two unrelated surfaces**, and "channel" means different things in each:

1. **Teams → Channels.** A *Team* (e.g. "Engineering") contains *Channels* ("General",
   "Backend"), each with a threaded **Posts** tab. **This is `team` scope.** *Auto-creating* a
   channel is the Graph-API `POST /teams/{id}/channels` flow with admin consent — but *binding
   an existing* channel needs no Graph.
2. **Chat.** The left-rail Chat app: **1:1 chats** and **group chats**, outside any Team. The
   analogue of DMing a Slack/Discord bot. **This is `personal` / `groupChat` scope.**

**Decision: one manifest, `scopes: ["personal","groupChat","team"]`.** The binding model is
**scope-agnostic** — every surface is just a `conversation.id → agent` row in `agent_channels`,
so DMs, group chats, and channels share one code path. They differ only in UX:

| Surface | UX | Multi-agent story |
| --- | --- | --- |
| **DM (`personal`)** | one rebindable agent; switch with `agents new` | one agent at a time |
| **Channel (`team`)** | bind a channel with `agents new`; @mention the bot to drive it | channel-per-agent → parallel agents |
| **Group chat (`groupChat`)** | @mention the bot | one agent per group |

What's genuinely hard is **only auto-creating channels** (Graph + admin-consented app
permissions). Phase 1 avoids it entirely by binding channels the way Slack's manual fallback
does: admin installs the app to the team, a user runs `agents new <id>` in an existing channel.

What is **true regardless of scope** (the irreducible Teams costs):

- **Public HTTPS inbound endpoint** — Teams is webhook-only; no Socket Mode.
- **`conversationReference` storage** — needed for proactive `/api/send`; captured on the
  first inbound message from any conversation.
- **No bot reactions** — `⏳` unavailable; use the typing indicator.
- **It's a custom Teams app that must be installed** — see §1a for the M365/business
  governance that implies (plus a per-team install for channel scope).

**Recommended phasing** (rationale in the implementation plan's recommendation note):

- **Phase 1 — DM/personal (+ group) scope.** Validate the novel machinery (CloudAdapter
  wiring, `conversationReference` capture, proactive send, Azure setup) against the simplest
  surface. The DM rebind model is unique to Teams and worth landing clean.
- **Phase 2 — channel scope, mirroring Slack's channel + owner-bound thread + per-thread
  session pattern** (`teams_agent_threads`), *not* a divergent channel-level shortcut.
- **Phase 3 — Graph channel auto-create** (removes the manual channel-create step) and full
  `findOrCreateAgentChannel` parity.

The manifest declares all scopes from day one (cheap; avoids re-packaging), but the *code*
lands DM-first.

### 1a. M365 / business-tenant install governance (the unavoidable admin step)

Even a 1:1 chat bot is a **custom Teams app** backed by an Azure Bot + single-tenant Entra
app **in the customer's M365 tenant**. In a business tenant, installing it is governed by the
Teams admin:

- Since **2024-01-31**, users **cannot chat with a bot** unless they're covered by an **app
  setup policy that allows custom apps**.
  ([breaking change](https://m365admin.handsontek.net/breaking-security-change-ability-to-chat-with-bots-based-on-custom-app-policy/))
- Two distribution routes:
  1. **Sideload** (dev / few users) — admin enables custom-app upload in **Teams Admin
     Center → Teams apps → Setup policies**.
  2. **Org app catalog** ("Built for your org") — admin uploads once; ordinary users who
     can't sideload can then add it. The clean production route.
     ([upload custom app](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload))
- **Free/consumer Microsoft accounts**: custom-app upload is heavily restricted — this is
  effectively an **M365 business/enterprise (Entra-backed) feature**. Onboarding always
  involves **one admin action** (enable sideload, or catalog-publish). State this up front.

So vs Slack, the only genuinely-extra friction is: **(a) a public endpoint, and (b) an admin
enabling/publishing the app.** Everything else is comparable.

---

## 1. How a Teams bot actually works

A Teams bot is built on the **Bot Framework SDK v4** (`botbuilder` npm package). The moving
parts:

- An **Azure Bot** resource registers the bot and points it at a **messaging endpoint** —
  an HTTPS URL you host, conventionally `POST /api/messages`.
- When a user messages the bot, **Teams POSTs an `Activity` (JSON)** to that endpoint. The
  SDK's `CloudAdapter` validates the inbound JWT (using your app id/password/tenant) and
  routes the activity to a `TeamsActivityHandler` subclass (`onMessage`, `onMembersAdded`,
  `onReactionsAdded`, …).
- To **reply**, the handler calls `context.sendActivity(...)` on the turn context.
- To **send unprompted** ("proactive" — exactly what `/api/send` and
  `findOrCreateAgentChannel` do), you call
  `adapter.continueConversation(conversationReference, async (ctx) => ctx.sendActivity(...))`.
  The `conversationReference` must have been captured from a prior inbound activity (or
  constructed via Graph) and **stored**.

Auth model (current rules):

- `MicrosoftAppId` + `MicrosoftAppPassword` (client secret), `MicrosoftAppType`, and
  `MicrosoftAppTenantId`.
- **Multi-tenant bot type is deprecated** — new bots must be **SingleTenant** (or
  user-assigned managed identity). So Teams binds to a single Entra tenant, set via
  `MicrosoftAppTenantId`. ([Single-tenant config](https://learn.microsoft.com/en-us/answers/questions/5646162/how-to-configure-a-single-tenant-azure-bot-with-a))

### The big structural difference vs Discord/Slack

| Aspect | Discord | Slack | **Teams** |
| --- | --- | --- | --- |
| Inbound transport | Outbound gateway WebSocket (no inbound endpoint) | Socket Mode (WS) **or** HTTP webhook | **HTTP webhook only** — public HTTPS mandatory |
| Local dev | Just a token | Socket Mode, no tunnel | **Tunnel required** (Dev Tunnels/ngrok) |
| Send to arbitrary channel | Channel id + token | Channel id + token | **Needs stored `conversationReference`** |
| Bot adds reactions | Yes | Yes | **No — not supported** |
| Typing indicator | Yes | No (no-op) | **Yes** (`type: 'typing'`, re-send every ~4 s) |
| Command surface | Slash commands (API-registered) | Slash commands (API-registered) | **Typed bot commands** parsed from message text + manifest `commandList` |
| App install/deploy | `deploy-commands` REST call | Scopes + install in workspace | **Manifest zip** uploaded to org app catalog |

The Teams webhook story is closest to Slack's *webhook mode* (`ExpressReceiver`), so the
Slack provider's HTTP-server bits are the right reference — but Teams has **no Socket Mode
fallback at all**.

---

## 2. Mapping Teams → the `BridgeProvider` contract

Method-by-method, against `src/core/types.ts`:

### `start(ctx)`
- Build a `CloudAdapter` from `ConfigurationBotFrameworkAuthentication` (app id / password /
  type / tenant id).
- Stand up an HTTP server (restify or express) on `TEAMS_PORT`, route `POST /api/messages`
  → `adapter.process(req, res, (turnContext) => bot.run(turnContext))`.
- `bot` is a `TeamsActivityHandler` subclass whose `onMessage` does the
  Activity → `IncomingMessage` translation (this is the `messageCreate.ts` analogue) and
  calls `ctx.enqueue(msg)`.
- **Critically:** on every inbound activity, capture
  `TurnContext.getConversationReference(activity)` and **upsert it** into the Teams ref
  table (see §4). This is what makes later proactive sends possible.
- Validate `TEAMS_APP_ID` / `TEAMS_APP_PASSWORD` / `TEAMS_TENANT_ID` here (lazily, like
  `slackConfig`), throwing a clear error if missing — never at module load.

### `stop()`
- Close the HTTP server. No persistent WS to tear down.

### `resolveConversation(message)`
- Same shape as Slack: look up the agent binding by conversation id. Teams encodes
  channel + reply chain in the conversation id, so threads fall out naturally (see §3).
- Return `{ agentId, sessionId, readOnly, persistSession }`.

### `send(target, msg)`
- Look up the stored `conversationReference` for `target.channelId`.
- `await adapter.continueConversation(appId, ref, async (ctx) => { ctx.sendActivity({ text, textFormat: 'markdown' }) })`.
- Render `mention` via Teams entity mentions (or a simple prefix) using
  `TEAMS_MENTION_USER_ID`, mirroring Slack's `<@id>` prefix.
- **Rate limits:** Teams/Bot Framework returns `429` with a `Retry-After` header. Write a
  `toRateLimitError(err)` helper (convert seconds → ms) exactly like the Slack/Discord
  exported helpers, throwing the kernel's `RateLimitError`. ([typed-error contract](../../AGENTS-providers.md))
- If no stored ref exists for the target → throw a clear error (analogous to Slack's
  orphan-thread log). This is the Teams equivalent of "we were never installed here."

### `findOrCreateAgentChannel(agentId)` — the hard one
Slack just creates a public channel and posts. Teams can't do that transparently: proactive
messaging requires the **app to be installed** in the target team/chat *and* a valid
`conversationReference`. Two strategies:

- **Phase 1 (recommended): inbound-bootstrapped.** Do **not** auto-create channels. A human
  adds the bot to a channel (or @mentions it / DMs it) once; that inbound activity gives us
  the `conversationReference`, which we persist keyed to the agent. `findOrCreateAgentChannel`
  then just looks up the existing binding and throws `AgentNotFoundError` /a descriptive
  "agent has no bound Teams conversation yet" error if none exists. Matches how Slack
  threads are owner-bootstrapped by a mention today.
- **Phase 2: Graph auto-create.** `POST /teams/{team-id}/channels` to create a channel, then
  proactively install the app and fetch the reference via Graph. This needs **admin-consented
  application Graph permissions** (`Channel.Create`, `TeamsAppInstallation.ReadWriteForTeam`,
  `TeamsAppInstallation.ReadWriteSelfForTeam`, etc.) and a configured target team id. Heavier;
  defer. ([Authorize proactive install](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/proactive-bots-and-messages/graph-proactive-bots-and-messages), [Create channel](https://learn.microsoft.com/en-us/graph/api/channel-post))

### `react?(target, emoji)` — OMIT
**Bots cannot add reactions in Teams** — the reaction bar is owned by the Teams client; the
API only lets bots *receive* `messageReaction` events, not add them.
([confirmed limitation](https://learn.microsoft.com/en-us/answers/questions/5550099/prevent-bot-from-entering-typing-state-when-users))
`react` is optional in the contract, so the cleanest answer is to **not implement it**. The
kernel currently uses `react` for the `⏳` queued indicator — on Teams that indicator simply
won't appear. If we want a queued cue, options: (a) `sendTyping`, or (b) post a short
"⏳ queued…" activity and overwrite/clean it up (Teams supports `updateActivity`).
Recommend (a) for v1.

### `sendTyping?(target)` — IMPLEMENT
Teams supports an `Activity` of `type: 'typing'`. It lasts only a few seconds, so for long
agent runs the indicator should be re-sent every ~4 s. Implement as a single typing send for
v1 (the kernel calls it once per turn); a keep-alive loop is a nice-to-have.

### `isReady()`
- Return a `started` boolean, like Slack.

---

## 3. Threads, channels, and conversation identity

- Teams **channel messages** form **reply chains** (threads). A new root message starts a
  chain; replies attach via the same conversation id with a `;messageid=<root>` suffix. This
  maps onto the kernel's `isThread` + "channelId equals threadId for thread messages" model
  the same way Slack's `thread_ts` does.
- Teams also has **group chats** and **1:1 chats** — each is just another conversation id, so
  they work as agent bindings with no special handling.
- Practically: store the **conversation id** as `agent_channels.channel_id` (provider
  `'teams'`), and persist the matching `conversationReference` JSON alongside it. Thread
  isolation à la Discord/Slack (one Maestro session per reply chain) is an optional v2 layer
  using a `teams_agent_threads` table.

---

## 4. Storage

- **Shared `agent_channels`** (keyed `(provider, channel_id)`): store the Teams conversation
  id as `channel_id`, `provider='teams'`. Wrap in a `channelsDb.ts` like Slack's.
- **New Teams-only table — the one genuinely novel piece:**

  ```sql
  CREATE TABLE IF NOT EXISTS teams_conversation_refs (
    conversation_id TEXT PRIMARY KEY,
    reference_json  TEXT NOT NULL,   -- serialized ConversationReference
    service_url     TEXT NOT NULL,
    tenant_id       TEXT,
    updated_at      INTEGER NOT NULL
  );
  ```

  Upserted on every inbound activity; read by `send()` / `findOrCreateAgentChannel()` to drive
  `continueConversation`. Without this, proactive sends are impossible. Add it to
  `src/core/db/migrations.ts` (idempotent, `teams_*` naming per convention).
- Optional v2: `teams_agent_threads` mirroring `slack_agent_conversations` for per-reply-chain
  session isolation + owner gating.

---

## 5. Environment variables

```env
# --- Teams provider (loaded only if 'teams' is in ENABLED_PROVIDERS) ---
TEAMS_APP_ID=                 # Entra app (client) ID of the bot           (required)
TEAMS_APP_PASSWORD=           # client secret                              (required)
TEAMS_APP_TYPE=SingleTenant   # SingleTenant (new bots) | MultiTenant (deprecated)
TEAMS_TENANT_ID=              # Entra tenant id (required for SingleTenant)
TEAMS_PORT=3978               # HTTP port for the /api/messages endpoint
TEAMS_PUBLIC_URL=             # public HTTPS URL Teams POSTs to (docs/ops only)
TEAMS_ALLOWED_USER_IDS=       # CSV of AAD object ids allowed to run commands (empty = all)
TEAMS_MENTION_USER_ID=        # user to @mention when API callers pass mention=true
```

Loaded lazily via getters (copy `src/providers/slack/config.ts`). `3978` is the Bot
Framework convention.

---

## 6. Command surface

Teams has **no Slack-style slash-command dispatch**. The equivalents:

- **Typed bot commands** — the user types `@bot agents list`; `onMessage` parses the text.
  The manifest's `commandList` only provides autocomplete hints, not routing.
- Message extensions / Adaptive Card actions (richer, out of scope for v1).

So `/health`, `/agents`, `/session` become **text-prefix commands** parsed inside
`messageCreate.ts`, reusing the existing command handler logic where possible. This is a real
divergence from Discord/Slack and should be called out in `docs/teams.md`. Like Slack, ship a
**reduced** surface first (`health`, `agents`, `session`).

---

## 7. Output formatting

- Teams text messages support a **markdown subset** (`textFormat: 'markdown'`): bold, italics,
  links, lists, inline code, code fences. **Native markdown tables are not reliably
  rendered** in plain messages (real tables need Adaptive Cards).
- This is exactly why the relay already renders agent tables as **fenced ASCII** (shipped in
  v0.4.0). That approach works on Teams since code fences render — **no new rendering work
  needed**, same win as Slack. ([table format notes](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-format))
- **Message size:** practical text-activity limit is well under the ~100 KB hard cap
  (Microsoft recommends keeping the message body modest; oversize → `413
  MessageSizeTooBig`). Add a `TEAMS` chunk-size constant for `splitMessage` (a conservative
  ~16–18 KB is safe; the kernel already handles chunking). ([size limits](https://github.com/microsoft/BotFramework-Services/issues/228))

---

## 8. Setup & deploy ("deploy-commands" analogue)

Unlike Discord (one REST call) or Slack (toggle scopes), Teams requires an **app package**:

1. Create an **Azure Bot** resource + **Entra app registration** (single-tenant); generate a
   client secret. Set the messaging endpoint to `https://<host>/api/messages`.
2. Author a **Teams app manifest** (`manifest.json`) + two icons, zipped. Declare the bot,
   its scopes (`team`, `groupChat`, `personal`), and `commandList`.
3. **Upload/sideload** the package to the org's app catalog (admin) or sideload for dev.
4. For Phase 2 Graph auto-create: grant + admin-consent the Graph application permissions.

The installer/`maestro-relay-ctl deploy` story: there's no "register commands" API call to
make. The Teams `deploy` step is **"produce the app package"** (and optionally publish via
Graph `appCatalogs`). For v1, document manual upload; optionally add a
`src/providers/teams/deploy.ts` that emits the zip.

---

## 9. Proposed file layout

```
src/providers/teams/
├── adapter.ts          # TeamsProvider implements BridgeProvider
├── config.ts           # TEAMS_* env (lazy getters, copy slack/config.ts)
├── messageCreate.ts    # Activity → IncomingMessage; command parsing; ref capture
├── channelsDb.ts       # provider='teams' wrapper over agent_channels
├── conversationRefsDb.ts  # teams_conversation_refs CRUD  ← the novel piece
├── commands/           # health.ts, agents.ts, session.ts (text-dispatched)
└── deploy.ts           # (optional) emit/publish the Teams app package
```

Plus: `loadProvider` case in `src/core/providers.ts`; migration in
`src/core/db/migrations.ts`; `.env.example` section; `docs/teams.md`; `install.sh`
`normalize_module` allow-list + `maestro-relay-ctl` deploy routing; README provider list.

---

## 10. Risks / open questions

1. **Public HTTPS endpoint is mandatory.** Discord (gateway WS) and Slack (Socket Mode) can
   run with zero inbound exposure; Teams cannot. This changes the deployment story — needs a
   reverse proxy / tunnel and is the single biggest adoption friction. *Decision needed:* is
   exposing an inbound endpoint acceptable for the relay's typical "runs locally next to
   Maestro" model? (Dev: tunnel. Prod: real cert + DNS.)
2. **`findOrCreateAgentChannel` parity.** True Slack-style auto-create needs Graph + admin
   consent. Phase 1 deliberately drops to "bot must be added first," which slightly changes
   the `/api/send` UX for unbound agents (returns an actionable error instead of silently
   creating a channel). *Acceptable?*
3. **No bot reactions** → the `⏳` queued indicator is gone on Teams. Confirm typing-indicator
   (or status-message) substitute is acceptable, or consider adding an optional kernel hook
   for a generic "status" affordance providers can implement differently.
4. **Single-tenant only** → one relay instance binds to one Entra tenant. Multi-org support
   would need the deprecated multi-tenant type or multiple registrations. Probably fine.
5. **Manifest/packaging ops** are heavier than the other two providers and partly manual
   (admin upload). Docs burden.
6. **SDK surface:** `botbuilder` pulls a non-trivial dependency tree (restify, auth libs).
   Confirm we're OK adding it as an optional dep loaded only when `teams` is enabled (the
   dynamic-import pattern in `loadProvider` already keeps it out of Discord/Slack-only runs).

---

## 11. Recommended phasing

**Phase 1 — inbound-driven MVP (the bulk of the value):**
- `TeamsProvider` with `start`/`stop`/`resolveConversation`/`send`/`isReady`/`sendTyping`.
- `teams_conversation_refs` table + ref capture on every inbound activity.
- `findOrCreateAgentChannel` = lookup-only (bot must be added to the conversation first).
- Text-dispatched `health` / `agents` / `session` commands.
- ASCII-table rendering reused as-is; `TEAMS` split limit constant.
- No `react`. `toRateLimitError` helper + typed errors.
- `docs/teams.md`, `.env.example`, manifest template, manual-upload instructions.

**Phase 2 — full parity / polish:**
- Graph-based channel auto-create + proactive app install for real
  `findOrCreateAgentChannel`.
- Per-reply-chain session isolation + owner gating (`teams_agent_threads`).
- Typing keep-alive loop; optional status-message queued indicator.
- `deploy.ts` that builds/publishes the app package; installer module wiring.

---

## 12. Bottom line

Teams is a **good fit for the kernel and a sensible third provider.** The contract needs no
changes; the Slack provider is a close template for ~80% of the code. The genuinely new work
is small and well-contained: **persisting a `conversationReference` per binding** and driving
sends through `continueConversation`. The real cost is **operational** — a public endpoint, an
Azure/Entra registration, and a manifest package — not architectural. Recommend proceeding
with the Phase 1 MVP.

---

## Sources

- [Introduction to Bots in Teams Apps](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/bot-v3/bots-overview)
- [Send and receive messages with a bot](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/bot-v3/bot-conversations/bots-conversations)
- [Send proactive messages (Teams)](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [Send proactive notifications (Bot Service)](https://learn.microsoft.com/en-us/azure/bot-service/bot-builder-howto-proactive-message?view=azure-bot-service-4.0)
- [Configure single-tenant Azure Bot + app registration](https://learn.microsoft.com/en-us/answers/questions/5646162/how-to-configure-a-single-tenant-azure-bot-with-a)
- [Add authentication to a bot (Bot Framework SDK)](https://learn.microsoft.com/en-us/azure/bot-service/bot-builder-authentication?view=azure-bot-service-4.0)
- [Bots can't add reactions — confirmed limitation](https://learn.microsoft.com/en-us/answers/questions/5550099/prevent-bot-from-entering-typing-state-when-users)
- [Conversation events in your Teams bot (reactions/typing)](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/subscribe-to-conversation-events)
- [Format text in cards / markdown & table support](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-format)
- [Message size limits (413 MessageSizeTooBig)](https://github.com/microsoft/BotFramework-Services/issues/228)
- [Authorize proactive bot installation (Graph)](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/proactive-bots-and-messages/graph-proactive-bots-and-messages)
- [Create channel — Microsoft Graph v1.0](https://learn.microsoft.com/en-us/graph/api/channel-post?view=graph-rest-1.0)
