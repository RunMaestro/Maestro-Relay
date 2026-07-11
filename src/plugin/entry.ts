/**
 * Maestro Relay plugin entry point (bundled by esbuild to `plugin/entry.js`).
 *
 * Runs inside the Maestro plugin sandbox. The host calls `activate(sdk)` on load
 * and `deactivate()` on unload. This module owns the plugin lifecycle, the
 * contributed commands, config/state wiring, and the message router that turns
 * an inbound chat message into a dispatched agent turn and a reply.
 *
 * v1 scope: lifecycle + config + binding registry + the dispatch/reply router,
 * plus the Discord Gateway and Slack Socket-Mode clients that FEED `routeInbound`
 * (and post the reply back via a {@link ReplySink} over each platform's REST
 * API). A provider registry lets each gateway client report its own connection
 * state, so `status()` reflects which bridges are actually live. The config panel
 * (`plugin/panel.html`) drives the {@link PANEL_COMMAND_IDS} — save tokens +
 * settings then rebuild providers, and bind/unbind channels to agents — over the
 * host's one-way `maestro:invokeCommand` postMessage bridge (no reply channel;
 * results surface as toasts).
 *
 * Sandbox-safe: imports only sibling plugin modules; no Node builtins, no
 * `require`, and only `setTimeout`/`clearTimeout`/`Promise`/`console` globals.
 */

import type { MaestroSdk } from './sdk';
import type { ReplyHandle, ReplyResult, ReplyScheduler } from './reply';
import { collectAgentReply } from './reply';
import type { RelayConfig } from './registry';
import { conversationKey, getBinding, getSecret, loadConfig, removeBinding, setBinding, setSecret } from './registry';
import { createDiscordClient } from './providers/discord';
import { createSlackClient } from './providers/slack';
import {
  addParticipant,
  createRoom,
  createRoomBus,
  deleteRoom,
  listRooms,
  removeParticipant,
  setRoomStatus,
  type RoomBus,
  type RoomDispatch,
  type RoomSendAs,
  type RoomSubmitResult,
} from './rooms';

/** Contributed command ids (must match `plugin.json` `contributes.commands`). */
export const COMMAND_IDS = [
  'relay-start',
  'relay-stop',
  'relay-status',
  'relay-reload-config',
] as const;

export type RelayCommandId = (typeof COMMAND_IDS)[number];

/**
 * Commands the config panel invokes over the `maestro:invokeCommand`
 * postMessage bridge. Deliberately NOT in `contributes.commands`: they take
 * args and are panel-only, never surfaced in the command palette — but they are
 * registered so the sandbox routes their local ids to `handleCommand`.
 */
export const PANEL_COMMAND_IDS = ['relay-save-config', 'relay-bind', 'relay-unbind'] as const;

export type RelayPanelCommandId = (typeof PANEL_COMMAND_IDS)[number];

/**
 * Multi-agent room CRUD commands. Registered like {@link PANEL_COMMAND_IDS} so
 * the sandbox routes them to `handleCommand`; only the no-arg `relay-room-list`
 * is surfaced in `contributes.commands` (the rest take args).
 */
export const ROOM_COMMAND_IDS = [
  'relay-room-create',
  'relay-room-delete',
  'relay-room-add',
  'relay-room-remove',
  'relay-room-list',
  'relay-room-pause',
  'relay-room-resume',
] as const;

export type RelayRoomCommandId = (typeof ROOM_COMMAND_IDS)[number];

/** Read a trimmed string field from a loosely-typed command args object. */
function argString(args: unknown, key: string): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Toast + return a uniform "missing args" message for a room command. */
async function roomArgError(sdk: MaestroSdk, op: string, required: string): Promise<string> {
  const message = `Relay room ${op} failed: ${required} are required.`;
  await sdk.notifications.toast(message);
  return message;
}

/**
 * Stable id + label for the supervised background service. Registering it tells
 * the host's background supervisor that this sandbox child holds long-lived work
 * (the gateway sockets): if the child crashes while registered, the supervisor
 * restarts it with bounded backoff, and the restart re-runs {@link activate},
 * which re-registers the service and reconnects the bridges. There is no separate
 * worker to spawn — the plugin child IS the service runtime.
 */
