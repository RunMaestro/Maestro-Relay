# Provider development guide

This document is the deep-dive companion to [`AGENTS.md`](AGENTS.md) (and [`docs/architecture.md`](docs/architecture.md)) for adding a new chat-platform provider to Maestro Relay. Discord, Slack, and Telegram are already built-in (see [`docs/discord.md`](docs/discord.md), [`docs/slack.md`](docs/slack.md), and [`docs/telegram-setup.md`](docs/telegram-setup.md)); everything below is what you'd need to know to ship a Teams, Matrix, etc. adapter without touching the kernel.

If you're adding behavior to an existing provider rather than building a new one, work in `src/providers/discord/`, `src/providers/slack/`, or `src/providers/telegram/` and consult the matching `docs/<name>.md` instead.

> **Single-agent providers**: Some providers (like Telegram) bind one bot to exactly one agent. In that case, enforce the binding in `findOrCreateAgentChannel` by throwing when the requested `agentId` doesn't match the bound one — this keeps `/api/send` from leaking cross-agent traffic into the wrong chat. Users running the provider standalone set `ENABLED_PROVIDERS=<name>`; users running it alongside Discord/Slack set `ENABLED_PROVIDERS=discord,<name>` (or any subset).

## The kernel/provider boundary

The kernel (`src/core/`) is provider-agnostic. It has zero `discord.js` (or any platform-SDK) imports, and it speaks only in three structured types:

- `IncomingMessage` — what the provider hands to the kernel when a user sends a message.
- `OutgoingMessage` — what the kernel hands back to the provider to post into chat.
- `ChannelTarget` / `MessageTarget` — opaque-to-kernel pointers for "where to put this".

The kernel owns:

- Per-conversation FIFO queueing (`src/core/queue.ts`).
- HTTP API for agent → chat pushes (`src/core/api.ts`, `POST /api/send`, `GET /api/health`).
- SQLite registry of agent ↔ channel bindings, keyed `(provider, channel_id)` (`src/core/db/`).
- `maestro-cli` invocation (`src/core/maestro.ts`).
- Attachment download (`src/core/attachments.ts`) and voice transcription (`src/core/transcription.ts`).
- Message splitting (`src/core/splitMessage.ts`) so providers don't reimplement chunking against per-platform message-length limits.

The provider owns:

- Connecting to the platform and translating its events into `IncomingMessage`.
- Posting messages, reactions, and typing indicators back via `BridgeProvider.send` / `react` / `sendTyping`.
- Resolving "this conversation maps to which agent + Maestro session" via `BridgeProvider.resolveConversation`.
- Any platform-specific surface (slash commands, threads, voice flags, mentions).
- Its own `<PROVIDER>_*` env vars and any provider-specific DB tables (named `<provider>_*`).

## The `BridgeProvider` contract

Defined in `src/core/types.ts`. Every provider exports a class implementing this:

| Method                          | Required | Purpose                                                                              |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `start(ctx: KernelContext)`     | yes      | Connect to the platform, register event handlers, call `ctx.enqueue(msg)` per inbound message |
| `stop()`                        | yes      | Disconnect cleanly; called on graceful shutdown                                      |
| `resolveConversation(message)`  | yes      | Look up the maestro agent + session bound to this conversation; return null to drop  |
| `send(target, msg)`             | yes      | Post a message into a channel/thread; called by the kernel queue                     |
| `findOrCreateAgentChannel(id)`  | yes      | Look up or create the platform channel bound to an agent (used by `/api/send`)       |
| `isReady()`                     | yes      | Provider readiness for `/api/health`                                                 |
| `react?(target, emoji)`         | optional | Queue/transcription indicator (e.g. `⏳`, `🎧`)                                      |
| `sendTyping?(target)`           | optional | Typing indicator while the agent thinks                                              |

The kernel calls `react` and `sendTyping` if they exist; safe to omit when the platform has no analogue.

### `KernelContext`

What `start(ctx)` receives. Currently exposes:

- `ctx.enqueue(msg: IncomingMessage, options?: EnqueueOptions)` — push a message into the per-conversation queue. `options.attachmentsOverride` lets the provider replace the attachment list (used by voice transcription to drop the audio file). `options.contentOverride` lets the provider rewrite the message content (used by voice transcription to inject the transcript).
- `ctx.logger` — kernel-supplied error logger; provider should use this rather than `console.error` so logs land where the kernel expects.

### `IncomingMessage`

Provider → kernel (see `src/core/types.ts` for the source of truth):

```ts
{
  provider: ProviderName;       // 'discord', 'slack', etc.
  messageId: string;            // platform-native message ID
  channelId: string;            // conversation id — equals threadId for thread messages, channelId otherwise
  authorId: string;             // platform user ID of sender
  authorName: string;           // display name (used in logs and outbound formatting)
  content: string;              // raw text content
  attachments: IncomingAttachment[];
  isThread: boolean;            // true when the conversation is a sub-thread (Discord thread, Slack thread reply, etc.)
  raw?: unknown;                // adapter-internal payload (raw SDK message, etc.) — opaque to the kernel
}
```

`IncomingAttachment` is `{ url, name, size, contentType? }`. There's no kernel-level `isVoice` flag; voice handling is provider-driven (see "Voice transcription" below).

