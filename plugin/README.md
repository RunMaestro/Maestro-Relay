# Maestro Relay — Maestro Plugin (build target)

This folder is the **distributable Maestro plugin** for Maestro Relay: a tier-2 plugin that runs
the Discord and Slack bridges entirely inside Maestro through the brokered plugin SDK. It is built
onto the `rc` branch.

For **why** this shape (and why "wrap the existing Node service" is impossible), read
[`../docs/plans/maestro-plugin-architecture.md`](../docs/plans/maestro-plugin-architecture.md) and
the [`provider matrix`](../docs/plans/maestro-plugin-provider-matrix.md). Both are grounded in the
Maestro source at `HOST_API 1.12.0`.

## Contents (as it fills in over the roadmap)

| File | Status | Purpose |
| --- | --- | --- |
| `plugin.json` | ✅ present, validated | Manifest (tier 2, host API 1.12.0). Passes Maestro's own `validatePluginManifest` + `collectContributions`. |
| `entry.js` | ✅ built, sandbox-verified | Sandbox-safe CommonJS bundle (esbuild of `src/plugin/`). Ships the lifecycle, config, storage-backed channel↔agent registry, the dispatch→reply router, the Discord Gateway + Slack Socket-Mode clients, the panel command handlers (save config/secrets + rebuild providers, bind/unbind), and the masked-persona multi-agent room bus + `relay-room-*` commands. Rebuild with `npm run build:plugin`. |
| `panel.html` | ✅ present | Configuration UI (Settings placement). Write-only: enter the bot tokens, toggle providers + log level/ids, save (persists then reconnects the bridges), and bind channels to agents. It posts `maestro:invokeCommand` over the host bridge; every result surfaces as a Maestro toast (the panel has no reply channel). |
| `signature.json` | ⏳ per-operator | ed25519 signature over the packaged folder. Required — see below. Produced (on a staged copy) by `npm run pack:plugin`; never committed here. |

## Building

- `npm run build:plugin` bundles `src/plugin/entry.ts` into `plugin/entry.js` (esbuild, CommonJS). The build fails if the output contains anything the sandbox forbids — `require`, `process`, `Buffer`, dynamic `import()`, or Node builtins — so a regression can never ship a bundle that crashes on load.
- Plugin sources live in `src/plugin/` (TypeScript): `sdk.ts` (typed brokered-SDK surface), `reply.ts` (the dispatch→transcript-poll reply loop), `registry.ts` (storage-backed bindings + settings config), `rooms.ts` (KV-backed multi-agent room registry + the masked-persona serial bus), `providers/{discord,slack}.ts` (the plain-JS gateway clients), and `entry.ts` (lifecycle, commands, message router, provider wiring, and the panel command handlers). The config UI is `plugin/panel.html`.
- Tests: `npm test` (see `src/__tests__/plugin-*.test.ts`) covers the reply loop, the registry, the router, and a bare-`vm` sandbox load of the built `entry.js`.
- `npm run pack:plugin -- [--gen-key --key-out <pem> | --key <pem>] [--agents "<id,id>"]` produces the signed, installable `plugin-dist/*.tgz` (stage → inject allowlist → sign → trusted-validate → pack). See the per-operator section below.

## Prerequisites to run (not optional)

1. **Enable the `plugins` Encore feature** in Maestro (off by default).
2. **Trust the signing key.** `net:connect` is **trusted-only** and `transcripts:read` alongside
   network egress also requires trust. The plugin must be signed and its public key added to
   Maestro's trusted set, or the gateway sockets are refused and nothing runs.

## The `agents:dispatch` allowlist is per-operator (important)

`agents:dispatch` has an **allowlist** scope: Maestro rejects an unscoped request as a wildcard, so
the manifest must name the **exact agent ids** the relay may route to. Agent ids are specific to
your Maestro install, and an installed plugin's sandboxed panel can neither edit `plugin.json` nor
sign it. Therefore the base `plugin.json` here **omits `agents:dispatch`**, and you add it as a
**pre-install packaging step**:

1. In Maestro, note the agent id(s) you want the relay to drive (the config panel lists them via
   `agents:read` once running, or use `maestro-cli`).
