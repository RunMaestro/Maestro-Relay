# Changelog

Notable changes per release. Releases before v0.4.2 are summarised from the git
history; see `git log v0.4.0..v0.4.1` and friends for the full detail.

## v0.4.2 — unreleased

Five features and one hardening fix, all reviewed before merge. Every review
finding raised on the source PRs was fixed in the branch rather than deferred;
the security-relevant ones are called out below.

### Added

- **Ambient mode** (#69) — an agent can follow a Discord channel and answer
  without being mentioned, batching a conversation into one turn once the room
  goes quiet. Off unless switched on per channel with `/agents ambient on`.
  Tuned by `AMBIENT_WINDOW_MS`, `AMBIENT_MAX_BATCH`, `AMBIENT_MAX_WAIT_MS`.
  See [docs/ambient.md](docs/ambient.md).
- **Prompt-injection screening** (#70) — optional scoring of every inbound
  prompt via 0din.ai SusFactor, in `log`, `flag` or `block` mode. Off unless
  `SUSFACTOR_MODE` is set. Provider-agnostic; lives in the kernel queue.
  See [docs/susfactor.md](docs/susfactor.md).
- **Private agent channels** (#71) — `/agents new` now creates the channel with
  permission overwrites set at creation time, visible only to the creator and
  the bot. `/agents grant` and `/agents revoke` manage access from chat.
  `visibility:public` opts out per channel.
- **Two-tier slash-command access** (#72) — `DISCORD_VIEWER_USER_IDS` grants a
  read-only tier alongside the existing all-or-nothing
  `DISCORD_ALLOWED_USER_IDS`. Unclassified commands are admin-tier, so a
  command added later is closed to viewers until classified deliberately.
- **GitHub-style callout embeds** (#75) — `> [!NOTE]` / `[!TIP]` /
  `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` blockquotes in agent replies
  render as colored embeds on Discord and Slack. Ported from rc (#62).

### Security

- **Credential redaction in every log sink** (#74) — credential-shaped strings
  are redacted before they reach console or file. Ported from rc.
- **Viewer tier no longer fails open** (#72) — `DISCORD_VIEWER_USER_IDS` set
  with an empty `DISCORD_ALLOWED_USER_IDS` used to leave every command open to
  everyone, including `/playbook run`. That combination is now rejected at
  startup, and the authorization check fails closed on it independently.
- **`/agents grant` and `/agents revoke` require channel-management
  permission** (#71) — previously anyone who could see an agent channel could
  widen access to it, so a granted collaborator could hand a stranger a shell
  on the operator's machine.
- **Untrusted-input fence is no longer forgeable** (#70) — a flagged message
  could emit its own `--- END UNTRUSTED MESSAGE ---` and place instructions
  outside the region the banner told the agent to distrust.
- **`SUSFACTOR_FAIL_OPEN` rejects unrecognised values** (#70) — `0`, `no` and
  `off` silently meant fail-**open**. All the usual spellings are now honoured
  and anything else fails startup.

### Changed

- **The documented Discord invite integer changed** to `309506182224`, adding
  **Manage Roles** and **Read Message History**. **Existing installs must
  re-invite the bot**: without Manage Roles, `/agents new` fails with
  `Missing Permissions` and `/agents grant` / `/agents revoke` fail on every
  call. See [docs/discord.md](docs/discord.md#bot-setup).
- Fail-closed screening no longer promotes the configured mode. On a 0din
  outage, `log` forwards, `flag` forwards with the untrusted-input banner, and
  only `block` blocks.

## v0.4.1 — 2026-06-30

Opt-in RC release channel for the installer and updater
(`MAESTRO_RELAY_CHANNEL`, `channel` subcommand, `update --rc`). No provider
changes.

## v0.4.0 — 2026-06-26

Markdown tables in agent replies render as aligned fenced ASCII. Kernel and
provider docs refreshed after v0.3.0.

## v0.3.0 — 2026-06-07

Leveled logger consolidating `console.*`, provider-agnostic rate-limit and
not-found errors, and installer fixes (`PATH` on the systemd unit and launchd
plist, `maestro-relay` CLI shim on `PATH`).

## v0.2.0 and earlier — 2026-05-11 and before

See `git log v0.2.0`.
