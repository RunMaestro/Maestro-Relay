# Discord provider

The Discord provider is the default, in-the-box chat interface for Maestro Relay. This document covers everything Discord-specific: bot creation, permissions, slash commands, and runtime behavior. For the kernel/provider boundary, see [architecture.md](architecture.md). For voice transcription (currently Discord-only), see [voice.md](voice.md).

## Bot setup

1. Create an application at https://discord.com/developers/applications.
2. Under **Bot**, generate a token — this becomes `DISCORD_BOT_TOKEN`.
3. Invite the bot with both `bot` and `applications.commands` scopes:

```text
https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot+applications.commands&permissions=309237681232
```

   The `309237681232` permissions integer grants:

   - **Manage Channels** — create/delete agent channels (`/agents new`, `/agents disconnect`)
   - **View Channels**
   - **Send Messages**
   - **Attach Files** — re-upload user attachments when forwarding to a session thread
   - **Add Reactions** — `⏳` / `🎧` queue and transcription indicators
   - **Create Public Threads** — owner-bound session threads
   - **Send Messages in Threads**

4. Enable **Message Content Intent** under Privileged Gateway Intents at:

```text
https://discord.com/developers/applications/<DISCORD_CLIENT_ID>/bot
```

   Without this the bot fails to connect with a *"Used disallowed intents"* error.

## Configuration

Discord provider keys read from `.env`:

| Key                        | Required | Purpose                                                    |
| -------------------------- | -------- | ---------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`        | yes      | Bot token from the Discord Developer Portal                |
| `DISCORD_CLIENT_ID`        | yes      | Application ID from the Discord Developer Portal           |
| `DISCORD_GUILD_ID`         | yes      | Server ID where slash commands are registered              |
| `DISCORD_ALLOWED_USER_IDS` | no       | Comma-separated user IDs allowed to use slash commands     |
| `DISCORD_MENTION_USER_ID`  | no       | User ID to `@mention` when API callers pass `mention=true` |

The provider only loads if `discord` is in `ENABLED_PROVIDERS` (default: `discord`).

## Slash commands

| Command                    | Description                                                     |
| -------------------------- | --------------------------------------------------------------- |
| `/health`                  | Verify Maestro CLI is installed and working                     |
| `/agents list`             | Show all available agents                                       |
| `/agents new <agent>`      | Create a dedicated channel for an agent (autocomplete)          |
| `/agents show <agent>`     | Show an agent's stats and recent activity                       |
| `/agents disconnect`       | (Run inside an agent channel) Remove and delete the channel     |
| `/agents readonly on\|off` | Toggle read-only mode for the current agent channel             |
| `/session new`             | Create a new owner-bound thread for the current agent channel   |
| `/session list`            | List session threads for the current agent channel              |
| `/playbook list`           | List playbooks (optionally filter by agent)                     |
| `/playbook show <id>`      | Show details for a playbook                                     |
| `/playbook run <id>`       | Run a playbook and post the completion summary in-channel       |
| `/auto-run start <doc>`    | Launch an Auto Run document for the current agent channel       |
| `/gist`                    | Publish the current agent's session transcript as a GitHub gist |
| `/notes synopsis`          | Post an AI-generated synopsis of recent activity                |
| `/notes history`           | Post a unified history feed across agents                       |

### Deploying slash commands

The production install one-liner registers commands automatically. Re-run after changes via:

```bash
maestro-relay-ctl deploy
```

For source-based development:

```bash
npm run deploy-commands
```

## Runtime behavior

- **Mentioning the bot** in an agent channel creates a new owner-bound thread (equivalent to running `/session new`).
- **Owner-bound threads**: only the user who created the thread can trigger the agent. Other users' messages are silently ignored — no error reply, no forwarding.
- **Read-only mode** via `/agents readonly on` lets the bridge POST agent updates to the channel (via the HTTP API) without forwarding user messages back. Toggle off with `/agents readonly off`.
- **Reactions**: `⏳` while a message is queued, `🎧` while a voice message is being transcribed.
- **Usage stats** are appended below each agent reply (tokens, cost, context %).
- **Markdown tables** in agent replies are rendered as aligned, fenced ASCII tables so they display correctly (Discord has no native table syntax). See [architecture.md → Output rendering](architecture.md#output-rendering).

## Security

- Slash command access can be locked down with `DISCORD_ALLOWED_USER_IDS`.
- Threads created by mention or `/session new` are bound to a single owner; non-owner messages are ignored silently.
- The bot only auto-creates channels under the **Maestro Agents** category.

## Troubleshooting

- **`/health` fails** → ensure `maestro-cli` is on the relay's `PATH` and reachable.
- **Slash commands don't appear** → re-run `maestro-relay-ctl deploy` (production) or `npm run deploy-commands` (source). Confirm the bot is in the guild specified by `DISCORD_GUILD_ID`.
- **"Used disallowed intents"** at startup → enable Message Content Intent under Privileged Gateway Intents (see Bot setup, step 4).
- **Bot is online but ignores messages** → check the channel is registered (`/agents list`), and that the message author is the thread owner (or no owner constraint applies for top-level agent channels).
