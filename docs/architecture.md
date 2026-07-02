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
   - Normalizes markdown tables in the response (see **Output rendering** below), splits it, and calls `provider.send(target, {text})` for each part
   - Posts a usage footer: tokens, cost, context %
   - Persists the maestro session id on the first response via `conv.persistSession`
5. Errors are logged to `logs/errors.log` and surfaced as a `⚠️` reply in the channel.

## Thread ownership (Discord)

Each thread is bound to the user who created it (via mention or `/session new`).

- Only the bound owner can trigger agent responses inside that thread.
- Messages from other users are silently ignored — no error reply, no forwarding.
- This prevents cross-talk and keeps each conversation scoped to one user.

## Output rendering

Agent responses often contain GitHub-flavored markdown tables, which no chat
platform renders (Discord has no table syntax; Slack's *mrkdwn* has none) — they
arrive as raw `| a | b |` pipes. The kernel normalizes them in one
provider-agnostic place so every provider benefits:

- `src/core/renderTables.ts` (`renderTables`) detects GFM table blocks and
  re-emits each as a width-aligned ASCII table wrapped in a ``` code fence,
  which every target platform renders in a fixed-width font so columns line up.
  Column alignment markers (`:--`, `--:`, `:--:`) are honored. Tables wider than
  `MAX_TABLE_WIDTH` have their widest columns truncated with an ellipsis (`…`).
  Tables already inside a code fence are left untouched.
- `src/core/splitMessage.ts` is fence-aware: when a long response is split across
  the per-message length limit, an open code fence is closed on one chunk and
  re-opened on the next, so a rendered table never loses its monospace block.

Both run in the queue just before `provider.send`, so providers receive
already-normalized text. Caveat: inline markdown inside a cell (bold, links)
renders literally, since the cell now lives inside a code fence — alignment is
the deliberate tradeoff.

## Read-only mode

`/agents readonly on` puts an agent channel into read-only mode. In this mode the bridge relays messages from the agent (via the HTTP API) but does **not** forward user messages to the agent. Use `/agents readonly off` to resume normal two-way messaging.

## Database

| Table                     | Owner                 | Purpose                                             |
| ------------------------- | --------------------- | --------------------------------------------------- |
| `agent_channels`          | core                  | `(provider, channel_id)` → agent + session + flags  |
| `discord_agent_threads`   | discord provider      | Thread → channel + agent + owner + session          |

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
| `src/core/renderTables.ts`                    | GFM tables → fenced, aligned ASCII tables              |
| `src/core/splitMessage.ts`                    | Fence-aware message splitting to the length limit      |
| `src/core/errors.ts`                          | Typed errors (`RateLimitError`, `AgentNotFoundError`)  |
| `src/providers/discord/adapter.ts`            | DiscordProvider implementing BridgeProvider            |
| `src/providers/discord/messageCreate.ts`      | Discord message → IncomingMessage                      |
| `src/providers/discord/voice.ts`              | Discord voice-message detection                        |
| `src/providers/discord/commands/`             | Slash command handlers                                 |
| `src/providers/discord/deploy.ts`             | Registers slash commands with Discord API              |
| `src/cli/maestro-relay.ts`                   | CLI tool for agent → chat messaging                    |
| `src/index.ts`                                | Kernel orchestrator (entry point)                      |

## Adding a new provider

See [AGENTS-providers.md](../AGENTS-providers.md) (also linked as [CLAUDE-providers.md](../CLAUDE-providers.md)) for the full provider-development guide: kernel/provider contract, file-layout convention, DB and env conventions, voice-transcription integration, and a shipping checklist.
