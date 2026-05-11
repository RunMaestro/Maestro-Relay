# Agent Guide

This repo is **Maestro Relay** — a chat-platform-to-Maestro bridge built around a provider-agnostic kernel. Discord and Slack ship in the box; Teams/Matrix plug in alongside them without touching the kernel. `CLAUDE.md` is a symlink to this file.

## Development workflow

- Install deps: `npm install`
- Run in dev: `npm run dev`
- Deploy slash commands (Discord): `npm run deploy-commands`
- Build: `npm run build`
- Production: `npm run build` then `npm start`
- Run tests: `npm test`

## Project layout

### Core (provider-agnostic kernel)

- `src/core/types.ts` — `BridgeProvider`, `IncomingMessage`, `ConversationRecord`, `ChannelTarget`, `OutgoingMessage`, `KernelContext`
- `src/core/queue.ts` — per-conversation FIFO message queue, typed on `IncomingMessage`
- `src/core/api.ts` — internal HTTP API server (`POST /api/send`, `GET /api/health`)
- `src/core/providers.ts` — provider registry (loads adapters by name from `ENABLED_PROVIDERS`)
- `src/core/db/index.ts` — SQLite registry with composite PK `(provider, channel_id)`
- `src/core/db/migrations.ts` — idempotent schema upgrades
- `src/core/maestro.ts` — `maestro-cli` wrapper
- `src/core/transcription.ts` — generic ffmpeg + whisper pipeline
- `src/core/attachments.ts` — provider-agnostic attachment download
- `src/core/logger.ts`, `src/core/config.ts`, `src/core/splitMessage.ts`

### Discord provider

Lives under `src/providers/discord/` (`adapter.ts`, `messageCreate.ts`, `voice.ts`, `commands/`, `deploy.ts`, `channelsDb.ts`, `threadsDb.ts`, `embed.ts`, `config.ts`). For Discord-specific runtime behavior, env vars, slash commands, and bot setup see [docs/discord.md](docs/discord.md). Voice transcription is documented in [docs/voice.md](docs/voice.md).

### Slack provider

Lives under `src/providers/slack/` (`adapter.ts`, `messageCreate.ts`, `commands/`, `channelsDb.ts`, `conversationsDb.ts`, `config.ts`). Uses `@slack/bolt` (Socket Mode in dev, ExpressReceiver in production). Thread registry (`slack_agent_conversations`) is keyed on `thread_ts`. For Slack-specific runtime behavior, env vars, slash commands, and app setup see [docs/slack.md](docs/slack.md).

### CLI

- `src/cli/maestro-relay.ts` — verb dispatcher (`send`, `notify`, `status`)
- `src/cli/lib.ts` — shared HTTP client for `/api/send`
- `src/cli/verbs/` — individual verb implementations

The `maestro-discord` binary is registered as an alias of `maestro-relay` for back-compat.

### Entry point

- `src/index.ts` — kernel orchestrator: builds providers, starts each with kernel ctx, starts the HTTP API, wires graceful shutdown

## HTTP API

Local API on `127.0.0.1:API_PORT` (default 3457). See [docs/api.md](docs/api.md) for endpoints, request format, and error codes.

## Adding a new provider

See [AGENTS-providers.md](AGENTS-providers.md) (a.k.a. [CLAUDE-providers.md](CLAUDE-providers.md)) for the deep-dive guide: kernel/provider contract, file-layout convention, DB and env conventions, voice-transcription integration, and a shipping checklist.

TL;DR:

1. Implement `BridgeProvider` from `src/core/types.ts` at `src/providers/<name>/adapter.ts`.
2. Add a `case` to `loadProvider` in `src/core/providers.ts`.
3. Document `<PROVIDER>_*` env vars in `.env.example`.
4. Add `docs/<name>.md` mirroring `docs/discord.md`'s structure.

## Installer module switch

- `install.sh` supports `MAESTRO_RELAY_MODULE` (fallback `MAESTRO_BRIDGE_MODULE`), currently accepting `discord` and `slack`.
- Keep installer module selection aligned with runtime `ENABLED_PROVIDERS` and CLI `--provider` support.
- When adding a provider, update installer validation/prompting and `maestro-relay-ctl deploy` routing so deploy behavior is module-aware.

## Project notes

- Source lives in `src/` and is TypeScript.
- Env vars are documented in `.env.example`. Keep it in sync with `.env` usage.
- `ENABLED_PROVIDERS` is a comma-separated list (default `discord`); each provider validates its own creds at `start()`, so a disabled provider doesn't fail the bridge on missing env.
- Tests use Node.js built-in test runner (`node --test`), not Jest/Vitest.
- The Discord adapter uses `isSendable()` type guards for channel safety.

## Expectations for changes

- Follow existing patterns in `src/core/` and `src/providers/{discord,slack}/` before introducing new abstractions.
- Provider-specific code (Discord types, Slack Bolt handlers, slash commands, threads) lives under `src/providers/<name>/` — keep `src/core/` free of `discord.js` and `@slack/bolt` imports.
- Keep changes minimal and focused.
- Update docs when behavior or setup changes.
