# Maestro Relay

[![Made with Maestro](https://raw.githubusercontent.com/RunMaestro/Maestro/main/docs/assets/made-with-maestro.svg)](https://github.com/RunMaestro/Maestro)

**Maestro Relay** connects chat platforms to [Maestro](https://runmaestro.ai) AI agents through `maestro-cli`. Discord and Slack ship in the box; Teams, Matrix, and others can be added by dropping in a provider adapter — the kernel is provider-agnostic.

> **Migrating from `discord-maestro`?** Same codebase, new name. All `DISCORD_*` env vars work unchanged; the legacy `maestro-discord` binary has been retired in favour of `maestro-relay`. See "Migration" below.

## Features

- Provider-pluggable kernel — Discord and Slack today, Teams/Matrix next
- Creates dedicated channels for Maestro agents
- Per-user session threads (`/session new` or by mentioning the bot)
- Per-conversation FIFO queue with typing/reaction indicators
- Streams agent replies back into chat with usage stats
- Voice transcription pipeline (whisper.cpp) for Discord voice messages

## Prerequisites

- Node.js 22+
- A bot token for at least one supported provider (Discord or Slack)
- [Maestro CLI](https://docs.runmaestro.ai/cli) on your `PATH`

## Install (production one-liner)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/RunMaestro/Maestro-Relay/main/install.sh)"
```

After install:

```bash
maestro-relay-ctl start     # boot the bot
maestro-relay-ctl logs      # tail logs
maestro-relay-ctl status    # service status
maestro-relay-ctl update    # upgrade to latest release (preserves config)
maestro-relay-ctl uninstall # remove install + service files
```

## Quick start

| Path                          | Purpose                                  |
| ----------------------------- | ---------------------------------------- |
| `~/.local/share/maestro-relay/` | Installed bot (built JS + dependencies) |
| `~/.config/maestro-relay/.env`  | Configuration (preserved across updates) |
| `~/.local/bin/maestro-relay-ctl` | Service control wrapper             |
| `~/.local/bin/maestro-relay`  | Agent → chat CLI (`send`, `notify`, `status`) |
| systemd user / launchd agent  | Auto-start unit                          |

Override any of these with `MAESTRO_RELAY_HOME`, `XDG_CONFIG_HOME`, or `MAESTRO_RELAY_BIN_DIR`. Pin a specific version with `MAESTRO_RELAY_VERSION=v1.0.0`.
Choose a provider module at install time via `MAESTRO_RELAY_MODULE` (`discord` or `slack`).

## Install (development from source)

1. Clone and install:

```bash
git clone https://github.com/RunMaestro/Maestro-Relay.git
cd Maestro-Relay
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

Set core values in `.env`:

```
ENABLED_PROVIDERS=discord    # comma-separated; default 'discord'. Use 'slack' or 'discord,slack' for multi-provider deployments
API_PORT=3457                # optional, default 3457
```

Then fill in the provider-specific keys. The Discord provider needs `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID` — see [docs/discord.md](docs/discord.md) for bot setup, the full env-var reference, and slash-command deployment. The Slack provider needs `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_TEAM_ID`, and `SLACK_APP_ID` — see [docs/slack.md](docs/slack.md). For optional voice transcription (Discord), see [docs/voice.md](docs/voice.md).

3. Deploy slash commands (Discord):

```bash
npm run deploy-commands
```

4. Start the bridge (dev mode):

```bash
npm run dev
```

Optional for source-based local CLI usage:

```bash
npm link
```

## Production run

```bash
npm run build
npm start
```

## Tests

```bash
npm test
```

Coverage:

```bash
npm run build && node --test --experimental-test-coverage dist/__tests__/**/*.test.js
```

## Providers

| Provider | Docs | Status |
| -------- | ---- | ------ |
| Discord  | [docs/discord.md](docs/discord.md) — bot setup, env vars, slash commands, runtime behavior | Built-in |
| Slack    | [docs/slack.md](docs/slack.md) — app setup, env vars, slash commands, runtime behavior | Built-in |
| Teams / Matrix / … | [AGENTS-providers.md](AGENTS-providers.md) — provider development guide | Add your own |

Optional voice transcription (whisper.cpp, Discord-only today): [docs/voice.md](docs/voice.md).

## How it works

Mention the bot or run `/session new` in an agent channel to create a thread, then chat — messages are queued and forwarded to the agent via `maestro-cli`. See [docs/architecture.md](docs/architecture.md) for the full message flow and kernel/provider split, and [AGENTS-providers.md](AGENTS-providers.md) for the provider-development guide.

## Agent → chat messaging

Agents can push messages to chat via the `maestro-relay` CLI / HTTP API. See [docs/api.md](docs/api.md) for usage, endpoints, and error codes.

## Migration from `discord-maestro`

This project was renamed from `discord-maestro` / `Maestro-Discord`. To smooth upgrades:

- The legacy `maestro-discord` / `maestro-bridge` binaries have been retired; install + upgrade now scrub any leftover symlinks. Update any scripts that invoke them to `maestro-relay send …`.
- All `DISCORD_*` env vars are unchanged. New optional `ENABLED_PROVIDERS` defaults to `discord`.
- The SQLite database upgrades automatically on first start: `agent_channels` gains a `provider` column (existing rows default to `discord`); `agent_threads` is renamed to `discord_agent_threads` with rows preserved. No manual migration needed.
- The HTTP `/api/send` endpoint accepts an optional `provider` field that defaults to `discord`; existing callers are unaffected.

## Data storage

The bridge stores channel ↔ agent mappings in a local SQLite database at `maestro-bot.db`.
Delete this file to reset all channel bindings.
