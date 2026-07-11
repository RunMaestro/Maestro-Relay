/**
 * Type surface for the Maestro plugin SDK — the `maestro` global that the
 * sandbox injects and hands to `activate(sdk)`.
 *
 * Grounded in the Maestro source at HOST_API 1.12.0:
 *   - `src/main/plugins/plugin-sandbox-entry.ts` (`buildSdk`, the frozen object)
 *   - `src/shared/plugins/rpc-protocol.ts` (`HOST_API` method -> capability table)
 *   - `src/main/plugins/plugin-host-handlers.ts` (per-method behaviour)
 *
 * Only the members the relay plugin uses in v1 are typed precisely. Host
 * namespaces the plugin does not touch (tabs, sessions, history, power, fs,
 * decisions, shell, tools, ui host views) are intentionally omitted so the
 * contract stays small; add them when a feature needs them.
 *
 * IMPORTANT sandbox facts encoded here:
 *   - Available globals: `maestro`, `module`, `exports`, `console`, `setTimeout`,
 *     `clearTimeout`, `Promise` plus JS intrinsics. NO `require`, `process`,
 *     `Buffer`, `setInterval`, `TextEncoder`, `fetch`.
 *   - `storage` values are strings only (JSON-encode structured data).
 *   - `settings.set` may only write keys under `plugins.<pluginId>.*`; the relay
 *     plugin therefore treats settings as read-only and keeps mutable state in
 *     `storage`.
 */

/** What `agents.dispatch` resolves to (`dispatchPromptToSession` in host index.ts). */
export interface DispatchResult {
  dispatched: true;
  sessionId: string;
}

/** An agent Maestro can dispatch to (subset of the host's agent record). */
export interface AgentSummary {
  id: string;
  name?: string;
  [k: string]: unknown;
}

/**
 * A projected transcript entry. Only the fields declared in the host's
 * `TRANSCRIPT_PROJECTABLE_FIELDS` may be requested, and each is present only
 * when the underlying history entry actually carries it.
 */
export interface TranscriptEntry {
  id?: string;
  type?: string;
  timestamp?: number;
  summary?: string;
  fullResponse?: string;
  success?: boolean;
  sessionName?: string;
  agentSessionId?: string;
  [k: string]: unknown;
}

export interface TranscriptReadParams {
  sessionId: string;
  /** Must be a subset of TRANSCRIPT_PROJECTABLE_FIELDS; at least one required. */
  fields: string[];
  /** Inclusive lower bound on `timestamp` (`timestamp >= since`). */
  since?: number;
  limit?: number;
}

/** Options for opening a persistent outbound websocket (`net.connect`). */
export interface NetConnectOpts {
  protocols?: string[];
  headers?: Record<string, string>;
}

/** `net.connect` resolves as soon as the socket is tracked. There is NO `open`
 * event: inbound frames (and `close`/`error`) arrive as events on the topic
 * `net.connect:<socketId>`, and a `send` before the socket is OPEN is rejected.
 * Both target protocols speak first (Discord Gateway HELLO, Slack `hello`), so a
 * client waits for the server's first `message` frame before sending. */
export interface NetConnectResult {
  socketId: string;
}

/** Payload shape of a `net.connect:<socketId>` event (host sink in index.ts). */
export interface NetSocketEvent {
  socketId: string;
  type: 'message' | 'close' | 'error';
  /** Present for `type: 'message'` — the frame decoded as UTF-8. */
  data?: string;
  binary?: boolean;
  /** Present for `type: 'close'`. */
  code?: number;
  reason?: string;
  /** Present for `type: 'error'` — a message string only, never a stack. */
  message?: string;
}

/** Metadata delivered with every event (`deliverEvent` in the sandbox). */
export interface EventMeta {
  topic: string;
  at: string;
}

/** `agent.completed` payload (metadata only; no reply text). */
export interface AgentCompletedEvent {
  sessionId: string;
  agentId?: string;
  status: string;
  [k: string]: unknown;
}

export interface MaestroSdk {
  readonly pluginId: string;

  readonly agents: {
    list(): Promise<AgentSummary[]>;
    get(agentId: string): Promise<AgentSummary | null>;
    /** Deliver a prompt to the bound agent's session. Allowlist-scoped:
     * the grant must name this exact `agentId`. Returns only dispatch metadata
     * — the reply is read back via `transcripts.read`. */
    dispatch(agentId: string, prompt: string): Promise<DispatchResult>;
  };

  readonly transcripts: {
    read(params: TranscriptReadParams): Promise<TranscriptEntry[]>;
  };

  readonly net: {
    fetch(url: string, init?: unknown): Promise<unknown>;
    connect(url: string, opts?: NetConnectOpts): Promise<NetConnectResult>;
    send(socketId: string, data: string): Promise<{ ok: true }>;
    close(socketId: string, opts?: { code?: number; reason?: string }): Promise<{ ok: true }>;
  };

  /** Per-plugin key/value store (string values). Isolated by plugin id. */
  readonly storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    keys(): Promise<string[]>;
  };

  /** Non-secret configuration. Read via bare or `plugins.<id>.*` keys; writes
   * are confined to `plugins.<id>.*`. */
  readonly settings: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
  };

  readonly events: {
    /** Register a local handler for a topic (does not subscribe by itself). */
    on(topic: string, handler: (payload: unknown, meta: EventMeta) => void): void;
    subscribe(topics: string[]): Promise<unknown>;
    unsubscribe(topics?: string[]): Promise<unknown>;
  };

  readonly commands: {
    register(commandId: string, handler: (args?: unknown) => unknown): void;
  };

  readonly notifications: {
    toast(message: string, opts?: unknown): Promise<unknown>;
  };

  readonly background: {
    register(service: unknown): Promise<unknown>;
    unregister(serviceId: string): Promise<unknown>;
    list(): Promise<unknown>;
  };
}