### `OutgoingMessage`

Kernel → provider:

```ts
{
  text: string;
  mention?: boolean;   // provider decides how to render (e.g. Discord: prepend <@DISCORD_MENTION_USER_ID>)
}
```

The kernel splits long replies via `splitMessage` and calls `send` once per part; only the first part carries `mention=true` when requested.

## Project layout convention

All provider code lives under `src/providers/<name>/`. Mirror the Discord layout:

```
src/providers/<name>/
├── adapter.ts          # The class implementing BridgeProvider
├── config.ts           # Loads <PROVIDER>_* env vars (called lazily at start())
├── messageCreate.ts    # Translates platform events → IncomingMessage
├── channelsDb.ts       # provider='<name>'-bound wrapper around src/core/db
├── deploy.ts           # (optional) Registers slash/app commands with the platform
├── commands/           # (optional) Slash/app command handlers
└── <other>.ts          # Anything else strictly platform-specific
```

Things to keep out of `src/core/`: SDK imports (`discord.js`, `@slack/bolt`, etc.), platform-specific types, slash-command schemas. The kernel should compile and pass tests with every provider directory deleted.

## Hooking the provider in

### 1. Register the adapter

In `src/core/providers.ts`, add a `case` to `loadProvider` (alongside the existing `discord` and `slack` cases):

```ts
case 'teams': {
  const { TeamsProvider } = await import('../providers/teams/adapter');
  return new TeamsProvider();
}
```

This is the only kernel file the provider should touch.

### 2. Document env vars

Add a section to `.env.example`:

```env
# --- Teams provider (loaded only if 'teams' is in ENABLED_PROVIDERS) ---
TEAMS_BOT_TOKEN=your_token_here
TEAMS_APP_ID=your_app_id_here
TEAMS_TENANT_ID=your_tenant_id_here
```

Validate creds in `start(ctx)`, throwing a clear error if missing. Don't validate at module load — a disabled provider must not fail the bridge on missing env.

### 3. DB tables

Provider-specific tables go in `src/core/db/migrations.ts` with the naming convention `<provider>_<table>` (e.g. `discord_agent_threads`). Migrations are idempotent and run on first start.

The shared `agent_channels` table is keyed on `(provider, channel_id)` — wrap it in a thin provider-bound module (see `src/providers/discord/channelsDb.ts` for the pattern) so call sites don't repeat the provider name.

### 4. Installer module switch

`install.sh` exposes `MAESTRO_RELAY_MODULE` for selecting an install-time provider. Today it only accepts `discord`. When adding a provider:

- Update the `normalize_module` allow-list in `install.sh`.
- Add provider-credential prompts to `write_config` (gated on the selected module).
- Update `cmd_deploy` in `bin/maestro-relay-ctl.sh` to route to the right `dist/providers/<name>/deploy.js` based on `ENABLED_PROVIDERS`.

Keep installer module selection aligned with runtime `ENABLED_PROVIDERS` and CLI `--provider` support.

### 5. Documentation

Add a `docs/<provider>.md` mirroring `docs/discord.md`'s structure: bot setup, configuration table, command surface, runtime behavior, security, troubleshooting. Link it from the README.

## Testing

- Unit-test the message translation (platform event → `IncomingMessage`) in isolation; don't pull in the platform SDK runtime in tests.
- The kernel's tests (`src/__tests__/queue.test.ts`, `server.test.ts`, etc.) use `mockProvider.test.ts` as a reference for a minimal `BridgeProvider` implementation — copy that pattern when building a real adapter so the kernel tests stay provider-agnostic.
- Run the full suite: `npm test` (169 tests at time of writing). All kernel tests should pass with your provider added.

## Voice transcription

If your platform has a "voice message" primitive (Discord's `IsVoiceMessage`, etc.), transcription is provider-driven but uses a kernel utility:

1. In `messageCreate.ts`, detect the voice flag and pull the audio attachment out of the regular list.
2. Optionally `react()` with `🎧` while transcription runs.
3. Call `transcribeVoiceAttachment` from `src/core/transcription.ts` for each voice attachment.
4. Enqueue the message with `contentOverride` set to the original text plus transcript, and `attachmentsOverride` set to the non-voice attachments so the kernel's queue skips the audio file.
5. On transcription failure, fall back to forwarding the audio as a regular attachment with an error advisory.

See `src/providers/discord/messageCreate.ts` for the canonical implementation, and [`docs/voice.md`](docs/voice.md) for runtime/setup details.

## Checklist for shipping a new provider

- [ ] `src/providers/<name>/adapter.ts` implements `BridgeProvider`
- [ ] `loadProvider` in `src/core/providers.ts` recognizes `<name>`
- [ ] `.env.example` documents `<PROVIDER>_*` keys
- [ ] DB migrations (if any) named `<provider>_*` and idempotent
- [ ] `install.sh` `normalize_module` allow-list includes `<name>`
- [ ] `bin/maestro-relay-ctl.sh:cmd_deploy` routes to the new provider
- [ ] `docs/<provider>.md` mirrors `docs/discord.md`
- [ ] README's provider list updated
- [ ] `npm test` green (kernel tests pass, plus provider-specific tests)