export const BACKGROUND_SERVICE_ID = 'relay-bridge';
export const BACKGROUND_SERVICE_NAME = 'Maestro Relay bridge';

/**
 * Host event topics the relay subscribes to. `agent.completed` drives reply
 * completion (see {@link RelayRuntime.onAgentCompleted}); `agent.statusChanged`
 * and `agent.error` feed the per-agent status indicators surfaced by
 * `relay-status`. All three need only `events:subscribe` (plus `agents:read` for
 * `agent.completed`), both already in the manifest.
 */
export const STATUS_TOPICS = ['agent.completed', 'agent.statusChanged', 'agent.error'] as const;

/** An inbound chat message, normalized across providers by the gateway clients. */
export interface InboundMessage {
  provider: string;
  channelId: string;
  userId: string;
  text: string;
  /** Optional reply-thread anchor. Providers that thread replies (Slack) set
   * this to the message's thread root; the sink posts the reply under it. */
  threadId?: string;
}

/** Posts a completed agent reply back to the originating channel. A provider
 * supplies its own (REST post over `net.fetch`); tests inject one directly. */
export type ReplySink = (message: InboundMessage, reply: ReplyResult) => void | Promise<void>;

export type RouteStatus = 'dispatched' | 'unbound' | 'empty' | 'room';

export interface RouteOutcome {
  status: RouteStatus;
  agentId?: string;
  reply?: ReplyResult;
  /** Present when `status === 'room'`: the multi-agent room submit result. */
  room?: RoomSubmitResult;
}

/**
 * A gateway client for one chat platform. Opens its own `net.connect` socket,
 * normalizes inbound events into {@link InboundMessage} + {@link routeInbound},
 * and posts replies back over the platform's REST API. The runtime owns the
 * registry; each client reports its own liveness for {@link RelayStatus}.
 */
export interface ProviderClient {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): void;
  connected(): boolean;
  /** Post a masked persona message into a channel for multi-agent rooms. The
   * provider applies its own bold-handle prefix. Absent on any provider without
   * masked-room support (the room bus then silently skips the post). */
  postAs?(channelId: string, handle: string, text: string): Promise<void>;
}

export interface RelayStatus {
  running: boolean;
  enabledProviders: string[];
  connectedProviders: string[];
  activeReplies: number;
  /** True once the host background supervisor is watching this child. */
  supervised: boolean;
  /** Last observed status per agent, newest wins (from status/error events). */
  agentStatuses: Array<{ agentId: string; status: string }>;
}

export interface RelayRuntime {
  config: RelayConfig;
  start(): void;
  stop(): void;
  status(): RelayStatus;
  reloadConfig(): Promise<RelayConfig>;
  handleCommand(commandId: string, args?: unknown): Promise<string>;
  routeInbound(message: InboundMessage, sink: ReplySink): Promise<RouteOutcome>;
  onAgentCompleted(payload: unknown): void;
  onAgentStatusChanged(payload: unknown): void;
  onAgentError(payload: unknown): void;
  /** Register this child with the host background supervisor (crash-restart).
   * Idempotent: a second call while registered is a no-op. */
  registerBackgroundService(): Promise<void>;
  /** Drop the supervisor registration so an intentional stop is not treated as
   * a crash. Swallows an "unknown service" the host may have cleared already. */
  unregisterBackgroundService(): Promise<void>;
  registerProvider(client: ProviderClient): void;
  /** Swap in a fresh set of provider clients: disconnect + drop the current
   * ones, register the new ones, and connect them if the runtime is running. */
  replaceProviders(clients: ProviderClient[]): void;
  /** Re-read config + secrets, rebuild every provider client, then start — the
   * panel's save-and-connect path, so token/setting edits take effect without
   * reloading the plugin. */
  reconnect(): Promise<void>;
}

/**
 * Build the relay runtime. Pure over `sdk`: no module-level state, so it is
 * unit-testable with a fake SDK. `activate` creates exactly one and keeps it for
 * `deactivate`.
 */
