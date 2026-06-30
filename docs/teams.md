# Microsoft Teams provider

The Teams provider lets Maestro Relay run inside a Microsoft Teams tenant alongside or instead of Discord and Slack. This document covers everything Teams-specific: the Azure/Entra setup runbook, configuration, the binding/command model, runtime behavior, storage, and troubleshooting. For the kernel/provider boundary, see [architecture.md](architecture.md). For the platform rationale (why Bot Framework, single-tenant, sideload), see [plans/teams-provider-research.md](plans/teams-provider-research.md).

The provider only loads if `teams` is in `ENABLED_PROVIDERS`. To run Teams alongside the others: `ENABLED_PROVIDERS=discord,slack,teams`.

> **Phase 1 scope (this release).** Teams ships the DM / `personal`-scope MVP: a one-to-one chat with the bot binds to a single Maestro agent. The app manifest requests **only `personal`** scope, and the bot ignores any non-personal (group-chat/channel) conversation, because shared contexts need owner/thread isolation that lands in a later phase — see [Binding model & commands](#binding-model--commands).

> **Account requirement.** This provider targets **Microsoft 365 business/enterprise** tenants. Free/consumer Microsoft accounts (outlook.com/hotmail/live personal accounts) cannot host a single-tenant Azure Bot and are **out of scope**. You need a tenant where you (or an admin) can register an Entra app, create an Azure Bot resource, and upload (sideload) a Teams app package.

## App setup

This is the operator runbook. Most of it is one-time Azure/Entra plumbing; the unavoidable manual step is the app-package upload, which only a Teams admin (or a tenant that permits custom-app sideloading) can perform.

1. **Register an Entra application** (Azure Portal → **Microsoft Entra ID → App registrations → New registration**).
   - Supported account types: **Accounts in this organizational directory only (single tenant)**. Multi-tenant bots are deprecated by Microsoft and not recommended for new bots.
   - Copy the **Application (client) ID** → `TEAMS_APP_ID`, and the **Directory (tenant) ID** → `TEAMS_TENANT_ID`.
   - Under **Certificates & secrets → New client secret**, create a secret and copy its **value** (not the secret ID) → `TEAMS_APP_PASSWORD`.

2. **Create an Azure Bot resource** (Azure Portal → **Create a resource → Azure Bot**).
   - **Type of App:** *Single Tenant*. Point it at the Entra app above (reuse the existing `TEAMS_APP_ID` and `TEAMS_TENANT_ID`).
   - **Configuration → Messaging endpoint:** `https://<your-public-host>/api/messages`. This must be the public HTTPS URL that reaches the relay's restify server on `TEAMS_PORT` (default `3978`).
   - **Channels → Microsoft Teams:** add and enable the Teams channel.

3. **Expose a public HTTPS endpoint.** Azure Bot Service POSTs activities to the messaging endpoint over the public internet, so the relay's `/api/messages` listener must be reachable via HTTPS.
   - **Dev:** a tunnel works well — [Microsoft Dev Tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/) (`devtunnel`) or ngrok. Point the bot's messaging endpoint at `https://<tunnel-host>/api/messages`.
   - **Production:** a reverse proxy / load balancer terminating TLS in front of `TEAMS_PORT`.
   - Record the host portion (e.g. `example.com`) in `TEAMS_PUBLIC_URL` — it feeds the manifest's `validDomains` and is used for ops/docs only; the relay does not dial out to it.

4. **Build and upload the Teams app package** (the unavoidable admin step).
   - Build the upload artifact:
     ```bash
     TEAMS_APP_ID=<entra-app-id> TEAMS_PUBLIC_URL=https://<public-host> npm run deploy-teams
     ```
     This substitutes the manifest placeholders and emits `appPackage/maestro-relay-teams.zip`. See [`appPackage/README.md`](../appPackage/README.md) for what the package contains.
   - Upload the zip into the tenant. Either route works:
     - **Sideload (dev/test):** Teams → **Apps → Manage your apps → Upload an app → Upload a custom app**. Requires that the tenant allows custom-app uploads (Teams admin center → *Setup policies*).
     - **Org catalog (production):** Teams admin center → **Teams apps → Manage apps → Upload new app** ("Built for your org"). Makes the app installable tenant-wide.
   - Open a chat with the installed **Maestro Relay** bot to start (this also captures the conversation reference — see [Runtime behavior](#runtime-behavior)).

## Configuration

Teams provider keys read from `.env`:

| Key                      | Required | Purpose                                                                                                  |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `TEAMS_APP_ID`           | yes      | Entra app (client) ID; also the bot's `MicrosoftAppId`                                                  |
| `TEAMS_APP_PASSWORD`     | yes      | Entra client secret value                                                                               |
| `TEAMS_TENANT_ID`        | yes¹     | Entra directory (tenant) ID; required for the default `SingleTenant` app type                           |
| `TEAMS_APP_TYPE`         | no       | `SingleTenant` (default, recommended) or `MultiTenant` (deprecated by Microsoft)                        |
| `TEAMS_PORT`             | no       | HTTP port for the restify `/api/messages` listener (default `3978`; invalid values fall back to `3978`) |
| `TEAMS_PUBLIC_URL`       | no       | Public HTTPS base Azure Bot posts to; feeds the manifest `validDomains` (docs/ops only)                 |
| `TEAMS_ALLOWED_USER_IDS` | no       | Comma-separated AAD object IDs allowed to use the bot; empty allows everyone in the tenant              |
| `TEAMS_MENTION_USER_ID`  | no       | AAD object ID to `@mention` when API callers pass `mention=true`                                        |

¹ `TEAMS_TENANT_ID` is required in practice because the default `TEAMS_APP_TYPE=SingleTenant` authenticates against a specific tenant. It is only optional if you opt into the deprecated `MultiTenant` app type.

The Teams adapter loads its config lazily, so a deployment that disables Teams (e.g. `ENABLED_PROVIDERS=discord`) does **not** fail at startup for missing `TEAMS_*` keys.

## Initialize & test an agent (end-to-end)

This is the full path from a fresh checkout to a working agent you can chat with in Teams — and to verifying proactive `/api/send` pushes. It assumes [App setup](#app-setup) is done (you have an Entra app + Azure Bot and the three required credentials).

### 1 — Configure and start the relay

1. Fill `.env`:
   ```env
   ENABLED_PROVIDERS=teams            # or discord,slack,teams
   TEAMS_APP_ID=<entra-app-id>
   TEAMS_APP_PASSWORD=<client-secret-value>
   TEAMS_TENANT_ID=<directory-tenant-id>
   TEAMS_PORT=3978                    # default; the restify /api/messages port
   # optional: TEAMS_ALLOWED_USER_IDS=<your-aad-object-id>   # lock the bot to yourself while testing
   ```
2. Open a public tunnel to `TEAMS_PORT` and point the Azure Bot's **Messaging endpoint** at it:
   ```bash
   devtunnel host -p 3978 --allow-anonymous      # or: ngrok http 3978
   # Azure Bot → Configuration → Messaging endpoint = https://<tunnel-host>/api/messages
   ```
3. Build and run:
   ```bash
   npm install && npm run build && npm start      # or `npm run dev` for watch mode
   ```
   Confirm the logs show the restify listener (`teams/start listening on 3978`) and the kernel API (`API server listening on http://127.0.0.1:3457`).
4. Health check — the provider should report ready:
   ```bash
   curl -s http://127.0.0.1:3457/api/health | jq
   # → { "success": true, "status": "ok", "providers": { "teams": true }, ... }
   ```
5. Build and upload the app package (one-time per tenant), then install the bot:
   ```bash
   TEAMS_APP_ID=<entra-app-id> TEAMS_PUBLIC_URL=https://<tunnel-host> npm run deploy-teams
   # → appPackage/maestro-relay-teams.zip — sideload it (Teams → Apps → Manage your apps → Upload a custom app)
   ```

### 2 — Bind an agent in a DM

6. In Teams, open a 1:1 chat with **Maestro Relay**. It greets you (`Maestro Relay is connected. Type agents list to begin.`) — this first turn **captures the conversation reference**, which is what later enables proactive pushes.
7. List agents and bind one (the chat is the unit of binding — one DM ↔ one agent):
   ```text
   agents list                 → • My Agent (a1b2c3d4-…)
   agents new a1b2c3d4         → Bound this chat to My Agent (a1b2c3d4-…). Send a message to start.
   ```
   `agents new` accepts the **exact ID, an ID-prefix, or the exact name**.
8. Send a normal message (anything that isn't a command). You should see a **typing indicator**, then the agent's reply followed by a usage footer (`tokens • $cost • context %`). A new Maestro session is created on this first message and persisted to the binding.
9. Exercise the rest of the surface:
   ```text
   agents current              → This chat is bound to My Agent (a1b2c3d4-…).
   session new                 → next message starts a fresh Maestro session (same agent)
   agents new <other-id>       → re-binds THIS chat to a different agent and resets the session
   agents readonly on|off      → toggle read-only mode
   agents disconnect           → unbind + delete the stored conversation reference
   ```

### 3 — Verify a proactive push (`/api/send`)

Agent-initiated messages can only reach a Teams chat **after** it has been bound (step 7) — `findOrCreateAgentChannel` is lookup-only in Phase 1, so an unbound agent returns `404`. With the agent bound, push a message from the relay host:

```bash
curl -sS -X POST http://127.0.0.1:3457/api/send \
  -H 'Content-Type: application/json' \
  -d '{"provider":"teams","agentId":"a1b2c3d4-…","message":"✅ proactive test from /api/send"}'
# → {"success":true,"channelId":"19:…"}
```

The message should appear in your DM with the bot. (The bundled `maestro-relay` CLI wraps the same endpoint — see [api.md](api.md) for request/response details and the CLI verbs.) A `404 { "error": "Agent not found: …" }` means the agent isn't bound to any Teams chat yet — DM the bot and run `agents new <id>` first.

### Quick failure triage

| Symptom | Likely cause |
| --- | --- |
| `/api/health` shows `teams: false` | bad/missing `TEAMS_*` creds, or the restify listener didn't start (port in use) |
| Bot never replies in the DM | Azure Bot messaging endpoint not pointing at your tunnel, or tunnel down (no inbound activity reaches the relay) |
| Reply fails with `401` in logs | wrong `TEAMS_APP_ID` / `TEAMS_APP_PASSWORD` (use the secret **value**, not the ID) / tenant mismatch |
| `agents new` says "Agent not found" | the ID/name doesn't match `maestro-cli list agents` — run `agents list` |
| `/api/send` returns `404` | the agent isn't bound to a Teams chat — see step 7 |
| Messages silently ignored | sender's AAD object id isn't in a non-empty `TEAMS_ALLOWED_USER_IDS` |

See [Troubleshooting](#troubleshooting) for the full list.

## Binding model & commands

Teams has **no slash-command dispatch** — there is no `/agents` registration the way Discord and Slack have. Commands are plain typed text parsed from the message (the bot @mention, if any, is stripped first). The command surface mirrors Slack's, adapted to the DM model.

A **DM is the unit of binding**: one chat with the bot maps to exactly one agent. There is no per-agent channel auto-creation (a 1:1 Teams chat cannot be spun up proactively). To switch agents you **re-bind the same chat** with `agents new <id>`, which resets the session (the old session belonged to the previous agent).

| Command                     | Description                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `health`                    | Verify the relay is running and `maestro-cli` is reachable                                           |
| `agents` / `agents list`    | List all available Maestro agents                                                                    |
| `agents new <agent-id>`     | Bind this chat to an agent (or **re-bind**, resetting the session). Accepts exact ID, ID-prefix, or exact name |
| `agents current`            | Show which agent this chat is bound to (and whether it is read-only)                                 |
| `agents disconnect`         | Unbind this chat: removes the binding **and** its stored conversation reference                      |
| `agents readonly <on\|off>` | Toggle read-only mode for the bound agent                                                            |
| `session new`               | Reset the session: the next message starts a fresh Maestro session on the bound agent               |

A message that is not a recognized command flows through to the bound agent. If the chat is not bound yet, the bot replies with a hint to run `agents list` then `agents new <agent-id>`.

> **Channels are Phase 2.** Phase 1 ships `personal` scope only — the manifest requests just `personal`, and the inbound handler drops any group-chat/channel turn. Group-chat and channel binding (with Slack-style thread/owner registries) and the matching manifest scopes arrive in a later phase; the app package is simply re-uploaded then.

## Runtime behavior

- **Conversation reference on first message** — Teams bots cannot proactively start a 1:1 chat. The adapter captures (upserts) the chat's *conversation reference* on **every** inbound turn (and on `membersAdded`). This is what later makes proactive sends possible.
- **Proactive `/api/send` requires a prior chat** — the HTTP API's `POST /api/send` and the `maestro-relay` CLI can only push to a Teams chat **after** that chat has been bound and a reference captured. Sending to a chat the bot has never seen fails with "No conversation reference found". If you need proactive delivery, **message the bot first**.
- **No reactions** — Teams bots cannot add emoji reactions, so the `⏳` queued indicator used by Discord/Slack is **absent**. Instead the adapter sends a **typing indicator** while a turn is in flight (best-effort; a failure never breaks the turn).
- **Markdown tables** in agent replies are rendered as aligned, fenced ASCII tables (Teams' markdown has no native table syntax). See [architecture.md → Output rendering](architecture.md#output-rendering).
- **Usage stats** (tokens, cost, context %) are appended below each agent reply.
- **Message splitting** — long replies are split by the kernel to fit Teams' per-message size limit before they are sent.
- **Mentions** — when an API caller passes `mention=true` and `TEAMS_MENTION_USER_ID` is set, the reply is prefixed with an `<at>…</at>` tag.

## Storage

- The shared `agent_channels` table stores Teams chat ↔ agent bindings with `provider='teams'`. The `channel_id` is the Teams conversation ID. Each row holds the bound `agent_id`, the agent name, the current `session_id` (null until the first turn), and the read-only flag.
- **`teams_conversation_refs`** is a Teams-only table that stores the Bot Framework *conversation reference* per chat: `conversation_id`, the serialized `reference_json`, `service_url`, `tenant_id`, and `updated_at`. **This table is what makes proactive sends work** — `provider.send()` looks up the stored reference and calls `continueConversationAsync` to deliver into a chat the user is not currently driving. It is upserted on every inbound turn and deleted by `agents disconnect`.

## Security

- **Allowlist gating** — `TEAMS_ALLOWED_USER_IDS` (comma-separated AAD object IDs) restricts who may use the bot. The check runs first in the command dispatcher: an excluded user gets a single "not authorized" reply and the message is consumed (it reaches neither a command handler nor the agent). When the list is empty, all tenant members may use the bot.
- **Single-tenant binding** — with the default `TEAMS_APP_TYPE=SingleTenant`, the bot authenticates against your specific `TEAMS_TENANT_ID`, so only your tenant's users can interact with it.

## Troubleshooting

- **HTTP 401 / `Unauthorized` from the Bot Framework** → the app id, secret, or tenant is wrong. Re-check `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` (must be the secret **value**, and not expired), and `TEAMS_TENANT_ID`. The Azure Bot resource's App Type must match `TEAMS_APP_TYPE`.
- **No proactive push (`/api/send` fails with "No conversation reference found")** → that chat has never messaged the bot. **Chat the bot first** so a conversation reference is captured into `teams_conversation_refs`, then retry the send.
- **`413 MessageSizeTooBig`** → a single message exceeded Teams' limit. The kernel splits outbound messages to fit, so this should not occur; if it does, the reply path bypassed the splitter — file it as a bug.
- **Bot is online but silent / ignores messages** → either the chat is **not bound** (run `agents list` then `agents new <agent-id>`) or the sender is **not in `TEAMS_ALLOWED_USER_IDS`** (non-allowlisted senders are dropped silently after the binding check). Also confirm Azure Bot's messaging endpoint points at your public `…/api/messages` and that the tunnel/proxy is up.
- **App won't upload / install** → the tenant disallows custom-app sideloading. Use the Teams admin center org-catalog upload ("Built for your org"), or have an admin enable custom-app uploads in the Teams setup policy.
