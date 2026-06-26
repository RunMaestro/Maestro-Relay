# Slack provider

The Slack provider lets Maestro Relay run inside a Slack workspace alongside or instead of Discord. This document covers everything Slack-specific: app creation, scopes, slash commands, and runtime behavior. For the kernel/provider boundary, see [architecture.md](architecture.md).

The provider only loads if `slack` is in `ENABLED_PROVIDERS`. To run Slack and Discord simultaneously: `ENABLED_PROVIDERS=discord,slack`.

## App setup

1. Create an app at https://api.slack.com/apps (choose **From scratch**, pick a workspace).
2. **OAuth & Permissions → Bot Token Scopes**, add:
   - `app_mentions:read`
   - `channels:history`, `channels:read`, `channels:join`, `channels:manage`
   - `chat:write`, `chat:write.public`
   - `commands`
   - `reactions:write`
   - `users:read`
3. **Event Subscriptions**:
   - Subscribe to bot events: `app_mention`, `message.channels`.
   - If you're using Socket Mode, enable it under **Settings → Socket Mode** and generate an **App-Level Token** with `connections:write`. This becomes `SLACK_SOCKET_MODE_TOKEN`.
   - Otherwise (webhook mode) point the **Request URL** at `https://<your-public-host>/slack/events` and set `SLACK_BOT_PUBLIC_URL` accordingly.
4. **Slash Commands** — create one entry per command (`/health`, `/agents`, `/session`). Request URL is the same `…/slack/events` (webhook mode) or unused (Socket Mode).
5. Install the app to the workspace and copy:
   - **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
   - **Signing Secret** (Basic Information → App Credentials) → `SLACK_SIGNING_SECRET`
   - Workspace **Team ID** (`T…`) → `SLACK_TEAM_ID`
   - **App ID** (`A…`) → `SLACK_APP_ID`

## Configuration

Slack provider keys read from `.env`:

| Key                       | Required | Purpose                                                                                  |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`         | yes      | Bot User OAuth Token (`xoxb-…`)                                                          |
| `SLACK_SIGNING_SECRET`    | yes      | App-credentials signing secret (HTTP webhook verification)                               |
| `SLACK_TEAM_ID`           | yes      | Workspace ID (`T…`)                                                                      |
| `SLACK_APP_ID`            | yes      | App ID (`A…`)                                                                            |
| `SLACK_SOCKET_MODE_TOKEN` | no       | App-level token (`xapp-…`); when set, Socket Mode is used instead of HTTP webhooks       |
| `SLACK_BOT_PUBLIC_URL`    | no       | Public HTTPS URL for Bolt's `ExpressReceiver` (webhook mode only)                        |
| `SLACK_PORT`              | no       | HTTP port for `ExpressReceiver` (webhook mode only, default `3000`)                      |
| `SLACK_ALLOWED_USER_IDS`  | no       | Comma-separated Slack user IDs allowed to use slash commands; empty allows everyone      |
| `SLACK_MENTION_USER_ID`   | no       | User ID to `@mention` when API callers pass `mention=true`                               |

The Slack adapter loads its config lazily, so a deployment that disables Slack (`ENABLED_PROVIDERS=discord`) does **not** fail at startup for missing `SLACK_*` keys.

### Choosing Socket Mode vs webhook mode

- **Socket Mode** (`SLACK_SOCKET_MODE_TOKEN` set) — easiest for development and self-hosted production. The relay opens an outbound WebSocket to Slack; no public HTTPS endpoint required.
- **Webhook mode** (`SLACK_SOCKET_MODE_TOKEN` empty) — requires a publicly reachable HTTPS URL pointed at the relay (set `SLACK_BOT_PUBLIC_URL`, optionally override `SLACK_PORT`). Use this when you need a stateless deployment behind a load balancer.

## Slash commands

| Command                          | Description                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/health`                        | Verify the relay process is healthy                                                                        |
| `/agents list`                   | Show all available Maestro agents                                                                          |
| `/agents new <agent-id>`         | Create (or reopen) a dedicated public channel `#maestro-<agent-name>` and register it for the agent        |
| `/agents disconnect [agent-id]`  | (Run inside an agent channel) Unregister the binding and archive the channel                               |
| `/agents readonly <on\|off>`     | (Run inside an agent channel) Toggle read-only mode for the bound agent                                    |
| `/session new [name]`            | Post a parent message in the current agent channel and bind a new owner-scoped thread to the invoking user |

