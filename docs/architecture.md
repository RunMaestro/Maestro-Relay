# Architecture

Maestro Relay is built around a **provider-agnostic kernel** plus pluggable **provider adapters**. The kernel handles queueing, agent dispatch, persistence, transcription, and the HTTP API; adapters translate platform events into a small set of kernel types and back out into platform actions.

## Kernel ↔ Provider contract

Each provider implements `BridgeProvider` (from `src/core/types.ts`):

| Method                          | Purpose                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `start(ctx)`                    | Connect to the platform, register event handlers, call `ctx.enqueue` per msg   |
| `stop()`                        | Disconnect and release resources                                               |
| `resolveConversation(message)`  | Look up the maestro agent + session bound to this conversation                 |
| `send(target, msg)`             | Post a message into a channel/thread                                           |
| `react?(target, emoji)`         | Optional: queue/transcription indicator (e.g. ⏳, 🎧)                          |
| `sendTyping?(target)`           | Optional: typing indicator while the agent thinks                              |
| `findOrCreateAgentChannel(id)`  | Look up or create the platform channel bound to an agent (used by `/api/send`) |
| `isReady()`                     | Provider readiness for `/api/health`                                           |

The kernel speaks only in `IncomingMessage` / `OutgoingMessage` / `ChannelTarget`; it has zero `discord.js` imports.

## Message flow (Discord)

1. User runs `/agents new` in their server → Discord adapter creates a text channel under the **Maestro Agents** category and registers it in `agent_channels` with `provider='discord'`.
2. User mentions the bot in an agent channel → Discord adapter creates a thread, registers it in `discord_agent_threads`, and forwards the triggering message into the thread.
3. Each thread/channel message becomes an `IncomingMessage` and is passed to `ctx.enqueue`.
4. The kernel queue serializes per `(provider, channelId)`:
   - Calls `provider.react('⏳')` and `provider.sendTyping()`
   - Resolves the conversation via `provider.resolveConversation` (returns `{agentId, sessionId, readOnly, persistSession}`)
   - Downloads any attachments to the agent's `cwd`
   - Calls `maestro.send(agentId, content, sessionId, readOnly)`
   - Splits the response and calls `provider.send(target, {text})` for each part
   - Posts a usage footer: tokens, cost, context %
   - Persists the maestro session id on the first response via `conv.persistSession`
5. Errors are logged to `logs/errors.log` and surfaced as a `⚠️` reply in the channel.

## Message flow (Telegram)

Telegram uses a **bot-per-agent** model: at install time the bot is bound to one Maestro agent (`TELEGRAM_AGENT_ID`) and one chat (`TELEGRAM_CHAT_ID`). One bot serves exactly one agent for its lifetime.

1. **Forum mode**: user sends `/session new` in the supergroup main feed → adapter calls `bot.api.createForumTopic`, registers the new topic in `telegram_agent_topics`, and treats that topic as one Maestro session. Subsequent messages in the topic are routed to that session.
2. **DM mode**: the bound chat is a single shared session. `/session new` clears the stored session id so the next message starts a fresh maestro session.
3. Each message becomes an `IncomingMessage` with `channelId = chatId` (DM) or `chatId:topicId` (forum) and is passed to `ctx.enqueue`.
4. The kernel queue serializes per `(provider, channelId)` exactly as for Discord — reactions/typing, `resolveConversation`, attachment download, `maestro.send`, response splitting, usage footer, session persistence.
5. Outbound: `provider.send` posts via `bot.api.sendMessage`, attaching `message_thread_id` when the target is a forum topic. Long responses are split at the 4096-char Telegram message limit.
6. `findOrCreateAgentChannel(agentId)` enforces the single-agent binding by throwing if `agentId !== TELEGRAM_AGENT_ID` — agent-initiated messages from `/api/send` for any other agent are rejected.

## Thread ownership (Discord)

Each thread is bound to the user who created it (via mention or `/session new`).

- Only the bound owner can trigger agent responses inside that thread.
- Messages from other users are silently ignored — no error reply, no forwarding.
- This prevents cross-talk and keeps each conversation scoped to one user.

## Read-only mode

`/agents readonly on` puts an agent channel into read-only mode. In this mode the bridge relays messages from the agent (via the HTTP API) but does **not** forward user messages to the agent. Use `/agents readonly off` to resume normal two-way messaging.

## Database

| Table                     | Owner                 | Purpose                                             |
| ------------------------- | --------------------- | --------------------------------------------------- |
| `agent_channels`          | core                  | `(provider, channel_id)` → agent + session + flags  |
| `discord_agent_threads`   | discord provider      | Thread → channel + agent + owner + session          |
| `telegram_agent_topics`   | telegram provider     | `(chat_id, topic_id)` → agent + session             |

The schema upgrades on first start: legacy `agent_channels` (single-PK `channel_id`) is rebuilt with composite PK `(provider, channel_id)` and existing rows defaulted to `discord`; legacy `agent_threads` is renamed to `discord_agent_threads`.

## Project layout

| Path                                          | Purpose                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| `src/core/types.ts`                           | Provider contract types                                |
| `src/core/queue.ts`                           | Per-conversation FIFO message queue                    |
| `src/core/api.ts`                             | Internal HTTP API server                               |
| `src/core/providers.ts`                       | Provider registry                                      |
| `src/core/db/index.ts`                        | SQLite channel registry                                |
| `src/core/db/migrations.ts`                   | Idempotent schema migrations                           |
| `src/core/maestro.ts`                         | `maestro-cli` wrapper                                  |
| `src/core/transcription.ts`                   | ffmpeg + whisper pipeline                              |
| `src/core/attachments.ts`                     | Provider-agnostic attachment download                  |
| `src/providers/discord/adapter.ts`            | DiscordProvider implementing BridgeProvider            |
| `src/providers/discord/messageCreate.ts`      | Discord message → IncomingMessage                      |
| `src/providers/discord/voice.ts`              | Discord voice-message detection                        |
| `src/providers/discord/commands/`             | Slash command handlers                                 |
| `src/providers/discord/deploy.ts`             | Registers slash commands with Discord API              |
| `src/providers/telegram/adapter.ts`           | TelegramProvider implementing BridgeProvider           |
| `src/providers/telegram/messageHandler.ts`    | Telegram update → IncomingMessage                      |
| `src/providers/telegram/voice.ts`             | Telegram voice-message detection + download            |
| `src/providers/telegram/topicsDb.ts`          | `telegram_agent_topics` accessor                       |
| `src/providers/telegram/commands/`            | Slash command handlers (dispatched by messageHandler)  |
| `src/providers/telegram/deploy.ts`            | Registers commands via `bot.api.setMyCommands`         |
| `src/providers/telegram/config.ts`            | `TELEGRAM_*` env loading                               |
| `src/cli/maestro-relay.ts`                   | CLI tool for agent → chat messaging                    |
| `src/index.ts`                                | Kernel orchestrator (entry point)                      |

## Adding a new provider

See [AGENTS-providers.md](../AGENTS-providers.md) (also linked as [CLAUDE-providers.md](../CLAUDE-providers.md)) for the full provider-development guide: kernel/provider contract, file-layout convention, DB and env conventions, voice-transcription integration, and a shipping checklist.
