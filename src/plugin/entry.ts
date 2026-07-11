/**
 * Maestro Relay plugin entry point (bundled by esbuild to `plugin/entry.js`).
 *
 * Runs inside the Maestro plugin sandbox. The host calls `activate(sdk)` on load
 * and `deactivate()` on unload. This module owns the plugin lifecycle, the
 * contributed commands, config/state wiring, and the message router that turns
 * an inbound chat message into a dispatched agent turn and a reply.
 *
 * v1 scope: lifecycle + config + binding registry + the dispatch/reply router
 * are implemented and tested here. The Discord Gateway and Slack Socket-Mode
 * clients that FEED `routeInbound` (and consume its reply via a {@link ReplySink})
 * are the next build steps — they open `net.connect` sockets and normalize
 * platform events into {@link InboundMessage}. Until they land, `status()`
 * reports zero connected providers rather than pretending a bridge is live.
 *
 * Sandbox-safe: imports only sibling plugin modules; no Node builtins, no
 * `require`, and only `setTimeout`/`clearTimeout`/`Promise`/`console` globals.
 */

import type { MaestroSdk } from './sdk';
import type { ReplyHandle, ReplyResult, ReplyScheduler } from './reply';
import { collectAgentReply } from './reply';
import type { RelayConfig } from './registry';
import { conversationKey, getBinding, loadConfig } from './registry';

/** Contributed command ids (must match `plugin.json` `contributes.commands`). */
export const COMMAND_IDS = [
  'relay-start',
  'relay-stop',
  'relay-status',
  'relay-reload-config',
] as const;

export type RelayCommandId = (typeof COMMAND_IDS)[number];

/** An inbound chat message, normalized across providers by the gateway clients. */
export interface InboundMessage {
  provider: string;
  channelId: string;
  userId: string;
  text: string;
}

/** Posts a completed agent reply back to the originating channel. A provider
 * supplies its own (REST post over `net.fetch`); tests inject one directly. */
export type ReplySink = (message: InboundMessage, reply: ReplyResult) => void | Promise<void>;

export type RouteStatus = 'dispatched' | 'unbound' | 'empty';

export interface RouteOutcome {
  status: RouteStatus;
  agentId?: string;
  reply?: ReplyResult;
}

export interface RelayStatus {
  running: boolean;
  enabledProviders: string[];
  connectedProviders: string[];
  activeReplies: number;
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
  let running = false;

  const runtime: RelayRuntime = {
    config,
    start(): void {
      running = true;
    },
    stop(): void {
      running = false;
      for (const handle of activeReplies.values()) handle.cancel();
      activeReplies.clear();
    },
    status(): RelayStatus {
      // No gateway provider is wired yet, so nothing is "connected". This stays
      // honest until the Discord/Slack clients land and register themselves.
      return {
        running,
        enabledProviders: runtime.config.enabledProviders.slice(),
        connectedProviders: [],
        activeReplies: activeReplies.size,
      };
    },
    async reloadConfig(): Promise<RelayConfig> {
      runtime.config = await loadConfig(sdk);
      return runtime.config;
    },
    async handleCommand(commandId: string, _args?: unknown): Promise<string> {
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
          return `Relay ${s.running ? 'running' : 'stopped'} | enabled: ${s.enabledProviders.join(', ') || '(none)'} | connected: ${s.connectedProviders.join(', ') || '(none)'} | active replies: ${s.activeReplies}`;
        }
        case 'relay-reload-config': {
          const next = await runtime.reloadConfig();
          const message = `Configuration reloaded; providers enabled: ${next.enabledProviders.join(', ') || '(none)'}.`;
          await sdk.notifications.toast(message);
          return message;
        }
        default:
          throw new Error(`unknown relay command "${commandId}"`);
      }
    },
    async routeInbound(message: InboundMessage, sink: ReplySink): Promise<RouteOutcome> {
      if (message.text.trim().length === 0) return { status: 'empty' };
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
      const record = payload as { sessionId?: unknown } | null;
      const sessionId = record && typeof record.sessionId === 'string' ? record.sessionId : '';
      if (sessionId.length === 0) return;
      const handle = activeReplies.get(sessionId);
      if (handle) handle.markComplete();
    },
  };

  return runtime;
}

let current: RelayRuntime | undefined;

export async function activate(sdk: MaestroSdk): Promise<void> {
  const config = await loadConfig(sdk);
  const runtime = createRuntime(sdk, config);
  current = runtime;

  for (const id of COMMAND_IDS) {
    sdk.commands.register(id, (args) => runtime.handleCommand(id, args));
  }

  sdk.events.on('agent.completed', (payload) => runtime.onAgentCompleted(payload));
  await sdk.events.subscribe(['agent.completed']);

  runtime.start();
  await sdk.notifications.toast(
    `Maestro Relay loaded; providers enabled: ${config.enabledProviders.join(', ') || '(none)'}.`,
  );
}

export function deactivate(): void {
  current?.stop();
  current = undefined;
}
