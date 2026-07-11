/**
 * Plain-JS Slack Socket Mode client for the Maestro Relay plugin.
 *
 * The Node kernel uses `@slack/bolt` + `@slack/web-api`, neither of which can
 * load in the plugin sandbox (no `require`, no Node builtins). So this
 * reimplements exactly the slice Relay needs — receive channel messages, send
 * replies — directly over the brokered SDK. Socket Mode is the ONLY viable
 * Slack transport in the plugin: the sandbox is egress-only and cannot host the
 * public inbound webhook that Bolt's Events-API (`ExpressReceiver`) mode needs.
 *
 * Two secrets, both from private KV (never settings):
 *   - `appToken` (`xapp-…`, app-level) authorizes `apps.connections.open`.
 *   - `botToken` (`xoxb-…`, bot) authorizes `chat.postMessage`.
 *
 * Socket Mode protocol, grounded in Slack's documented flow:
 *   1. POST `apps.connections.open` (Bearer app token) over `net.fetch` → a
 *      short-lived `wss://wss-*.slack.com/...` gateway URL in the JSON body.
 *   2. `net.connect` that URL. The server speaks first with a `hello` frame;
 *      only then is the socket OPEN (a send-before-OPEN is rejected by the host).
 *   3. Event envelopes arrive as `{ envelope_id, type: 'events_api', payload }`.
 *      Each MUST be acked with `{ envelope_id }` — and acked *immediately*,
 *      before the agent turn runs, or Slack retries the delivery and eventually
 *      tears the socket down. Routing therefore happens asynchronously after ack.
 *   4. A `disconnect` frame (reason `warning`/`refresh_requested`) means Slack is
 *      about to close this socket; we open a fresh one (no session resume — each
 *      Socket Mode connection is independent, and Slack re-delivers unacked
 *      envelopes on the next connection).
 *
 * WebSocket-level ping/pong keep-alive is handled by the host's socket layer,
 * so — unlike Discord — no application heartbeat timer is needed. The only timer
 * is reconnect backoff, injected via {@link ReplyScheduler} for deterministic
 * tests; the sandbox only ever sees `setTimeout`/`clearTimeout`.
 */

import type { MaestroSdk, NetSocketEvent } from '../sdk';
import type { InboundMessage, ProviderClient, ReplySink, RouteOutcome } from '../entry';
import type { SlackConfig } from '../registry';
import type { ReplyScheduler } from '../reply';
import { DEFAULT_SCHEDULER } from '../reply';
import { splitMessage } from '../../core/splitMessage';

const WEB_API_BASE = 'https://slack.com/api';
/**
 * Slack `chat.postMessage` accepts up to 40000 chars, but a single message that
 * long is unwieldy; 3900 keeps each chunk comfortably within the safe range and
 * leaves headroom for `splitMessage` re-fencing.
 */
const MESSAGE_LIMIT = 3900;
const MAX_BACKOFF_MS = 30_000;

/**
 * `message` subtypes that are edits, deletions, or channel-system events rather
 * than fresh user text. Dropped. Notably absent — and therefore routed —
 * `file_share` and `thread_broadcast`, which carry genuine user messages.
 */
const IGNORED_SUBTYPES: Record<string, true> = {
  message_changed: true,
  message_deleted: true,
  message_replied: true,
  bot_message: true,
  tombstone: true,
  channel_join: true,
  channel_leave: true,
  channel_topic: true,
  channel_purpose: true,
  channel_name: true,
  channel_archive: true,
  channel_unarchive: true,
};

export interface SlackClientOptions {
  sdk: MaestroSdk;
  /** App-level token (`xapp-…`), for `apps.connections.open`. */
  appToken: string;
  /** Bot token (`xoxb-…`), for `chat.postMessage`. */
  botToken: string;
  config: SlackConfig;
  /** The runtime router — turns a normalized message into a dispatched turn. */
  route: (message: InboundMessage, sink: ReplySink) => Promise<RouteOutcome>;
  scheduler?: ReplyScheduler;
  /** Overridable for tests. */
  apiBase?: string;
  /** Reconnect backoff base in ms (default 1000). */
  reconnectBaseMs?: number;
}