The Slack provider deliberately ships a smaller command surface than Discord — the playbook, gist, notes, and auto-run flows are Discord-only today.

## Runtime behavior

- **Mentioning the bot** in a registered agent channel posts a new top-level message and binds it as a thread to the invoking user. Subsequent replies in that thread are forwarded to the agent.
- **`/session new`** does the same thing without requiring a mention; an optional name is shown in the parent message.
- **Owner-bound threads**: only the user who created the thread can drive the agent. Messages from other users are silently ignored.
- **Reactions**: `⏳` (`hourglass_flowing_sand`) while a message is queued. The Slack API requires emoji *names*, not Unicode characters; the adapter maps `⏳ 🎧 ✅ ❌` to the corresponding Slack names — pass any of them to `provider.react()` and the mapping happens automatically.
- **Typing indicator**: not exposed by Slack's Web API; `sendTyping` is a no-op on this provider.
- **Usage stats** are appended below each agent reply (tokens, cost, context %).
- **Markdown tables** in agent replies are rendered as aligned, fenced ASCII tables so they display correctly (Slack mrkdwn has no native table syntax). See [architecture.md → Output rendering](architecture.md#output-rendering).
- **Channel naming**: agent channels are named `maestro-<sanitized-agent-name>-<id-prefix>`, where `id-prefix` is the first 8 alphanumeric characters of the agent ID. The agent ID makes the name unique even when two different agents normalize to the same display name. The whole result is capped at 80 characters. Both `/agents new` and the HTTP-API auto-create path (`POST /api/send`) use the same helper. If the channel already exists but is archived, the adapter unarchives it; if unarchive fails, it falls back to creating a fresh channel with a `-<timestamp>` suffix appended to the base name.

## Storage

- The shared `agent_channels` table stores Slack channel ↔ agent bindings with `provider='slack'`.
- `slack_agent_conversations` is a Slack-only thread registry keyed on `thread_ts`. It records `(channel_id, agent_id, owner_user_id, session_id)` and is dropped along with its parent channel when `/agents disconnect` runs.

## Security

- Slash command access can be locked down with `SLACK_ALLOWED_USER_IDS`. When empty, all workspace members may use slash commands.
- Threads created by mention or `/session new` are bound to a single owner; non-owner messages in the thread are ignored silently.
- The bot only auto-creates **public** channels (`is_private: false`). To use private channels, create them manually and run `/agents new` from inside.

## Troubleshooting

- **`/health` posts but slash commands return `dispatch_failed`** → confirm the slash commands are registered in **Slack App → Slash Commands** with the right Request URL (Socket Mode users can leave it blank).
- **`⏳` reaction never appears** → check the bot has `reactions:write` and was reinstalled to the workspace after adding the scope. The adapter logs reaction failures via `logger.error('queue:react', …)`.
- **`signing_secret_missing` or HTTP 401 from Slack** → fill in `SLACK_SIGNING_SECRET`. Required even in Socket Mode setups for parts of the Bolt SDK.
- **Bot is online but ignores thread replies** → confirm the thread is in `slack_agent_conversations` (`/session new` or a mention created it) and that the message author matches `owner_user_id`.
- **Channel creation fails with `name_taken`** → an archived channel with the same `maestro-<…>-<id-prefix>` name exists and unarchive failed. The adapter falls back to `<name>-<timestamp>`; if that also fails (e.g. workspace channel limits, scope missing), create the channel manually and re-run `/agents new`.
- **Slack rejects the emoji name** → the adapter maps `⏳ 🎧 ✅ ❌`. Other Unicode emoji are passed through unchanged; if you call `provider.react()` from custom code with a Unicode emoji that's not in the map, add it to `UNICODE_TO_SLACK` in `src/providers/slack/adapter.ts`.
