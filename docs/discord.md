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

## Callout embeds

Outbound text (agent replies and `/api/send` pushes) is scanned for **GitHub alert callouts** — a blockquote whose first line is `> [!NOTE]` (or `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`). The marker must be **uppercase** and **alone on its line** (GitHub-exact syntax); a plain `> quote` stays a normal grey Discord blockquote. Each detected callout is rendered as a **colored Discord embed emitted as its own message**, in order with the surrounding prose, so it visually stands apart from ordinary text.

The five variants map to a matching emoji and accent color (the embed's left stripe):

| Callout          | Emoji | Color     |
| ---------------- | ----- | --------- |
| `> [!NOTE]`      | ℹ️    | `#1f6feb` |
| `> [!TIP]`       | 💡    | `#238636` |
| `> [!IMPORTANT]` | ❗    | `#8957e5` |
| `> [!WARNING]`   | ⚠️    | `#d29922` |
| `> [!CAUTION]`   | 🛑    | `#da3633` |

The callout body becomes the embed **description** and the emoji + label (e.g. `ℹ️ Note`) becomes the **title**. Discord's embed limits apply: descriptions are clamped to 4096 characters and titles to 256 — a longer body is truncated with a trailing ellipsis. Markdown tables inside a callout body are rendered the same way as elsewhere (fenced ASCII). Because each callout is its own message, a **callout-heavy response fans out into multiple messages**.

## Multi-agent rooms — real bot accounts

A **room** hosts several agents in a single Discord channel, each speaking as a genuine, separate
bot account so personas can natively `@`-ping one another. Discord has **no API to mint bot
tokens**, so every persona's account must be provisioned by hand in the Developer Portal — the
checklist below is the whole manual flow. Once the env is populated, `/room invite <agentId>`
binds an agent to the next free bot slot (no more portal work per bind).

> **Nothing here is automatable except the invite URL and the `/room invite` binding.** Token
> creation, the Message Content Intent toggle, and OAuth2 invites are all manual, one-time,
> per-bot Developer-Portal steps.

### Real bots vs. masked-persona fallback

There are two identity modes, chosen automatically by config — you never flip a flag:

- **Real bots (recommended).** When a room-bot pool is configured (`DISCORD_ROOM_BOT_*` below),
  each persona posts through its **own bot account and gateway**. Only real accounts can fire a
  **native `<@id>` mention** that another bot's gateway receives as a first-class event — that
  cross-bot ping is what makes an A↔B exchange terminate organically. This is the whole point of
  the real-bots path, and it needs **no `Manage Webhooks`** permission (the bot posts as itself).
- **Masked-persona fallback (no pool configured).** With zero room bots configured, the single
  primary bot mirrors every persona, prefixing each line with the handle (`**Ada:** …`) so readers
  can tell speakers apart. This is mirror-only: personas **cannot** natively ping each other, so a
  multi-agent back-and-forth won't self-drive. It exists so you can try rooms without provisioning
  N bots, and it mirrors how the Slack/Teams providers mask a single bot via `chat:write.customize`.
  Provision the pool below to unlock native pinging.

The switch is `DiscordProvider.sendAs` gating on whether any `DISCORD_ROOM_BOT_*` slots loaded at
startup — see [AGENTS-providers.md](../AGENTS-providers.md) §"Rooms — real bots vs. masking".

### Per-bot onboarding checklist

Repeat this **once per persona** (`<n>` = 1, 2, 3, … up to your room size). Each persona is its own
Discord application + bot.

1. **Create the application** — go to https://discord.com/developers/applications → **New
   Application**. Name it after the persona (e.g. `Athena`).
2. **Add the bot** — open the **Bot** tab → set the bot **username** and **avatar** (this is what
   shows in the room).
3. **Enable `MESSAGE CONTENT INTENT`** — under **Privileged Gateway Intents**, turn on **Message
   Content Intent**. *(Server Members Intent is **not** required.)* Without this the bot connects
   but sees empty message bodies.
4. **Reset Token** — click **Reset Token** and copy it. ⚠️ **The token is shown exactly once — copy
   it immediately.** If you navigate away you must reset again (which invalidates the old token).
   Store it as `DISCORD_ROOM_BOT_<n>_TOKEN`.
5. **Copy the Application (Client) ID** — from **General Information** (or the Bot tab), copy the
   **Application ID**. This is also the bot **user id** used for native `<@id>` mentions. Store it
   as `DISCORD_ROOM_BOT_<n>_CLIENT_ID`.
6. **Generate the invite URL** — open **OAuth2 → URL Generator**, select scope **`bot`** (only —
   `applications.commands` is not needed for room bots), then select exactly these permissions:
   - **View Channel**
   - **Send Messages**
   - **Read Message History**
   - **Send Messages in Threads**

   **Do NOT grant `Manage Webhooks`** — the real-bots path posts as the bot account directly and
   never uses webhooks. (The generated URL is stable per client id, so you can pre-build it once.)
7. **Invite to the guild** — open the generated URL, add the bot to your server, and confirm it can
   **see and post in the room channel** (adjust channel/role permissions if needed).

### Final config

After all N bots are provisioned, fill the env for each slot `<n>` and set the count:

```bash
DISCORD_ROOM_BOT_COUNT=<N>                 # number of room bots to load
DISCORD_ROOM_BOT_<n>_TOKEN=...             # from step 4 (secret; never logged)
DISCORD_ROOM_BOT_<n>_CLIENT_ID=...         # from step 5 (numeric snowflake; native-mention target)
DISCORD_ROOM_BOT_<n>_NAME=Athena           # persona @handle: letters, numbers, underscore only, ≤80 chars
DISCORD_ROOM_BOT_<n>_AVATAR_URL=...        # optional: portal avatar URL
```

Then **restart the process** so the pool loads. Now `/room invite <agentId>` binds an agent to the
next free bot slot — no additional portal work per bind. See
[`.env.example`](../.env.example) for the full block (and the `DISCORD_ROOM_BOTS` JSON-blob
fallback used only when `DISCORD_ROOM_BOT_COUNT` is unset).

### Token rotation runbook

Rotating a bot token is safe — room bindings key on the **slot / client id**, never on the token
value, so nothing is orphaned:

1. In the Developer Portal, open the bot → **Reset Token** and copy the new token (shown once).
2. Update `DISCORD_ROOM_BOT_<n>_TOKEN` in the deployment env. **Leave `CLIENT_ID` and `NAME`
   unchanged** — the client id / bot user id is stable, so every existing room binding survives.
3. **Restart the process.** The gateway reconnects with the new token and all bindings for that
   slot carry over untouched.

## Security

- Slash command access can be locked down with `DISCORD_ALLOWED_USER_IDS`.
- Threads created by mention or `/session new` are bound to a single owner; non-owner messages are ignored silently.
- The bot only auto-creates channels under the **Maestro Agents** category.

## Troubleshooting

- **`/health` fails** → ensure `maestro-cli` is on the relay's `PATH` and reachable.
- **Slash commands don't appear** → re-run `maestro-relay-ctl deploy` (production) or `npm run deploy-commands` (source). Confirm the bot is in the guild specified by `DISCORD_GUILD_ID`.
- **"Used disallowed intents"** at startup → enable Message Content Intent under Privileged Gateway Intents (see Bot setup, step 4).
- **Bot is online but ignores messages** → check the channel is registered (`/agents list`), and that the message author is the thread owner (or no owner constraint applies for top-level agent channels).
