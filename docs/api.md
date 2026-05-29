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
  "provider": "discord"
}
```

`provider` is optional and defaults to `"discord"`. Must be a name listed in `ENABLED_PROVIDERS`.

`mention` is rendered by the provider in a platform-appropriate way (Discord prepends `<@DISCORD_MENTION_USER_ID>` to the first part of a multi-part message).

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
| `429`  | Rate limited by upstream platform after 3 retries              |
| `500`  | Internal server error                                          |
| `503`  | The named provider is not connected                            |
