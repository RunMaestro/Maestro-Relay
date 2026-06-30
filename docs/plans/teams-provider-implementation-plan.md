# Implementation Plan: Microsoft Teams provider (all conversation scopes)

**Companion to:** [`teams-provider-research.md`](./teams-provider-research.md)
**Status:** Plan — ready to execute. No code written yet.
**Date:** 2026-06-30 (rev. — multi-scope, DM-first)
**Scope decision (locked):** a **single app declaring all three scopes** —
`["personal", "groupChat", "team"]` — because the binding model is **identical** across them
(every Teams surface is just a `conversation.id → agent` row). The manifest carries all scopes
from day one (free; avoids re-packaging later), but the **code lands DM-first**.

- **DM (`personal`)** — one rebindable agent ("single agent, switch with `agents new`").
- **Channel (`team`)** — one agent per channel = Discord/Slack "channel-per-agent."
- **Group chat (`groupChat`)** — one agent per group; falls out for free.

### Recommendation: DM-first, channels the Slack way

> **This is the recommended sequencing, chosen to match the existing codebase** (CLAUDE.md:
> *"Follow existing patterns in `src/providers/{discord,slack}/` before introducing new
> abstractions"*) rather than landing all scopes at once.

| Phase | Scope | Session model | Graph? |
| --- | --- | --- | --- |
| **1** | DM (`personal`) + group | per-conversation (the chat *is* the session) | no |
| **2** | Channel (`team`) | **mirror Slack**: channel bound → @mention spawns an owner-bound thread → **session-per-thread** (`teams_agent_threads`), `isThread:true` | no (manual channel create) |
| **3** | Channel auto-create | — | yes (admin-consented Graph) |

**Why DM-first:** the unknowns here are the Bot Framework/`CloudAdapter` plumbing,
`conversationReference` capture, proactive send, and Azure/manifest setup — *not* the binding
table. Prove those against the simplest surface first. The **DM rebind model is unique to Teams
(no Slack/Discord prior art)** and deserves to land clean on its own.

**Why channels in Phase 2 (not 1):** Discord and Slack both bind a channel to an agent and then
carry the actual session on an **owner-bound thread** (`slack_agent_conversations`,
`discord_agent_threads`; `isThread`/owner-gating are already first-class in the kernel). A
"one session per channel" shortcut would be a *new, divergent* pattern. Building channels the
Slack way keeps the provider recognizable and reuses the kernel's existing thread path. The
channel/thread details in §7.1's table and the manifest's `team` scope are therefore **Phase 2
build targets**, declared now but implemented after the DM MVP ships.

---

## 0. Guiding principles

- **Zero kernel changes.** Everything lives under `src/providers/teams/` plus one idempotent
  DB migration and the single `loadProvider` case. The kernel (`src/core/`) keeps zero
  platform-SDK imports. Verified against the current code:
  - The queue already splits outbound text (`splitMessage`, default 1990 chars — far under
    Teams' ~28 KB limit, so no per-provider limit work needed) and already renders agent
    tables to fenced ASCII via `renderTables` in `src/core/queue.ts:195`. **Table rendering
    is free** on Teams.
  - The queue calls `provider.react` and `provider.sendTyping` **only if present**
    (`src/core/queue.ts:117,128`). We omit `react` (Teams bots can't add reactions) and
    implement `sendTyping`.
  - Usage stats are posted by the kernel as a separate `send` (`queue.ts:216`) — no provider
    work.
- **Mirror Slack**, the closest template: lazy config getters, a `channelsDb.ts` wrapper, a
  provider-specific DB table, exported pure helpers for unit tests, `toRateLimitError`.
- **Bootstrap by first message.** The conversation reference (the Teams-only novelty) is
  captured the moment a user first messages the bot — no Graph, no pre-provisioning.

---

## 1. Dependencies

Add to `package.json` `dependencies`:

```jsonc
"botbuilder": "^4.23.0",   // Bot Framework SDK v4 (CloudAdapter, TeamsActivityHandler)
"restify": "^11.1.0"       // HTTP server for the /api/messages endpoint (official sample stack)
```

Add to `devDependencies`: `"@types/restify": "^8.5.12"`.

> These are always installed but **loaded only when `teams` is enabled** (dynamic `import()`
> in `loadProvider`), so Discord/Slack-only deployments never touch them at runtime. Document
> the extra install weight in `docs/teams.md`. (`express` would work too, but `restify` matches
> the official Bot Framework samples and `CloudAdapter.process(req, res, logic)`.)

---

## 2. Phase A — External setup (Azure / Entra / manifest)

This is the customer/admin-side prerequisite work. Capture it as a runbook in `docs/teams.md`;
no relay code depends on *how* it's done, only on the resulting credentials.

1. **Entra app registration** (single-tenant): create an app, note **Application (client) ID**
   → `TEAMS_APP_ID`; create a **client secret** → `TEAMS_APP_PASSWORD`; note the **Directory
   (tenant) ID** → `TEAMS_TENANT_ID`.
2. **Azure Bot resource**: create one, set **App type = Single Tenant**, link the app
   registration above, set the **messaging endpoint** to
   `https://<public-host>/api/messages`. Enable the **Microsoft Teams** channel.
3. **Teams app package** (`appPackage/`): `manifest.json` + `color.png` (192×192) +
   `outline.png` (32×32), zipped. Minimal manifest:
   ```jsonc
   {
     "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
     "manifestVersion": "1.19",
     "id": "<TEAMS_APP_ID>",
     "name": { "short": "Maestro Relay", "full": "Maestro Relay" },
     "description": { "short": "Chat with your Maestro agents", "full": "..." },
     "developer": { "name": "...", "websiteUrl": "https://maestro.sh", "privacyUrl": "...", "termsOfUseUrl": "..." },
     "icons": { "color": "color.png", "outline": "outline.png" },
     "bots": [{
       "botId": "<TEAMS_APP_ID>",
       "scopes": ["personal", "groupChat", "team"],
       "supportsFiles": true,
       "isNotificationOnly": false,
       "commandLists": [{
         "scopes": ["personal", "groupChat", "team"],
         "commands": [
           { "title": "health",  "description": "Check relay health" },
           { "title": "agents",  "description": "List / bind Maestro agents" },
           { "title": "session", "description": "Reset the conversation session" }
         ]
       }]
     }],
     "permissions": ["identity", "messageTeamMembers"],
     "validDomains": ["<public-host>"]
   }
   ```
   `scopes` is `["personal","groupChat","team"]` — one package serves DMs, group chats, and
   channels. The admin can install it **for users** (personal) and/or **to specific teams**
   (team) from the same upload.
4. **Install in the tenant** (one admin action, unavoidable — see research §1a):
   - Dev: enable **custom-app upload** in Teams Admin Center → Teams apps → Setup policies,
     then sideload the zip.
   - Prod: admin uploads the zip to **"Built for your org"** so non-admin users can add it.
   - **For channel binding:** the app must also be **added to each team** whose channels you
     want to use (Teams → ⋯ → Manage team → Apps → add it, or admin pre-provision). This is
     what lets the bot see @mentions in that team's channels and post into them. DM/group use
     needs only the personal install above.
5. **Public endpoint**: expose `https://<public-host>/api/messages`. Dev = Dev Tunnels/ngrok;
   prod = reverse proxy with a real cert. This is mandatory (no Socket Mode).

**Deliverable:** `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID`, and a reachable
HTTPS endpoint.

---

## 3. Phase B — Configuration (`src/providers/teams/config.ts`)

Copy `slack/config.ts`'s lazy-getter pattern so a disabled Teams provider never fails on
missing env.

```ts
import { required } from '../../core/config';

function csv(key: string): string[] { /* same as slack/config.ts */ }

export const teamsConfig = {
  get appId()    { return required('TEAMS_APP_ID'); },
  get appPassword() { return required('TEAMS_APP_PASSWORD'); },
  get appType()  { return process.env.TEAMS_APP_TYPE || 'SingleTenant'; },
  get tenantId() { return required('TEAMS_TENANT_ID'); },   // required for SingleTenant
  get port()     { const p = parseInt(process.env.TEAMS_PORT ?? '', 10);
                   return Number.isNaN(p) || p < 1 || p > 65535 ? 3978 : p; },
  get publicUrl(){ return process.env.TEAMS_PUBLIC_URL || ''; },
  get allowedUserIds() { return csv('TEAMS_ALLOWED_USER_IDS'); },
  get mentionUserId()  { return process.env.TEAMS_MENTION_USER_ID || ''; },
};
```

`.env.example` block:

```env
# --- Teams provider (loaded only if 'teams' is in ENABLED_PROVIDERS) ---
TEAMS_APP_ID=                 # Entra app (client) ID                       (required)
TEAMS_APP_PASSWORD=           # client secret                               (required)
TEAMS_APP_TYPE=SingleTenant   # SingleTenant (new bots) | MultiTenant (deprecated)
TEAMS_TENANT_ID=              # Entra tenant id (required for SingleTenant)
TEAMS_PORT=3978               # HTTP port for the /api/messages endpoint
TEAMS_PUBLIC_URL=             # public HTTPS base Teams POSTs to (docs/ops only)
TEAMS_ALLOWED_USER_IDS=       # CSV of AAD object ids allowed to run commands (empty = all)
TEAMS_MENTION_USER_ID=        # user to @mention when API callers pass mention=true
```

---

## 4. Phase C — Storage

### 4.1 Migration (`src/core/db/migrations.ts`)

Add an idempotent `ensureTeamsConversationsTable(db)` to `runMigrations()` (append, never
reorder existing migrations). The Teams-only table persists the **conversation reference** —
the one thing that makes proactive `/api/send` possible.

```ts
function ensureTeamsConversationRefsTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS teams_conversation_refs (
      conversation_id TEXT PRIMARY KEY,   -- Teams activity.conversation.id (= our channelId)
      reference_json  TEXT NOT NULL,       -- serialized ConversationReference
      service_url     TEXT NOT NULL,
      tenant_id       TEXT,
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}
```

Update the migration-history comment block at the top.

### 4.2 `src/providers/teams/conversationRefsDb.ts` (the novel piece)

```ts
import type { Database } from 'better-sqlite3';
import { db } from '../../core/db';

export function createConversationRefsDb(database: Database) {
  return {
    upsert(conversationId: string, ref: unknown, serviceUrl: string, tenantId: string | null) {
      database.prepare(`
        INSERT INTO teams_conversation_refs (conversation_id, reference_json, service_url, tenant_id, updated_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(conversation_id) DO UPDATE SET
          reference_json=excluded.reference_json,
          service_url=excluded.service_url,
          tenant_id=excluded.tenant_id,
          updated_at=excluded.updated_at
      `).run(conversationId, JSON.stringify(ref), serviceUrl, tenantId);
    },
    get(conversationId: string): { reference: unknown } | undefined {
      const row = database.prepare(
        'SELECT reference_json FROM teams_conversation_refs WHERE conversation_id = ?',
      ).get(conversationId) as { reference_json: string } | undefined;
      return row ? { reference: JSON.parse(row.reference_json) } : undefined;
    },
    remove(conversationId: string) {
      database.prepare('DELETE FROM teams_conversation_refs WHERE conversation_id = ?').run(conversationId);
    },
  };
}
export const conversationRefsDb = createConversationRefsDb(db);
```

### 4.3 `src/providers/teams/channelsDb.ts`

Verbatim copy of `slack/channelsDb.ts` with `'slack'` → `'teams'`. Binds the Teams
conversation id (stored as `channel_id`) to a Maestro agent in the shared `agent_channels`
table. `findOrCreateAgentChannel` and `resolveConversation` read it.

> No `teams_agent_threads` table in Phase 1. Teams' 1:1/group chat is itself the conversation;
> per-reply-chain session isolation is a Phase 2 nicety.

---

## 5. Phase D — The adapter (`src/providers/teams/adapter.ts`)

### 5.1 Construction & lifecycle

```ts
import { CloudAdapter, ConfigurationBotFrameworkAuthentication,
         ConfigurationServiceClientCredentialFactory, TurnContext } from 'botbuilder';
import * as restify from 'restify';
import type { BridgeProvider, /* ... */ } from '../../core/types';

export class TeamsProvider implements BridgeProvider {
  readonly name = 'teams';
  private adapter: CloudAdapter | null = null;
  private server: restify.Server | null = null;
  private started = false;

  async start(ctx: KernelContext): Promise<void> {
    const auth = new ConfigurationBotFrameworkAuthentication({}, new ConfigurationServiceClientCredentialFactory({
      MicrosoftAppId: teamsConfig.appId,
      MicrosoftAppPassword: teamsConfig.appPassword,
      MicrosoftAppType: teamsConfig.appType,
      MicrosoftAppTenantId: teamsConfig.tenantId,
    }));
    this.adapter = new CloudAdapter(auth);
    this.adapter.onTurnError = async (turnCtx, err) => {
      void logger.error('teams/turn', String(err));
    };

    const bot = new MaestroTeamsBot(ctx);            // TeamsActivityHandler subclass (§5.3)
    const server = restify.createServer();
    server.use(restify.plugins.bodyParser());
    server.post('/api/messages', (req, res) =>
      this.adapter!.process(req, res, (turnCtx) => bot.run(turnCtx)));
    await new Promise<void>((resolve) =>
      server.listen(teamsConfig.port, () => resolve()));
    this.server = server;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server = null; this.adapter = null; this.started = false;
  }
  isReady(): boolean { return this.started; }
```

### 5.2 `send` — proactive via `continueConversationAsync`

The crux. Look up the stored reference and drive the send through it.

```ts
  async send(target: ChannelTarget, msg: OutgoingMessage): Promise<void> {
    if (!this.adapter) throw new Error('Teams adapter not initialised');
    const stored = conversationRefsDb.get(target.channelId);
    if (!stored) {
      void logger.error('teams/send:no-ref', `conversation=${target.channelId}`);
      throw new Error(`No conversation reference for ${target.channelId}`);
    }
    let text = msg.text;
    if (msg.mention && teamsConfig.mentionUserId) {
      text = `<at>${teamsConfig.mentionUserId}</at> ${text}`;  // entity mention; see note
    }
    try {
      await this.adapter.continueConversationAsync(
        teamsConfig.appId,
        stored.reference as Partial<ConversationReference>,
        async (turnCtx) => { await turnCtx.sendActivity({ text, textFormat: 'markdown' }); },
      );
    } catch (err) {
      const rl = toRateLimitError(err);
      if (rl) throw rl;
      throw err;
    }
  }
```

> **Mention rendering:** a real Teams `@mention` needs an `entities` array alongside the
> `<at>` tag. For v1 a plain `text` prefix (display name) is acceptable and simpler; upgrade
> to a proper entity mention in Phase 2. Keep `send` rendering minimal, mirroring Slack's
> `<@id>` prefix.

### 5.3 The activity handler (`src/providers/teams/messageCreate.ts`)

A `TeamsActivityHandler` subclass — the `messageCreate.ts` analogue. Two jobs: **capture the
ref on every turn**, and translate user messages into `IncomingMessage` (or dispatch a typed
command).

```ts
export class MaestroTeamsBot extends TeamsActivityHandler {
  constructor(private ctx: KernelContext) {
    super();
    this.onMessage(async (turnCtx, next) => {
      // 1. Always persist the conversation reference (enables proactive /api/send).
      const ref = TurnContext.getConversationReference(turnCtx.activity);
      conversationRefsDb.upsert(
        turnCtx.activity.conversation.id, ref,
        turnCtx.activity.serviceUrl,
        turnCtx.activity.conversation.tenantId ?? null,
      );

      const userId = turnCtx.activity.from?.aadObjectId ?? turnCtx.activity.from?.id ?? '';
      const userName = turnCtx.activity.from?.name ?? userId;
      const text = (turnCtx.activity.text ?? '').trim();        // SDK strips the bot @mention
      if (!text) { await next(); return; }

      // 2. Command dispatch (Teams has no slash commands — parse text).
      if (await tryHandleCommand(turnCtx, text, userId)) { await next(); return; }

      // 3. Ensure the conversation is bound to an agent.
      const binding = channelDb.get(turnCtx.activity.conversation.id);
      if (!binding) {
        await turnCtx.sendActivity(
          'This chat is not bound to a Maestro agent yet. Use `agents new <agent-id>`.');
        await next(); return;
      }
      if (teamsConfig.allowedUserIds.length && !teamsConfig.allowedUserIds.includes(userId)) {
        await next(); return;
      }

      // 4. Translate → IncomingMessage and enqueue.
      const message: IncomingMessage = {
        provider: 'teams',
        messageId: turnCtx.activity.id ?? turnCtx.activity.conversation.id,
        channelId: turnCtx.activity.conversation.id,
        authorId: userId,
        authorName: userName,
        content: text,
        attachments: mapAttachments(turnCtx.activity.attachments),  // §6
        isThread: false,
        raw: turnCtx.activity,
      };
      this.ctx.enqueue(message);
      await next();
    });

    // Optional: greet + capture ref when the bot is added to a chat.
    this.onMembersAdded(async (turnCtx, next) => {
      const ref = TurnContext.getConversationReference(turnCtx.activity);
      conversationRefsDb.upsert(turnCtx.activity.conversation.id, ref,
        turnCtx.activity.serviceUrl, turnCtx.activity.conversation.tenantId ?? null);
      await turnCtx.sendActivity('Maestro Relay is connected. Type `agents list` to begin.');
      await next();
    });
  }
}
```

Export a pure `translateActivity(activity): IncomingMessage` helper so it can be unit-tested
**without** the SDK runtime (per AGENTS-providers testing guidance).

### 5.4 `resolveConversation`

```ts
  resolveConversation(message: IncomingMessage): ConversationRecord | null {
    const binding = channelDb.get(message.channelId);
    if (!binding) return null;
    return {
      agentId: binding.agent_id,
      sessionId: binding.session_id ?? null,
      readOnly: !!binding.read_only,
      persistSession: (sessionId) => channelDb.updateSession(message.channelId, sessionId),
    };
  }
```

(Flat — no thread branch in Phase 1, since the chat *is* the conversation.)

### 5.5 `sendTyping`

```ts
  async sendTyping(target: ChannelTarget): Promise<void> {
    const stored = conversationRefsDb.get(target.channelId);
    if (!this.adapter || !stored) return;
    await this.adapter.continueConversationAsync(teamsConfig.appId,
      stored.reference as Partial<ConversationReference>,
      async (c) => { await c.sendActivity({ type: 'typing' }); });
  }
```

(No `react` — Teams bots cannot add reactions. Omitting it is contract-legal; the kernel skips
the `⏳` indicator on Teams. The typing indicator is the substitute.)

### 5.6 `findOrCreateAgentChannel`

Phase 1 = **lookup-only** (no Graph). A binding only exists once a human has chatted with the
bot and run `agents new`.

```ts
  async findOrCreateAgentChannel(agentId: string): Promise<AgentChannelInfo> {
    const existing = channelDb.getByAgentId(agentId);
    if (existing) return { channelId: existing.channel_id, agentId, agentName: existing.agent_name };
    // No way to create a 1:1 chat proactively without the user having installed the bot.
    throw new AgentNotFoundError(agentId);   // → 404 from POST /api/send, with a clear message
  }
```

> Document this UX in `docs/teams.md`: agent-initiated pushes (`/api/send`,
> `maestro-relay notify`) only work **after** the agent has been bound in a Teams chat. This
> is the deliberate Phase-1 tradeoff for dropping Graph.

### 5.7 `toRateLimitError`

Exported pure helper (unit-tested). Bot Framework throws on HTTP 429; surface `Retry-After`
(seconds → ms) as the kernel's `RateLimitError`.

```ts
export function toRateLimitError(err: unknown): RateLimitError | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { statusCode?: number; headers?: Record<string,string>; retryAfter?: number };
  if (e.statusCode !== 429) return null;
  const secs = e.retryAfter ?? Number(e.headers?.['retry-after']) || 1;
  return new RateLimitError(secs * 1000, `Teams rate limited; retry after ${secs}s`);
}
```

---

## 6. Phase E — Attachments

Teams attachments arrive as `activity.attachments[]` with `contentUrl`. Map them to the
kernel's `IncomingAttachment` (`{ url, name, size, contentType }`) so the existing
`src/core/attachments.ts` downloader handles them — **but** Teams file download often needs an
auth token/`contentUrl` that's pre-signed for a short window. For v1:

- Map `name`, `contentType`, and `contentUrl`→`url`; set `size: 0` when absent.
- If download fails (auth), the kernel already posts the "Failed to download attachments"
  advisory (`queue.ts:162`) — acceptable degradation.
- **No voice transcription in Phase 1** (Teams has no first-class voice-message flag like
  Discord's). Defer.

---

## 7. Phase F — Binding model & commands (`src/providers/teams/commands/`)

### 7.1 How a chat binds to an agent (scope-agnostic)

Binding = recording `conversation.id → agent_id` in the shared `agent_channels` table (provider
`'teams'`), with `conversation.id` stored as `channel_id`. **This is identical for DMs, group
chats, and channels** — every surface is just a conversation id, and the kernel's
`resolveConversation` treats them all the same. The handler distinguishes surfaces via
`activity.conversation.conversationType` (`personal` / `groupChat` / `channel`) only where the
*UX* differs (below), not in the storage path.

| Surface | `conversationType` | Container created by | Drive the agent by | Multi-agent story |
| --- | --- | --- | --- | --- |
| **DM** | `personal` | exists once user opens the bot | just message the bot | one agent, **rebind** to switch (§7.2) |
| **Channel** | `channel` | user creates it (Phase 1) / Graph auto-create (Phase 2) | **@mention the bot** in the channel | one agent **per channel** — parallel agents |
| **Group chat** | `groupChat` | user creates the group + adds bot | @mention the bot | one agent per group |

**DM (single rebindable agent).** A user has only one 1:1 chat with the bot, so the DM holds
one binding; switch agents by re-binding (§7.2).

**Channel (channel-per-agent — the Discord/Slack model).** The admin installs the app to the
team once. A user opens any channel, types `agents new <id>` while **@mentioning the bot**, and
that channel is bound. Thereafter, **@mentioning the bot** in the channel forwards the message
to the bound agent and the reply lands in the thread. In channels the bot only receives
messages that @mention it (Teams default — no `ChannelMessage.Read.Group` RSC needed), which is
exactly Slack's `app_mention` model: prompts are always intentional. **No Graph required** for
this manual flow — Graph is only for *auto-creating* the channel (Phase 2, §14).

> **Channel scope is Phase 2 (see Recommendation at top).** When built, it mirrors Slack
> rather than inventing a channel-level shortcut: `agents new` binds the channel, an @mention
> spawns an **owner-bound thread**, and the Maestro **session lives on the thread**
> (`teams_agent_threads`, `isThread:true`, owner-gated) — the same shape as
> `slack_agent_conversations` / `discord_agent_threads`. Phase 1 (this plan's build target)
> implements only the DM/group path below.

### 7.2 Rebind semantics (`agents new` on an already-bound chat)

Slack never hits this — `agents new` always makes a *fresh* channel. Teams **must** support
re-binding the *same* conversation, because there's only one DM. `channelDb.register` does a
plain `INSERT` and will violate the `(provider, channel_id)` PK on a second bind. Add a
**`rebind`** path to `teams/channelsDb.ts` (or extend the core `channelDb` with an upsert):

```ts
// teams/channelsDb.ts — additions
bindOrRebind(channelId: string, agentId: string, agentName: string): 'bound' | 'rebound' {
  const existing = core.get('teams', channelId);
  if (!existing) { core.register('teams', channelId, agentId, agentName, null); return 'bound'; }
  // Same conversation, new agent: switch agent AND clear the session — the old
  // session id belongs to the previous agent and must not leak across the switch.
  core.rebind('teams', channelId, agentId, agentName);   // UPDATE agent_id, agent_name, session_id=NULL
  return 'rebound';
}
```

This needs a small **core** addition (`channelDb.rebind(provider, channelId, agentId, agentName)`
that `UPDATE`s `agent_id`, `agent_name`, and sets `session_id = NULL`) — the one place the core
DB module grows for Teams. It's provider-neutral, so it's a clean kernel addition rather than a
leak. Alternatively keep it Teams-local by deleting + re-inserting the row inside a transaction.

### 7.3 Command surface

Teams has no slash-command dispatch — implement a `tryHandleCommand(turnCtx, text, userId)`
that matches a leading verb and routes to handlers, returning `true` if it consumed the
message. Ship the **reduced Slack surface**:

| Typed command | Behavior |
| --- | --- |
| `health` | Reply with relay health (CLI reachable) — port `commands/health.ts`. |
| `agents` / `agents list` | List Maestro agents (`maestro.listAgents()`), reused logic. |
| `agents new <agent-id>` | Bind **this chat** to the agent via `bindOrRebind` (§7.2). If already bound, switches agent and resets the session; reply tells the user which (`bound`/`rebound`). |
| `agents current` | Show which agent (if any) this chat is bound to — useful since there's no channel name to glance at. |
| `agents disconnect` | Unbind this chat; `conversationRefsDb.remove` + `channelDb.remove`. |
| `agents readonly <on\|off>` | `channelDb.setReadOnly`. |
| `session new` | Clear the session id on the binding (`channelDb.updateSession(id, null)`) so the next message starts a fresh Maestro session. |

Enforce `TEAMS_ALLOWED_USER_IDS` at the top of `tryHandleCommand`, mirroring Slack. Reuse
`maestro.listAgents()` and the agent-lookup logic (exact id / id-prefix / exact name) from
`slack/commands/agents.ts:102` so IDs work identically across providers.

> **Group chats:** require an explicit `agents new` to bind (don't auto-bind), and gate who
> may run it via `TEAMS_ALLOWED_USER_IDS`. In a group chat, the bot only sees messages that
> @mention it (Teams default), so forwarded prompts are intentional. Decide whether non-binder
> members may drive the bound agent (Slack restricts threads to the owner; Teams group chats
> have no single owner — simplest v1 is "any allowed user in the chat can drive it").

---

## 8. Phase G — Wiring

1. **`src/core/providers.ts`** — add the case (the only kernel file touched):
   ```ts
   case 'teams': {
     const { TeamsProvider } = await import('../providers/teams/adapter');
     return new TeamsProvider();
   }
   ```
2. **`.env.example`** — the block from §3.
3. **`install.sh`** — extend `normalize_module` allow-list to accept `teams`; add a
   `teams`-gated credential-prompt branch in `write_config` (TEAMS_* keys), mirroring the
   `slack` branch at `install.sh:274`.
4. **`bin/maestro-relay-ctl.sh:cmd_deploy`** — Teams "deploy" ≠ register commands. Either
   make it a no-op for `teams` with a message ("Teams uses an app-package upload — see
   docs/teams.md") or route to a `dist/providers/teams/deploy.js` that **emits/validates the
   app-package zip**. Recommend the latter as a convenience.
5. **`package.json`** — deps (§1); optional `"deploy-teams": "tsx src/providers/teams/deploy.ts"`.

---

## 9. Phase H — `deploy.ts` (optional convenience)

`src/providers/teams/deploy.ts`: read `appPackage/manifest.json` + icons, substitute
`TEAMS_APP_ID`/`TEAMS_PUBLIC_URL` from env, and emit `appPackage/maestro-relay-teams.zip` for
the admin to upload. (Publishing via Graph `appCatalogs` is Phase 2 — needs admin app
permissions.) This is the Teams analogue of `deploy-commands`, but it produces an artifact
rather than calling an API.

---

## 10. Phase I — Tests (`node --test`, no SDK runtime)

Mirror the Slack/mockProvider test approach. New tests:

- `teams.translate.test.ts` — `translateActivity(fakeActivity)` → correct `IncomingMessage`
  (id, conversation id as channelId, author from `aadObjectId`, `isThread:false`, mapped
  attachments). No `botbuilder` runtime needed.
- `teams.rateLimit.test.ts` — `toRateLimitError`: 429 with `retry-after` header → `RateLimitError`
  in ms; non-429 → `null`.
- `teams.refsDb.test.ts` — `conversationRefsDb` upsert/get/remove round-trip against an
  in-memory DB.
- `teams.commands.test.ts` — `tryHandleCommand` routing (`agents new` binds, `session new`
  clears session, unauthorized user rejected) with a stubbed turn context.
- Confirm the existing kernel suite (`queue.test.ts`, `server.test.ts`) stays green with the
  provider present. `npm test` builds then runs `dist/__tests__/**`.

---

## 11. Phase J — Docs

- **`docs/teams.md`** mirroring `docs/slack.md`: Phase-A setup runbook (Azure/Entra/manifest/
  admin install/public endpoint), configuration table, typed-command surface, runtime behavior
  (ref capture on first message, no reactions, typing indicator, ASCII tables, usage stats),
  the `findOrCreateAgentChannel` Phase-1 limitation, security (`TEAMS_ALLOWED_USER_IDS`),
  troubleshooting (401 = bad app id/secret/tenant; no proactive push = chat the bot first;
  413 MessageSizeTooBig = oversized — but kernel split prevents it).
- **README** — add `teams` to the provider list.
- **`AGENTS-providers.md`** — Teams is already used as the example; tweak any now-inaccurate
  "create a channel" framing to note Teams Chat scope.

---

## 12. Phase K — Manual E2E verification

1. `ENABLED_PROVIDERS=teams`, fill `.env`, start a Dev Tunnel to `TEAMS_PORT`, set the Azure
   Bot messaging endpoint to the tunnel URL.
2. `npm run dev`. Sideload the app package; open a 1:1 chat with the bot.
3. Send a message → bot greets / ref captured. Run `agents list`, then `agents new <id>`.
4. Send a real prompt → verify the agent reply, a multi-part split reply, a table rendered as
   fenced ASCII, and the usage-stats footer.
5. `curl POST /api/send` for the bound agent → verify the proactive push lands in the chat.
6. `session new` → verify the next message starts a fresh Maestro session.
7. `agents new <other-id>` in the **same DM** → verify rebind + session reset (§7.2).
8. `agents disconnect` → verify unbind + ref removal.

**Phase 2 (channel scope) E2E — when built:** add the app to a team, open a channel,
`@bot agents new <id>` → bind; `@bot <prompt>` → verify the reply spawns/uses an owner-bound
thread and the session is per-thread; a second channel bound to a different agent runs in
parallel.

---

## 13. Effort & sequencing

Estimate is for **Phase 1 (DM/group scope)** — the build target of this plan. Channel scope
(Phase 2, ~+1.5–2 d for the `teams_agent_threads` thread/owner layer) and Graph auto-create
(Phase 3) are separate.

| Block | Work | Rough size |
| --- | --- | --- |
| A | Azure/Entra/manifest runbook (customer-side, docs) | 0.5 d |
| B–C | config + migration + 2 DB modules | 0.5 d |
| D | adapter (lifecycle, send, sendTyping, resolve, findOrCreate, rate-limit) | 1.5 d |
| E | activity handler + translate + attachments | 1 d |
| F | commands (health/agents/session) | 0.5 d |
| G–H–I | wiring, installer, deploy.ts, tests | 1 d |
| J–K | docs + manual E2E | 1 d |

**~5–6 dev-days** for Phase 1, comparable to the Slack provider plus the extra Azure/manifest
ops surface. Dependencies are linear A→B→…→K; D and E are the bulk and can overlap once the DB
modules (C) exist.

---

## 14. Later phases (out of scope for the Phase 1 build)

**Phase 2 — Channel (`team`) scope, Slack-pattern (no Graph):**
- Handle `conversationType === 'channel'` activities: bind a channel via `agents new`, @mention
  spawns an **owner-bound thread**, **session-per-thread** via a new `teams_agent_threads`
  table (`isThread:true`, owner-gated) — same shape as `slack_agent_conversations`.
- Per-team install docs; channel-reply (`thread` conversation id) send path.
- Proper Teams entity `@mention` rendering (entities array, not just `<at>` text).

**Phase 3 — Graph + polish:**
- **Graph channel auto-create** (`POST /teams/{team-id}/channels`) so `agents new <id>` from a
  DM spins up a dedicated `#maestro-<agent>` channel — removes Phase 2's manual channel-create
  step. Needs admin-consented app Graph permissions.
- Graph-based proactive install → real `findOrCreateAgentChannel` parity for unbound agents.
- Graph `appCatalogs` auto-publish from `deploy.ts`.

**Nice-to-haves (any phase):**
- Typing keep-alive loop (re-send every ~4 s for long runs).
- Adaptive Card output for richer formatting / real tables.
- Voice/audio transcription if Teams exposes a usable flag.

---

## 15. Shipping checklist (from AGENTS-providers.md)

- [ ] `src/providers/teams/adapter.ts` implements `BridgeProvider`
- [ ] `src/providers/teams/{config,channelsDb,conversationRefsDb,messageCreate}.ts`
- [ ] `src/providers/teams/commands/{health,agents,session}.ts`
- [ ] `loadProvider` in `src/core/providers.ts` recognizes `teams`
- [ ] `teams_conversation_refs` migration added (idempotent) + history comment updated
- [ ] `.env.example` documents `TEAMS_*` keys
- [ ] `botbuilder` + `restify` deps added; loaded only when teams enabled
- [ ] `appPackage/` manifest + icons; `deploy.ts` emits the zip
- [ ] `install.sh` `normalize_module` includes `teams` + credential prompts
- [ ] `bin/maestro-relay-ctl.sh:cmd_deploy` handles `teams`
- [ ] `docs/teams.md` mirrors `docs/slack.md`; README provider list updated
- [ ] `npm test` green (kernel + new teams tests)
- [ ] Manual E2E (§12) passes
