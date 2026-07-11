/**
 * Plain-JS Discord Gateway client for the Maestro Relay plugin.
 *
 * The Node kernel uses `discord.js`, which cannot load in the plugin sandbox
 * (no `require`, no Node builtins). So this reimplements exactly the slice Relay
 * needs — receive channel messages, send replies — directly over the brokered
 * SDK: `net.connect` holds the Gateway websocket, `net.fetch` posts replies to
 * the Discord REST API. No `discord.js`, no `Buffer`, no `setInterval`; every
 * timer goes through an injectable {@link ReplyScheduler} so tests are
 * deterministic and the sandbox only ever sees `setTimeout`/`clearTimeout`.
 *
 * Gateway protocol (v10, JSON encoding), grounded in Discord's documented
 * opcode flow:
 *   - The server speaks first with op 10 HELLO carrying `heartbeat_interval`.
 *     Only after that first frame is the socket OPEN, so IDENTIFY/heartbeat are
 *     sent then (never before — the host rejects a send-before-OPEN).
 *   - Heartbeat (op 1, `d = lastSeq`) fires on a recursive timer; the server
 *     ACKs with op 11. A missed ACK is treated as a zombied connection and
 *     forces a reconnect.
 *   - op 0 DISPATCH carries `t` (event name): READY (session id + bot user id +
 *     resume url), RESUMED, and MESSAGE_CREATE (the payload Relay routes).
 *   - op 7 RECONNECT and op 9 INVALID_SESSION drive reconnect/resume.
 *
 * Reconnect resumes (op 6) when a session is still valid, otherwise re-identifies
 * with exponential backoff. `disconnect()` stops all timers and closes the
 * socket so plugin deactivate leaves nothing running.
 */

import type { MaestroSdk, NetSocketEvent } from '../sdk';
import type { InboundMessage, ProviderClient, ReplySink, RouteOutcome } from '../entry';
import type { DiscordConfig } from '../registry';
import type { ReplyScheduler } from '../reply';
import { DEFAULT_SCHEDULER } from '../reply';
import { splitMessage } from '../../core/splitMessage';

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const API_BASE = 'https://discord.com/api/v10';
/** Discord's hard message cap is 2000; 1990 leaves headroom for re-fencing. */
const MESSAGE_LIMIT = 1990;

/**
 * Gateway intents Relay needs: GUILDS (guild bookkeeping), GUILD_MESSAGES +
 * DIRECT_MESSAGES (message events in servers and DMs), MESSAGE_CONTENT (the
 * privileged intent that fills in `content`). Value: 1 + 512 + 4096 + 32768.
 */
const DEFAULT_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

/** Gateway opcodes used here (Discord Gateway v10). */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

const MAX_BACKOFF_MS = 30_000;

export interface DiscordClientOptions {
  sdk: MaestroSdk;
  /** Bot token (read from the plugin's private KV, never settings). */
  token: string;
  config: DiscordConfig;
  /** The runtime router — turns a normalized message into a dispatched turn. */
  route: (message: InboundMessage, sink: ReplySink) => Promise<RouteOutcome>;
  scheduler?: ReplyScheduler;
  /** Overridable for tests. */
  gatewayUrl?: string;
  apiBase?: string;
  intents?: number;
  /** Reconnect backoff base in ms (default 1000). */
  reconnectBaseMs?: number;
}

/** A single decoded Gateway frame. Only the fields we read are typed. */
interface GatewayFrame {
  op: number;
  s?: number | null;
  t?: string | null;
  d?: unknown;
}

/**
 * Build a Discord Gateway client. Returns a {@link ProviderClient} the runtime
 * registers; nothing connects until `connect()` (driven by `runtime.start()`).
 */
