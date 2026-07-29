# Maestro Relay HTTP API

Maestro agents can push messages into chat using the `maestro-relay` CLI (or any HTTP client). The bridge exposes a local HTTP API on `127.0.0.1:API_PORT` (default 3457).

## Setup

The API server starts automatically with the bridge. Port is configurable via `API_PORT` in `.env`.

## CLI usage

`maestro-relay` is verb-based. Run `maestro-relay --help` for the full
list, or `maestro-relay <verb> --help` for verb-specific options.

```bash
# Send a message to an agent's bridge channel (default provider: discord)
maestro-relay send --agent <agent-id> --message "Hello from Maestro"

# Send to an explicit provider/module
maestro-relay send --agent <agent-id> --provider discord --message "Hello from Maestro"

# Send with @mention (uses the provider's configured mention target,
# e.g. DISCORD_MENTION_USER_ID for the Discord provider)
maestro-relay send --agent <agent-id> --message "Build complete!" --mention

# Send as part of a session — a reply thread on this message continues that
# session instead of starting a new one (Discord; see "Answerable pushes")
maestro-relay send --agent <agent-id> --session <session-id> --message "Deploy done — questions?"

# Use a custom port
maestro-relay send --agent <agent-id> --message "Hello" --port 4000

# Post a styled toast or flash notification
maestro-relay notify toast --agent <id> --provider discord --title "Deploy" --message "Done" --color green
maestro-relay notify flash --agent <id> --message "Tests passing" --color green

# Post the agent's current status (pulls from `maestro-cli show agent --json`)
maestro-relay status --agent <id> --provider discord
```

If the agent doesn't have a connected channel yet, one is auto-created.

## Health check

```bash
curl http://127.0.0.1:3457/api/health
```

Returns:

```json
{
  "success": true,
  "status": "ok",
  "uptime": 123.45,
  "providers": { "discord": true }
}
```

## API endpoints

### POST /api/send

Sends a message to an agent's chat channel (auto-creates if needed).

Request: `Content-Type: application/json`

```json
{
  "agentId": "string",
  "message": "string",
  "mention": false,
  "provider": "discord",
  "sessionId": "string"
}
```

`provider` is optional and defaults to `"discord"`. Must be a name listed in `ENABLED_PROVIDERS`.

`mention` is rendered by the provider in a platform-appropriate way (Discord prepends `<@DISCORD_MENTION_USER_ID>` to the first part of a multi-part message).

`sessionId` is optional — see [Answerable pushes](#answerable-pushes).

Response:

```json
{
  "success": true,
  "channelId": "123456789",
  "messageIds": ["987654321"]
}
```

`messageIds` lists the platform message ids of the posted parts, in order, for providers that report them (Discord). Providers that don't return an empty array.

#### Answerable pushes

An agent-initiated push is a dead end by default: the bridge posts it, and a human answering it in the channel has nothing to route the answer back to.

Passing `sessionId` fixes that for **Discord**. The bridge records each posted message against `(agentId, sessionId)`, and when someone **starts a thread on that message**, the reply is routed into that same maestro session — the agent picks the conversation up where it left off, with its context intact. No thread bookkeeping is needed on the caller's side; the binding is established the first time somebody replies.

Notes:

- **Threads only.** An *inline* reply in the parent channel is not routed: the channel and the session would then share one processing queue, interleaving windup traffic with ordinary channel traffic. Reply in a thread on the message.
- The thread binds to whoever replied first, matching the ownership rule for mention-created threads.
- Without `sessionId`, a thread on a pushed message still reaches the right **agent** — it just opens a fresh session.
- Anchors are kept for **30 days**, then purged. Only ids are stored, never message content.
- Non-Discord providers accept and ignore `sessionId` today.

#### Rich rendering

The `message` body is rendered richly per provider — there is **no request-shape change**, detection is automatic:

- **GitHub alert callouts** (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` — uppercase, alone on their line) are auto-detected and rendered as a **colored Discord embed** / **colored Slack attachment**. A message containing multiple callouts **fans out into multiple provider messages**, each emitted in order with the surrounding prose. See [docs/discord.md → Callout embeds](discord.md#callout-embeds) and [docs/slack.md → Callout attachments](slack.md#callout-attachments).
- **Markdown tables** in the body are rendered as aligned, fenced ASCII tables. **Behavior change:** the push path (`/api/send`) now applies this table rendering (`renderTables`) to text as it already did for agent replies — prior versions did not transform push text.

Provider fallbacks:

- **Teams** currently renders callouts as their raw `> [!TYPE]` blockquote via the text fallback (an Adaptive Card rendering is a future enhancement) — see [docs/teams.md → Runtime behavior](teams.md#runtime-behavior).
- **Multi-agent rooms** do not yet render colored callouts (planned follow-up); callout text is delivered as-is.

### GET /api/health

Returns bridge status:

```json
{
  "success": true,
  "status": "ok",
  "uptime": 123.45,
  "providers": { "discord": true }
}
```

Returns `503` with `"status":"not_ready"` if no provider is connected.

## Error codes

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `200`  | Success                                                        |
| `400`  | Missing/invalid fields, malformed JSON, or unknown `provider` |
| `404`  | Agent not found in Maestro                                     |
| `405`  | Method not allowed                                             |
| `413`  | Request body exceeds 1 MB                                      |
| `415`  | Wrong Content-Type (must be `application/json`)                |
| `429`  | Rate limited by upstream platform after 3 retries (response includes a `Retry-After` header in seconds) |
| `500`  | Internal server error                                          |
| `503`  | The named provider is not connected                            |