2. Build the signed, installable archive in one step. `npm run pack:plugin` stages a copy of this
   folder (the committed source stays pristine — no `signature.json`, no agent ids leak into the
   repo), injects the `agents:dispatch` allowlist, signs, validates the signature as **trusted**,
   and packs the `.tgz` into `plugin-dist/`:

   ```bash
   # first time: mint a signing key, then add the printed public key to Maestro's trusted set
   npm run pack:plugin -- --gen-key --key-out plugin-dist/relay-key.pem \
     --agents "<agent-id-1>,<agent-id-2>"

   # thereafter: reuse your trusted key
   npm run pack:plugin -- --key plugin-dist/relay-key.pem \
     --agents "<agent-id-1>,<agent-id-2>"
   ```

   Under the hood it drives Maestro's own `maestro-cli plugin sign|validate|pack`, so what it signs
   is exactly what the desktop app verifies at install. If `maestro-cli.js` isn't at the default
   install path, point at it with `--maestro-cli <path>` or `$MAESTRO_CLI`. `plugin-dist/` and
   `*.pem`/`*.key` are gitignored — the private key never enters the repo or the archive. Omit
   `--agents` to build the base package (connections + config only; message routing stays off until
   you re-pack with `--agents`).
3. Install the `plugin-dist/*.tgz` from **Settings → Plugins**, enable it, approve the capabilities,
   add the agent ids to the dispatch allowlist, and approve **unattended** dispatch (socket-driven
   dispatch is never user-present).

A friendlier consent-time allowlist entry would be a Maestro host feature request; it is tracked in
the architecture doc.

## Configuration model

- **Secrets** (bot tokens, Slack app-level token) → the plugin's private **storage KV**
  (`relay:secret:*`), entered in the config panel. Never in settings (Maestro rejects
  secret-looking setting keys).
- **Non-secret config** (enabled providers, log level, client/guild/team/app ids, allowed user ids)
  → plugin **settings** under `plugins.sh.maestro.relay.*`, declared in `plugin.json`.
- **Channel↔agent bindings** → private **storage KV** (`relay:bindings`), one entry per
  `provider:channelId`, added/removed from the panel's bind form.
- The panel is **write-only** (Maestro's panel bridge is one-way): it posts `maestro:invokeCommand`
  and cannot read state back, so saved/connected/bound results arrive as **toasts**. Saving config
  persists the values and immediately rebuilds + reconnects the enabled bridges.

## Multi-agent rooms

One provider channel can front many Maestro agents as addressable personas — the plugin port of
the kernel's room feature. The sandbox caps outbound sockets (no room-bot pool is possible), so the
plugin runs **masked-persona mode only**: the single provider bot mirrors every persona with a
bold-handle prefix (`**Handle:**` on Discord, `*Handle:*` on Slack). Personas address one another
with `@Handle`, `@all`, or `@human`; the bus serializes turns per room with burst-cap, echo-guard,
and mention-cap safety brakes (reused from `src/core/room/protocol.ts`).

Once a channel is a room, `routeInbound` routes it through the room bus instead of any 1:1 binding.
Manage rooms with these commands (palette or `maestro-cli`; args are passed as an object):

| Command | Args | Effect |
| --- | --- | --- |
| `relay-room-create` | `provider`, `channelId`, `name?` | Create (or return) a room. |
| `relay-room-add` | `provider`, `channelId`, `agentId`, `displayName?` | Add an agent as a persona; the handle is derived from the display name. |
| `relay-room-remove` | `provider`, `channelId`, `target` (agent id or handle) | Remove a persona. |
| `relay-room-pause` / `relay-room-resume` | `provider`, `channelId` | Hold / release the room's turn backlog. |
| `relay-room-delete` | `provider`, `channelId` | Delete the room and its personas. |
| `relay-room-list` | — | List every room, its status, and its personas (the only room command surfaced in the palette). |

Each persona's agent id still has to be in the packaged `agents:dispatch` allowlist (see above).

## Not available in v1

- **Voice transcription** — needs `ffmpeg`/`whisper` via `process:spawn`, gated by Maestro's empty
  host-owned binary allowlist (a host change).
- **Local HTTP API / `maestro-relay` CLI push** — the sandbox cannot listen for inbound
  connections.
- **Slack HTTP / Events-API mode** and **Teams** — both need a public inbound webhook the sandbox
  cannot host. Slack runs in **Socket Mode** only.
