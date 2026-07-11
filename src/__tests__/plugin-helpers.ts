/**
 * Shared test doubles for the Maestro Relay plugin: a fake brokered SDK and a
 * manual scheduler so the reply loop can be driven deterministically without any
 * real wall-clock timers.
 */

import type { MaestroSdk, TranscriptEntry } from '../plugin/sdk';
import type { ReplyScheduler } from '../plugin/reply';

/** Flush the microtask queue so awaited fake-SDK promises settle. */
export async function flush(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * A `ReplyScheduler` whose clock and timers the test drives by hand. Timers never
 * fire on their own — the test calls {@link fire} — so nothing depends on real time.
 */
export class ManualScheduler implements ReplyScheduler {
  time = 0;
  private pending = new Map<number, () => void>();
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimer(callback: () => void, _ms: number): number {
    const id = this.nextId++;
    this.pending.set(id, callback);
    return id;
  }

  clearTimer(id: number): void {
    this.pending.delete(id);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Fire the earliest pending timer and flush microtasks. False if none pending. */
  async fire(): Promise<boolean> {
    const first = this.pending.entries().next().value;
    if (!first) return false;
    const [id, callback] = first;
    this.pending.delete(id);
    callback();
    await flush();
    return true;
  }
}

export interface ReadCall {
  sessionId: string;
  fields: string[];
  since: number | undefined;
}

export interface FakeSdkCalls {
  dispatched: Array<{ agentId: string; prompt: string }>;
  reads: ReadCall[];
  commands: Map<string, (args?: unknown) => unknown>;
  toasts: string[];
  subscriptions: string[][];
  eventHandlers: Map<string, Array<(payload: unknown) => void>>;
  storage: Map<string, string>;
  connects: Array<{ url: string; opts: unknown; socketId: string }>;
  sends: Array<{ socketId: string; data: string }>;
  closes: Array<{ socketId: string; opts: unknown }>;
  fetches: Array<{ url: string; init: unknown }>;
  backgroundRegistrations: Array<{ id?: string; name?: string }>;
  backgroundUnregisters: string[];
  emit(topic: string, payload: unknown): void;
  /** Push a `net.connect:<socketId>` socket event to its registered handlers. */
  emitSocket(socketId: string, event: Record<string, unknown>): void;
}

export interface FakeSdkOptions {
  pluginId?: string;
  dispatchSessionId?: string;
  /** Rows returned per `transcripts.read`, indexed by call number (0-based). */
  read?: (call: ReadCall, index: number) => TranscriptEntry[];
  /** Seed non-secret settings (bare keys). */
  settings?: Record<string, string>;
  /** Seed private KV storage. */
  storage?: Record<string, string>;
  /** Response for each `net.fetch`, indexed by call number (0-based). Returns
   *  the host-shaped `{ status, statusText, headers, body }`; `body` is a string. */
  fetch?: (url: string, init: unknown, index: number) => unknown;
}

/** Build a fake `MaestroSdk` plus a `calls` record for assertions. */
export function createFakeSdk(options: FakeSdkOptions = {}): {
  sdk: MaestroSdk;
  calls: FakeSdkCalls;
} {
  const pluginId = options.pluginId ?? 'sh.maestro.relay';
  const sessionId = options.dispatchSessionId ?? 'session-1';
  const settings = new Map<string, string>(Object.entries(options.settings ?? {}));
  const storage = new Map<string, string>(Object.entries(options.storage ?? {}));
  const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();

  const calls: FakeSdkCalls = {
    dispatched: [],
    reads: [],
    commands: new Map(),
    toasts: [],
    subscriptions: [],
    eventHandlers,
    storage,
    connects: [],
    sends: [],
    closes: [],
    fetches: [],
    backgroundRegistrations: [],
    backgroundUnregisters: [],
    emit(topic, payload): void {
      for (const handler of eventHandlers.get(topic) ?? []) handler(payload);
    },
    emitSocket(socketId, event): void {
      const topic = `net.connect:${socketId}`;
      const payload = { socketId, ...event };
      for (const handler of eventHandlers.get(topic) ?? []) handler(payload);
    },
  };

  let socketCounter = 0;

  let readIndex = 0;
  let fetchIndex = 0;

  const sdk: MaestroSdk = {
    pluginId,
    agents: {
      list: async () => [],
      get: async () => null,
      dispatch: async (agentId, prompt) => {
        calls.dispatched.push({ agentId, prompt });
        return { dispatched: true, sessionId };
      },
    },
    transcripts: {
      read: async (params) => {
        const call: ReadCall = {
          sessionId: params.sessionId,
          fields: params.fields.slice(),
          since: params.since,
        };
        calls.reads.push(call);
        const rows = options.read ? options.read(call, readIndex) : [];
        readIndex++;
        return rows;
      },
    },
    net: {
      fetch: async (url, init) => {
        calls.fetches.push({ url, init });
        const result = options.fetch
          ? options.fetch(url, init, fetchIndex)
          : { status: 200, statusText: 'OK', headers: {}, body: '' };
        fetchIndex++;
        return result;
      },
      connect: async (url, opts) => {
        socketCounter += 1;
        const socketId = `sock-${socketCounter}`;
        calls.connects.push({ url, opts, socketId });
        return { socketId };
      },
      send: async (socketId, data) => {
        calls.sends.push({ socketId, data });
        return { ok: true };
      },
      close: async (socketId, opts) => {
        calls.closes.push({ socketId, opts });
        return { ok: true };
      },
    },
    storage: {
      get: async (key) => (storage.has(key) ? storage.get(key)! : null),
      set: async (key, value) => {
        storage.set(key, value);
        return { ok: true };
      },
      delete: async (key) => {
        storage.delete(key);
        return { ok: true };
      },
      keys: async () => [...storage.keys()],
    },
    settings: {
      get: async (key) => (settings.has(key) ? settings.get(key)! : null),
      set: async (key, value) => {
        settings.set(key, String(value));
        return { ok: true };
      },
    },
    events: {
      on: (topic, handler) => {
        const list = eventHandlers.get(topic) ?? [];
        list.push(handler as (payload: unknown) => void);
        eventHandlers.set(topic, list);
      },
      subscribe: async (topics) => {
        calls.subscriptions.push(topics.slice());
        return { ok: true };
      },
      unsubscribe: async () => ({ ok: true }),
    },
    commands: {
      register: (commandId, handler) => {
        calls.commands.set(commandId, handler);
      },
    },
    notifications: {
      toast: async (message) => {
        calls.toasts.push(message);
        return { ok: true };
      },
    },
    background: {
      register: async (service) => {
        const s = (service ?? {}) as { id?: unknown; name?: unknown };
        const id = typeof s.id === 'string' ? s.id : undefined;
        const name = typeof s.name === 'string' ? s.name : undefined;
        calls.backgroundRegistrations.push({ id, name });
        return { serviceId: id ?? `bg_${calls.backgroundRegistrations.length}` };
      },
      unregister: async (serviceId) => {
        calls.backgroundUnregisters.push(serviceId);
        return { ok: true };
      },
      list: async () => ({
        pluginId,
        state: 'running',
        restarts: 0,
        services: calls.backgroundRegistrations.map((r, i) => ({
          id: r.id ?? `bg_${i + 1}`,
          name: r.name,
          registeredAt: 0,
        })),
      }),
    },
  };

  return { sdk, calls };
}