export function createDiscordClient(options: DiscordClientOptions): ProviderClient {
  const sdk = options.sdk;
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const gatewayUrl = options.gatewayUrl ?? GATEWAY_URL;
  const apiBase = options.apiBase ?? API_BASE;
  const intents = options.intents ?? DEFAULT_INTENTS;
  const reconnectBaseMs = options.reconnectBaseMs ?? 1000;
  const allowedUsers = options.config.allowedUserIds ?? [];
  const guildId = options.config.guildId;

  let socketId: string | undefined;
  let heartbeatIntervalMs = 0;
  let heartbeatTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let awaitingAck = false;
  let lastSeq: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let botUserId: string | undefined;
  let isConnected = false;
  let closed = false;
  let wantResume = false;
  let backoffAttempt = 0;

  function log(message: string): void {
    console.warn('[relay:discord] ' + message);
  }

  async function send(frame: unknown): Promise<void> {
    if (socketId === undefined) return;
    try {
      await sdk.net.send(socketId, JSON.stringify(frame));
    } catch (error) {
      log('gateway send failed: ' + String(error));
    }
  }

  function sendIdentify(): void {
    void send({
      op: OP.IDENTIFY,
      d: {
        token: options.token,
        intents,
        properties: { os: 'linux', browser: 'maestro-relay', device: 'maestro-relay' },
      },
    });
  }

  function sendResume(): void {
    void send({
      op: OP.RESUME,
      d: { token: options.token, session_id: sessionId, seq: lastSeq },
    });
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer !== undefined) {
      scheduler.clearTimer(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function beat(): void {
    // A pending un-ACKed heartbeat means the connection is a zombie: drop it and
    // reconnect (resuming) rather than sending into a dead socket.
    if (awaitingAck) {
      reconnect(true);
      return;
    }
    awaitingAck = true;
    void send({ op: OP.HEARTBEAT, d: lastSeq });
  }

  function scheduleHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = scheduler.setTimer(() => {
      beat();
      // Re-arm only if the beat did not tear the connection down.
      if (socketId !== undefined) scheduleHeartbeat();
    }, heartbeatIntervalMs);
  }

  function makeSink(): ReplySink {
    return async (message, reply) => {
      const text = reply.text.trim();
      if (text.length === 0) return;
      for (const chunk of splitMessage(text, MESSAGE_LIMIT)) {
        await postMessage(message.channelId, chunk);
      }
    };
  }

  async function postMessage(channelId: string, content: string): Promise<void> {
    try {
      await sdk.net.fetch(apiBase + '/channels/' + channelId + '/messages', {
        method: 'POST',
        headers: {
          Authorization: 'Bot ' + options.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      });
    } catch (error) {
      log('reply post failed: ' + String(error));
    }
  }

  function handleMessageCreate(payload: Record<string, unknown>): void {
    const author = payload.author as Record<string, unknown> | undefined;
    if (!author || typeof author.id !== 'string') return;
    // Ignore other bots and our own echoes.
    if (author.bot === true) return;
    if (botUserId !== undefined && author.id === botUserId) return;

    const content = typeof payload.content === 'string' ? payload.content : '';
    if (content.trim().length === 0) return;

    // Guild scope: when an operator pins a guild id, only that guild routes
    // (DMs, which carry no guild_id, are excluded). Empty = every guild + DMs.
    if (guildId && payload.guild_id !== guildId) return;
    if (allowedUsers.length > 0 && !allowedUsers.includes(author.id)) return;

    const channelId = payload.channel_id;
    if (typeof channelId !== 'string') return;

    const message: InboundMessage = {
      provider: 'discord',
      channelId,
      userId: author.id,
      text: content,
    };
    void options.route(message, makeSink()).catch((error) => {
      log('route failed: ' + String(error));
    });
  }

  function handleDispatch(eventName: string | null | undefined, data: unknown): void {
    const payload = (data ?? {}) as Record<string, unknown>;
    if (eventName === 'READY') {
      if (typeof payload.session_id === 'string') sessionId = payload.session_id;
      if (typeof payload.resume_gateway_url === 'string') resumeUrl = payload.resume_gateway_url;
      const user = payload.user as Record<string, unknown> | undefined;
      if (user && typeof user.id === 'string') botUserId = user.id;
      isConnected = true;
      backoffAttempt = 0;
    } else if (eventName === 'RESUMED') {
      isConnected = true;
      backoffAttempt = 0;
    } else if (eventName === 'MESSAGE_CREATE') {
      handleMessageCreate(payload);
    }
  }

  function handleFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }
    if (typeof frame.s === 'number') lastSeq = frame.s;

    switch (frame.op) {
      case OP.HELLO: {
        const d = (frame.d ?? {}) as { heartbeat_interval?: unknown };
        heartbeatIntervalMs = typeof d.heartbeat_interval === 'number' ? d.heartbeat_interval : 45000;
        awaitingAck = false;
        scheduleHeartbeat();
        if (wantResume && sessionId !== undefined) sendResume();
        else sendIdentify();
        break;
      }
      case OP.DISPATCH:
        handleDispatch(frame.t, frame.d);
        break;
      case OP.HEARTBEAT:
        // Server asked for an immediate heartbeat.
        awaitingAck = false;
        beat();
        break;
      case OP.RECONNECT:
        reconnect(true);
        break;
      case OP.INVALID_SESSION:
        // `d` is a boolean: whether the session is resumable.
        reconnect(frame.d === true);
        break;
      case OP.HEARTBEAT_ACK:
        awaitingAck = false;
        break;
      default:
        break;
    }
  }

  function onSocketEvent(event: NetSocketEvent): void {
    if (event.type === 'message') {
      if (typeof event.data === 'string') handleFrame(event.data);
      return;
    }
    // 'close' or 'error': the host already released the socket. Attempt to
    // resume the session on the next connection.
    isConnected = false;
    reconnect(true);
  }

  function teardownSocket(): void {
    clearHeartbeat();
    awaitingAck = false;
    isConnected = false;
    const id = socketId;
    socketId = undefined;
    if (id !== undefined) {
      void sdk.net.close(id).catch(() => {
        // best-effort: the socket may already be gone on close/error paths
      });
    }
  }

  function reconnect(resume: boolean): void {
    teardownSocket();
    if (closed) return;
    if (!resume) {
      sessionId = undefined;
      resumeUrl = undefined;
      lastSeq = null;
    }
    wantResume = resume && sessionId !== undefined;
    if (reconnectTimer !== undefined) scheduler.clearTimer(reconnectTimer);
    const delay = Math.min(reconnectBaseMs * Math.pow(2, backoffAttempt), MAX_BACKOFF_MS);
    backoffAttempt += 1;
    reconnectTimer = scheduler.setTimer(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  }

  async function connect(): Promise<void> {
    if (closed) return;
    if (socketId !== undefined) return;
    const url = wantResume && resumeUrl !== undefined ? resumeUrl + '/?v=10&encoding=json' : gatewayUrl;
    try {
      const result = await sdk.net.connect(url);
      socketId = result.socketId;
      // Inbound frames arrive as events on this per-socket topic (pushed by the
      // host net sink; no `events.subscribe` needed). A new socketId per connect
      // means stale handlers for closed sockets never fire again.
      sdk.events.on('net.connect:' + result.socketId, (payload) => {
        onSocketEvent(payload as NetSocketEvent);
      });
    } catch (error) {
      log('gateway connect failed: ' + String(error));
      isConnected = false;
      // Retry with backoff unless we were told to stop.
      if (!closed) reconnect(false);
    }
  }

  return {
    name: 'discord',
    async connect(): Promise<void> {
      closed = false;
      await connect();
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