export function createRuntime(
  sdk: MaestroSdk,
  config: RelayConfig,
  scheduler?: ReplyScheduler,
): RelayRuntime {
  // sessionId -> in-flight reply, so `agent.completed` can flush the right one.
  const activeReplies = new Map<string, ReplyHandle>();
  const providers: ProviderClient[] = [];
  let running = false;
  // agentId -> last observed status string, for the chat status indicators.
  const agentStatus = new Map<string, string>();
  let backgroundServiceId: string | undefined;

  // Multi-agent rooms: one channel fronting many personas, all masked onto the
  // single provider bot. `roomDispatch` reuses the 1:1 reply loop (so
  // `agent.completed` still flushes it via `activeReplies`); `roomSendAs` routes
  // a masked post to the owning provider client's `postAs`.
  const roomDispatch: RoomDispatch = async (agentId, prompt) => {
    const handle = collectAgentReply(
      sdk,
      { agentId, prompt },
      {
        onSession(sessionId: string): void {
          activeReplies.set(sessionId, handle);
        },
      },
      scheduler,
    );
    const reply = await handle.promise;
    activeReplies.delete(reply.sessionId);
    return { text: reply.text, sessionId: reply.sessionId };
  };
  const roomSendAs: RoomSendAs = async (room, post) => {
    const client = providers.find((provider) => provider.name === room.provider);
    if (client?.postAs) await client.postAs(room.channelId, post.handle, post.text);
  };
  const bus: RoomBus = createRoomBus({ sdk, dispatch: roomDispatch, sendAs: roomSendAs });

  const runtime: RelayRuntime = {
    config,
    start(): void {
      running = true;
      for (const provider of providers) {
        provider.connect().catch((error) => {
          console.error(`[relay] provider "${provider.name}" failed to connect: ${String(error)}`);
        });
      }
    },
    stop(): void {
      running = false;
      for (const provider of providers) provider.disconnect();
      for (const handle of activeReplies.values()) handle.cancel();
      activeReplies.clear();
    },
    status(): RelayStatus {
      return {
        running,
        enabledProviders: runtime.config.enabledProviders.slice(),
        connectedProviders: providers.filter((provider) => provider.connected()).map((provider) => provider.name),
        activeReplies: activeReplies.size,
        supervised: backgroundServiceId !== undefined,
        agentStatuses: [...agentStatus.entries()].map(([agentId, status]) => ({ agentId, status })),
      };
    },
    async reloadConfig(): Promise<RelayConfig> {
      runtime.config = await loadConfig(sdk);
      return runtime.config;
    },
    async handleCommand(commandId: string, args?: unknown): Promise<string> {
      switch (commandId) {
        case 'relay-start': {
          runtime.start();
          const message = `Relay started; providers enabled: ${runtime.config.enabledProviders.join(', ') || '(none)'}. Gateway clients not yet connected.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-stop': {
          runtime.stop();
          await sdk.notifications.toast('Relay stopped.');
          return 'Relay stopped.';
        }
        case 'relay-status': {
          const s = runtime.status();
          const agents = s.agentStatuses.map((a) => `${a.agentId}=${a.status}`).join(', ') || '(none)';
          return `Relay ${s.running ? 'running' : 'stopped'} | supervised: ${s.supervised ? 'yes' : 'no'} | enabled: ${s.enabledProviders.join(', ') || '(none)'} | connected: ${s.connectedProviders.join(', ') || '(none)'} | active replies: ${s.activeReplies} | agents: ${agents}`;
        }
        case 'relay-reload-config': {
          const next = await runtime.reloadConfig();
          const message = `Configuration reloaded; providers enabled: ${next.enabledProviders.join(', ') || '(none)'}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-save-config': {
          const record = (args ?? {}) as {
            settings?: Record<string, unknown>;
            secrets?: Record<string, unknown>;
          };
          const settings =
            record.settings && typeof record.settings === 'object' ? record.settings : {};
          const secrets =
            record.secrets && typeof record.secrets === 'object' ? record.secrets : {};
          // Settings persist by property presence — an empty string is a valid
          // value (clears a guild/team id or an allowed-user list).
          let settingsCount = 0;
          for (const key of Object.keys(settings)) {
            // Writes are namespace-confined by the host (settings.set rejects any
            // key outside `plugins.<id>.*`); loadConfig reads that form back.
            await sdk.settings.set(`plugins.${sdk.pluginId}.${key}`, String(settings[key] ?? ''));
            settingsCount += 1;
          }
          // Secrets skip blanks so a left-empty token field never clobbers a
          // previously stored token.
          let secretCount = 0;
          for (const name of Object.keys(secrets)) {
            const value = secrets[name];
            if (typeof value === 'string' && value.trim().length > 0) {
              await setSecret(sdk, name, value.trim());
              secretCount += 1;
            }
          }
          await runtime.reconnect();
          const message = `Relay configuration saved (${settingsCount} setting(s), ${secretCount} secret(s)); providers enabled: ${runtime.config.enabledProviders.join(', ') || '(none)'}. Bridges (re)connecting.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-bind': {
          const record = (args ?? {}) as {
            provider?: unknown;
            channelId?: unknown;
            agentId?: unknown;
          };
          const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
          const channelId = typeof record.channelId === 'string' ? record.channelId.trim() : '';
          const agentId = typeof record.agentId === 'string' ? record.agentId.trim() : '';
          if (!provider || !channelId || !agentId) {
            const message = 'Relay bind failed: provider, channelId, and agentId are all required.';
            await sdk.notifications.toast(message);
            return message;
          }
          await setBinding(sdk, conversationKey(provider, channelId), agentId);
          const message = `Bound ${provider}:${channelId} -> agent ${agentId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-unbind': {
          const record = (args ?? {}) as { provider?: unknown; channelId?: unknown };
          const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
          const channelId = typeof record.channelId === 'string' ? record.channelId.trim() : '';
          if (!provider || !channelId) {
            const message = 'Relay unbind failed: provider and channelId are required.';
            await sdk.notifications.toast(message);
            return message;
          }
          const removed = await removeBinding(sdk, conversationKey(provider, channelId));
          const message = removed
            ? `Unbound ${provider}:${channelId}.`
            : `No binding found for ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-room-create': {
          const provider = argString(args, 'provider');
          const channelId = argString(args, 'channelId');
          const name = argString(args, 'name');
          if (!provider || !channelId) return roomArgError(sdk, 'create', 'provider and channelId');
          const room = await createRoom(sdk, provider, channelId, name ? { name } : {});
          const message = `Room ready: ${provider}:${channelId}${room.name ? ` ("${room.name}")` : ''}; ${room.participants.length} persona(s).`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-room-delete': {
          const provider = argString(args, 'provider');
          const channelId = argString(args, 'channelId');
          if (!provider || !channelId) return roomArgError(sdk, 'delete', 'provider and channelId');
          const removed = await deleteRoom(sdk, provider, channelId);
          const message = removed
            ? `Room deleted: ${provider}:${channelId}.`
            : `No room found for ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-room-add': {
          const provider = argString(args, 'provider');
          const channelId = argString(args, 'channelId');
          const agentId = argString(args, 'agentId');
          const displayName = argString(args, 'displayName') || agentId;
          if (!provider || !channelId || !agentId) {
            return roomArgError(sdk, 'add', 'provider, channelId, and agentId');
          }
          const participant = await addParticipant(sdk, provider, channelId, agentId, displayName);
          const message = `Added @${participant.handle} (agent ${agentId}) to ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-room-remove': {
          const provider = argString(args, 'provider');
          const channelId = argString(args, 'channelId');
          const target =
            argString(args, 'target') || argString(args, 'agentId') || argString(args, 'handle');
          if (!provider || !channelId || !target) {
            return roomArgError(sdk, 'remove', 'provider, channelId, and target (agent id or handle)');
          }
          const removed = await removeParticipant(sdk, provider, channelId, target);
          const message = removed
            ? `Removed "${target}" from ${provider}:${channelId}.`
            : `No persona "${target}" in ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        case 'relay-room-list': {
          const rooms = await listRooms(sdk);
          if (rooms.length === 0) return 'No rooms configured.';
          return rooms
            .map((room) => {
              const personas = room.participants.map((p) => `@${p.handle}`).join(', ') || '(none)';
              return `${room.roomKey} [${room.status}]${room.name ? ` "${room.name}"` : ''}: ${personas}`;
            })
            .join('\n');
        }
        case 'relay-room-pause':
        case 'relay-room-resume': {
          const provider = argString(args, 'provider');
          const channelId = argString(args, 'channelId');
          const op = commandId === 'relay-room-pause' ? 'pause' : 'resume';
          if (!provider || !channelId) return roomArgError(sdk, op, 'provider and channelId');
          const status = op === 'pause' ? 'paused' : 'active';
          const ok = await setRoomStatus(sdk, provider, channelId, status);
          const message = ok
            ? `Room ${provider}:${channelId} ${status === 'paused' ? 'paused' : 'resumed'}.`
            : `No room found for ${provider}:${channelId}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        default:
          throw new Error(`unknown relay command "${commandId}"`);
      }
    },
    async routeInbound(message: InboundMessage, sink: ReplySink): Promise<RouteOutcome> {
      if (message.text.trim().length === 0) return { status: 'empty' };
      if (await bus.isRoom(message.provider, message.channelId)) {
        const room = await bus.submitMessage(message.provider, message.channelId, 'human', message.text);
        return { status: 'room', room };
      }
      const agentId = await getBinding(sdk, conversationKey(message.provider, message.channelId));
      if (!agentId) return { status: 'unbound' };

      const handle = collectAgentReply(
        sdk,
        { agentId, prompt: message.text },
        {
          onSession(sessionId: string): void {
            activeReplies.set(sessionId, handle);
          },
        },
        scheduler,
      );
      const reply = await handle.promise;
      activeReplies.delete(reply.sessionId);
      await sink(message, reply);
      return { status: 'dispatched', agentId, reply };
    },
    onAgentCompleted(payload: unknown): void {
      const record = payload as { sessionId?: unknown; agentId?: unknown; status?: unknown } | null;
      const sessionId = record && typeof record.sessionId === 'string' ? record.sessionId : '';
      const agentId = record && typeof record.agentId === 'string' ? record.agentId : '';
      const status = record && typeof record.status === 'string' ? record.status : '';
      if (agentId.length > 0 && status.length > 0) agentStatus.set(agentId, status);
      if (sessionId.length === 0) return;
      const handle = activeReplies.get(sessionId);
      if (handle) handle.markComplete();
    },
    onAgentStatusChanged(payload: unknown): void {
      const record = payload as { agentId?: unknown; status?: unknown } | null;
      const agentId = record && typeof record.agentId === 'string' ? record.agentId : '';
      const status = record && typeof record.status === 'string' ? record.status : '';
      if (agentId.length === 0 || status.length === 0) return;
      agentStatus.set(agentId, status);
    },
    onAgentError(payload: unknown): void {
      const record = payload as { agentId?: unknown; errorType?: unknown; recoverable?: unknown } | null;
      const agentId = record && typeof record.agentId === 'string' ? record.agentId : '';
      const errorType = record && typeof record.errorType === 'string' ? record.errorType : 'unknown';
      const recoverable = record ? record.recoverable === true : false;
      if (agentId.length > 0) agentStatus.set(agentId, `error:${errorType}`);
      const target = agentId.length > 0 ? `agent ${agentId}` : 'an agent';
      void sdk.notifications.toast(
        `Relay: ${target} reported an error (${errorType}); recoverable=${recoverable ? 'yes' : 'no'}.`,
      );
    },
    registerProvider(client: ProviderClient): void {
      providers.push(client);
    },
    replaceProviders(clients: ProviderClient[]): void {
      for (const provider of providers) provider.disconnect();
      providers.length = 0;
      for (const client of clients) providers.push(client);
      if (running) {
        for (const provider of providers) {
          provider.connect().catch((error) => {
            console.error(`[relay] provider "${provider.name}" failed to connect: ${String(error)}`);
          });
        }
      }
    },
    async reconnect(): Promise<void> {
      runtime.stop();
      await runtime.reloadConfig();
      const clients = await buildConfiguredProviders(sdk, runtime.config, (message, sink) =>
        runtime.routeInbound(message, sink),
      );
      runtime.replaceProviders(clients);
      runtime.start();
    },
    async registerBackgroundService(): Promise<void> {
      if (backgroundServiceId !== undefined) return;
      const result = (await sdk.background.register({
        id: BACKGROUND_SERVICE_ID,
        name: BACKGROUND_SERVICE_NAME,
      })) as { serviceId?: unknown } | undefined;
      backgroundServiceId =
        result && typeof result.serviceId === 'string' && result.serviceId.length > 0
          ? result.serviceId
          : BACKGROUND_SERVICE_ID;
    },
    async unregisterBackgroundService(): Promise<void> {
      if (backgroundServiceId === undefined) return;
      const id = backgroundServiceId;
      backgroundServiceId = undefined;
      try {
        await sdk.background.unregister(id);
      } catch (error) {
        // The host clears registrations first on normal teardown, so an
        // "unknown service" here is expected and harmless.
        console.warn('[relay] background.unregister failed: ' + String(error));
      }
    },
  };

  return runtime;
}

/**
 * Build the provider clients enabled by `config`, each gated on its required
 * secret(s) in private KV. Construction is lazy — no socket opens until
 * `connect()`. Shared by `activate()` (first wiring) and `reconnect()` (the
 * panel's save-and-connect path).
 */
export async function buildConfiguredProviders(
  sdk: MaestroSdk,
  config: RelayConfig,
  route: (message: InboundMessage, sink: ReplySink) => Promise<RouteOutcome>,
): Promise<ProviderClient[]> {
  const clients: ProviderClient[] = [];

  const discordToken = await getSecret(sdk, 'discordToken');
  if (config.enabledProviders.includes('discord') && discordToken) {
    clients.push(createDiscordClient({ sdk, token: discordToken, config: config.discord, route }));
  }

  const slackAppToken = await getSecret(sdk, 'slackAppToken');
  const slackBotToken = await getSecret(sdk, 'slackBotToken');
  if (config.enabledProviders.includes('slack') && slackAppToken && slackBotToken) {
    clients.push(
      createSlackClient({ sdk, appToken: slackAppToken, botToken: slackBotToken, config: config.slack, route }),
    );
  }

  return clients;
}

let current: RelayRuntime | undefined;

export async function activate(sdk: MaestroSdk): Promise<void> {
  const config = await loadConfig(sdk);
  const runtime = createRuntime(sdk, config);
  current = runtime;

  for (const id of COMMAND_IDS) {
    sdk.commands.register(id, (args) => runtime.handleCommand(id, args));
  }
  for (const id of PANEL_COMMAND_IDS) {
    sdk.commands.register(id, (args) => runtime.handleCommand(id, args));
  }
  for (const id of ROOM_COMMAND_IDS) {
    sdk.commands.register(id, (args) => runtime.handleCommand(id, args));
  }

  sdk.events.on('agent.completed', (payload) => runtime.onAgentCompleted(payload));
  sdk.events.on('agent.statusChanged', (payload) => runtime.onAgentStatusChanged(payload));
  sdk.events.on('agent.error', (payload) => runtime.onAgentError(payload));
  await sdk.events.subscribe([...STATUS_TOPICS]);
  await runtime.registerBackgroundService();

  const clients = await buildConfiguredProviders(sdk, config, (message, sink) =>
    runtime.routeInbound(message, sink),
  );
  runtime.replaceProviders(clients);

  runtime.start();
  await sdk.notifications.toast(
    `Maestro Relay loaded; providers enabled: ${config.enabledProviders.join(', ') || '(none)'}.`,
  );
}

export function deactivate(): void {
  current?.stop();
  void current?.unregisterBackgroundService();
  current = undefined;
}