/** A single decoded Socket Mode frame. Only the fields we read are typed. */
interface SocketFrame {
  type?: string;
  envelope_id?: string;
  payload?: Record<string, unknown>;
  reason?: string;
}

/** Extract the JSON body of a host `net.fetch` result (`{ status, headers, body }`). */
function parseJsonBody(result: unknown): Record<string, unknown> | undefined {
  const r = result as { body?: unknown } | undefined;
  const raw = r && typeof r.body === 'string' ? r.body : undefined;
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a Slack Socket Mode client. Returns a {@link ProviderClient} the runtime
 * registers; nothing connects until `connect()` (driven by `runtime.start()`).
 */
export function createSlackClient(options: SlackClientOptions): ProviderClient {
  const sdk = options.sdk;
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const apiBase = options.apiBase ?? WEB_API_BASE;
  const reconnectBaseMs = options.reconnectBaseMs ?? 1000;
  const allowedUsers = options.config.allowedUserIds ?? [];
  const teamId = options.config.teamId;

  let socketId: string | undefined;
  let reconnectTimer: number | undefined;
  let isConnected = false;
  let closed = false;
  let backoffAttempt = 0;
  // Dedupe: one @-mention fires BOTH a `message` and an `app_mention` event when
  // the app subscribes to both, and Slack re-delivers unacked envelopes on
  // reconnect. Track recent `channel:ts` keys, bounded to cap memory.
  const seenEventKeys = new Set<string>();
  const seenLimit = 200;

  function log(message: string): void {
    console.warn('[relay:slack] ' + message);
  }

  async function send(frame: unknown): Promise<void> {
    if (socketId === undefined) return;
    try {
      await sdk.net.send(socketId, JSON.stringify(frame));
    } catch (error) {
      log('socket send failed: ' + String(error));
    }
  }

  function makeSink(): ReplySink {
    return async (message, reply) => {
      const text = reply.text.trim();
      if (text.length === 0) return;
      for (const chunk of splitMessage(text, MESSAGE_LIMIT)) {
        await postMessage(message.channelId, chunk, message.threadId);
      }
    };
  }

  async function postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    const body: Record<string, unknown> = { channel, text };
    // Thread the reply under the user's message so the plugin mirrors Relay's
    // thread behavior instead of replying flat in the channel.
    if (threadTs !== undefined) body.thread_ts = threadTs;
    try {
      await sdk.net.fetch(apiBase + '/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + options.botToken,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      log('reply post failed: ' + String(error));
    }
  }

  function handleMessageEvent(payload: Record<string, unknown>, event: Record<string, unknown>): void {
    // Ignore bots (including our own reply echoes) and non-user update events.
    if (event.bot_id !== undefined) return;
    if (typeof event.subtype === 'string' && IGNORED_SUBTYPES[event.subtype] === true) return;

    const user = typeof event.user === 'string' ? event.user : '';
    if (user.length === 0) return;
    const channel = typeof event.channel === 'string' ? event.channel : '';
    if (channel.length === 0) return;

    // Team scope: when an operator pins a workspace, only that workspace routes.
    if (teamId && payload.team_id !== teamId) return;
    if (allowedUsers.length > 0 && !allowedUsers.includes(user)) return;

    const rawText = typeof event.text === 'string' ? event.text : '';
    // Strip Slack user-mention tokens (mirrors the kernel adapter): they surface
    // as opaque <@U…> to the agent, and Slack already pinged those users.
    const text = rawText.replace(/<@[^>]+>/g, '').trim();
    if (text.length === 0) return;

    const threadTs =
      typeof event.thread_ts === 'string'
        ? event.thread_ts
        : typeof event.ts === 'string'
          ? event.ts
          : undefined;

    const ts = typeof event.ts === 'string' ? event.ts : '';
    if (ts.length > 0) {
      const key = channel + ':' + ts;
      if (seenEventKeys.has(key)) return;
      seenEventKeys.add(key);
      if (seenEventKeys.size > seenLimit) {
        const oldest = seenEventKeys.values().next().value;
        if (oldest !== undefined) seenEventKeys.delete(oldest);
      }
    }

    const message: InboundMessage = {
      provider: 'slack',
      channelId: channel,
      userId: user,
      text,
      threadId: threadTs,
    };
    void options.route(message, makeSink()).catch((error) => {
      log('route failed: ' + String(error));
    });
  }

  function handleEnvelope(frame: SocketFrame): void {
    // Ack FIRST so Slack does not retry or close the socket while the agent
    // works — the turn can take far longer than Slack's ack window.
    if (typeof frame.envelope_id === 'string') void send({ envelope_id: frame.envelope_id });
    const payload = frame.payload;
    if (!payload) return;
    const event = payload.event as Record<string, unknown> | undefined;
    if (!event) return;
    // Route plain channel messages and direct @-mentions. Both fire for the
    // same @-mention when the app subscribes to both event types, so
    // handleMessageEvent dedupes on the message ts.
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    handleMessageEvent(payload, event);
  }

  function handleFrame(raw: string): void {
    let frame: SocketFrame;
    try {
      frame = JSON.parse(raw) as SocketFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'hello':
        isConnected = true;
        backoffAttempt = 0;
        break;
      case 'disconnect':
        // Slack is about to close this socket; open a fresh connection.
        isConnected = false;
        reconnect();
        break;
      case 'events_api':
        handleEnvelope(frame);
        break;
      default:
        // slash_commands / interactive / unknown envelopes: ack so Slack stops
        // retrying, then ignore (Relay only routes plain messages in v1).
        if (typeof frame.envelope_id === 'string') void send({ envelope_id: frame.envelope_id });
        break;
    }
  }

  function onSocketEvent(event: NetSocketEvent): void {
    if (event.type === 'message') {
      if (typeof event.data === 'string') handleFrame(event.data);
      return;
    }
    // 'close' or 'error': the host already released the socket. Reconnect.
    isConnected = false;
    reconnect();
  }

  function teardownSocket(): void {
    isConnected = false;
    const id = socketId;
    socketId = undefined;
    if (id !== undefined) {
      void sdk.net.close(id).catch(() => {
        // best-effort: the socket may already be gone on close/error paths
      });
    }
  }

  function reconnect(): void {
    teardownSocket();
    if (closed) return;
    if (reconnectTimer !== undefined) scheduler.clearTimer(reconnectTimer);
    const delay = Math.min(reconnectBaseMs * Math.pow(2, backoffAttempt), MAX_BACKOFF_MS);
    backoffAttempt += 1;
    reconnectTimer = scheduler.setTimer(() => {
      reconnectTimer = undefined;
      void openConnection();
    }, delay);
  }

  async function openConnection(): Promise<void> {
    if (closed) return;
    if (socketId !== undefined) return;

    let wssUrl: string;
    try {
      const result = await sdk.net.fetch(apiBase + '/apps.connections.open', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + options.appToken,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      const body = parseJsonBody(result);
      if (!body || body.ok !== true || typeof body.url !== 'string') {
        log('apps.connections.open rejected: ' + JSON.stringify(body?.error ?? body ?? null));
        if (!closed) reconnect();
        return;
      }
      wssUrl = body.url;
    } catch (error) {
      log('apps.connections.open failed: ' + String(error));
      if (!closed) reconnect();
      return;
    }

    try {
      const connectResult = await sdk.net.connect(wssUrl);
      socketId = connectResult.socketId;
      // Inbound frames arrive as events on this per-socket topic (pushed by the
      // host net sink; no `events.subscribe` needed). A new socketId per connect
      // means stale handlers for closed sockets never fire again.
      sdk.events.on('net.connect:' + connectResult.socketId, (payload) => {
        onSocketEvent(payload as NetSocketEvent);
      });
    } catch (error) {
      log('socket connect failed: ' + String(error));
      isConnected = false;
      if (!closed) reconnect();
    }
  }

  return {
    name: 'slack',
    async connect(): Promise<void> {
      closed = false;
      await openConnection();
    },
    disconnect(): void {
      closed = true;
      if (reconnectTimer !== undefined) {
        scheduler.clearTimer(reconnectTimer);
        reconnectTimer = undefined;
      }
      teardownSocket();
    },
    connected(): boolean {
      return isConnected;
    },
  };
}
