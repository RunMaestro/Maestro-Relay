/**
 * The relay reply path: dispatch a chat message to a Maestro agent, then read
 * the agent's reply back so it can be posted into the chat channel.
 *
 * This is the design-critical core of the plugin. `agents.dispatch` returns only
 * `{ dispatched, sessionId }` — it never carries the reply text, and the event
 * bus is metadata-only. So the reply is obtained by polling `transcripts.read`
 * for the dispatched session and diffing new entries.
 *
 * Grounded in Maestro host 1.12.0 (`plugin-host-handlers.ts`):
 *   - `transcripts.read` filters with `timestamp >= since` (INCLUSIVE). Setting
 *     `since` to the last-seen timestamp therefore re-returns the boundary row
 *     every poll, so we dedupe by entry `id` (falling back to a `type@timestamp`
 *     composite when an entry has no id).
 *   - Only `TRANSCRIPT_PROJECTABLE_FIELDS` may be requested; the reply text lives
 *     in `fullResponse` (with `summary` as a fallback).
 *   - Completion is not directly observable. We finish on the `agent.completed`
 *     event for this session (via {@link ReplyHandle.markComplete}), or on an
 *     idle-grace fallback (no new content for a while after the first chunk), or
 *     a hard timeout.
 *
 * Sandbox constraints honoured: only `setTimeout`/`clearTimeout`, `Promise`,
 * `Map`/`Set`, `JSON` and `console` are used. No `setInterval`, no Node builtins.
 * The timer/clock is injected via {@link ReplyScheduler} so callers (and tests)
 * can drive polling deterministically; production uses {@link DEFAULT_SCHEDULER}.
 */

import type { MaestroSdk, TranscriptEntry } from './sdk';

/** Transcript fields requested on every poll. `id` is required for dedupe. */
export const REPLY_FIELDS: readonly string[] = [
  'id',
  'type',
  'timestamp',
  'fullResponse',
  'summary',
];

/** Clock + one-shot timer the reply loop uses. Injectable for deterministic tests. */
export interface ReplyScheduler {
  now(): number;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
}

/** Production scheduler: real wall clock and the sandbox's `setTimeout`. */
export const DEFAULT_SCHEDULER: ReplyScheduler = {
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
};

export interface CollectReplyOptions {
  agentId: string;
  prompt: string;
  /** Milliseconds between transcript polls. Default 1500. */
  pollIntervalMs?: number;
  /** Finish this long after the last new chunk once at least one arrived. Default 5000. */
  idleGraceMs?: number;
  /** Hard cap on the whole collect. Default 180000. */
  timeoutMs?: number;
  /** Override the requested transcript fields (defaults to {@link REPLY_FIELDS}). */
  fields?: readonly string[];
}

/** Optional side-channels the caller wires up. */
export interface CollectReplyHooks {
  /** Called once the dispatch resolves and the session id is known. The relay
   * entry uses this to register the handle so `agent.completed` can find it. */
  onSession?: (sessionId: string) => void;
  /** Called for each new reply chunk as it is observed (for streaming posts). */
  onChunk?: (text: string, entry: TranscriptEntry) => void;
}

/** Why the collect finished. */
export type ReplyFinishReason = 'event' | 'idle' | 'timeout' | 'cancel';

export interface ReplyResult {
  sessionId: string;
  /** All reply chunks concatenated. */
  text: string;
  chunks: string[];
  reason: ReplyFinishReason;
}

/** A running reply collection. `promise` settles when the reply is complete. */
export interface ReplyHandle {
  readonly promise: Promise<ReplyResult>;
  /** Signal that the agent reached a terminal state (from `agent.completed`).
   * Triggers a final transcript drain and resolves. */
  markComplete(): void;
  /** Abandon collection (e.g. on plugin deactivate); resolves with what we have. */
  cancel(): void;
}

/**
 * Dispatch `prompt` to `agentId` and collect the agent's reply. Returns a handle
 * immediately; `handle.promise` resolves with the assembled reply text. Rejects
 * only if the dispatch itself fails.
 */
export function collectAgentReply(
  sdk: MaestroSdk,
  options: CollectReplyOptions,
  hooks: CollectReplyHooks = {},
  scheduler: ReplyScheduler = DEFAULT_SCHEDULER,
): ReplyHandle {
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const idleGraceMs = options.idleGraceMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 180000;
  const fields = (options.fields ?? REPLY_FIELDS).slice();

  const seen = new Set<string>();
  const chunks: string[] = [];
  let since = 0;
  const startedAt = scheduler.now();
  let lastActivityAt = startedAt;
  let completeRequested = false;
  let cancelled = false;
  let finished = false;
  let timer: number | undefined;
  let sessionId = '';

  const { promise, resolve, reject } = Promise.withResolvers<ReplyResult>();

  function clearPending(): void {
    if (timer !== undefined) {
      scheduler.clearTimer(timer);
      timer = undefined;
    }
  }

  function finish(reason: ReplyFinishReason): void {
    if (finished) return;
    finished = true;
    clearPending();
    resolve({ sessionId, text: chunks.join(''), chunks: chunks.slice(), reason });
  }

  function ingest(entry: TranscriptEntry): boolean {
    const key =
      typeof entry.id === 'string' && entry.id.length > 0
        ? entry.id
        : `${entry.type ?? ''}@${entry.timestamp ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (typeof entry.timestamp === 'number' && entry.timestamp > since) {
      since = entry.timestamp;
    }
    const text =
      typeof entry.fullResponse === 'string' && entry.fullResponse.length > 0
        ? entry.fullResponse
        : typeof entry.summary === 'string' && entry.summary.length > 0
          ? entry.summary
          : '';
    if (text.length === 0) return false;
    chunks.push(text);
    if (hooks.onChunk) hooks.onChunk(text, entry);
    return true;
  }

  async function drain(): Promise<boolean> {
    const rows = await sdk.transcripts.read({ sessionId, fields: fields.slice(), since });
    let gotNew = false;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (ingest(row)) gotNew = true;
      }
    }
    return gotNew;
  }

  async function tick(): Promise<void> {
    if (finished) return;
    try {
      if (await drain()) lastActivityAt = scheduler.now();
    } catch (error) {
      // A transient host error must not abort the collect: keep polling until
      // the deadline. (net egress hiccups, momentary rate caps, etc.)
      console.warn('transcripts.read failed: ' + String(error));
    }
    if (finished) return;
    const now = scheduler.now();
    if (completeRequested) {
      finish('event');
      return;
    }
    if (now - startedAt >= timeoutMs) {
      finish('timeout');
      return;
    }
    if (chunks.length > 0 && now - lastActivityAt >= idleGraceMs) {
      finish('idle');
      return;
    }
    timer = scheduler.setTimer(() => {
      void tick();
    }, pollIntervalMs);
  }

  void (async () => {
    try {
      const dispatch = await sdk.agents.dispatch(options.agentId, options.prompt);
      sessionId = dispatch.sessionId;
      if (hooks.onSession) hooks.onSession(sessionId);
      if (cancelled) {
        finish('cancel');
        return;
      }
      void tick();
    } catch (error) {
      if (!finished) {
        finished = true;
        clearPending();
        reject(error);
      }
    }
  })();

  return {
    promise,
    markComplete(): void {
      completeRequested = true;
      // If we are idling between polls, drain-and-finish now rather than
      // waiting out the poll interval.
      if (!finished && sessionId.length > 0) {
        clearPending();
        void tick();
      }
    },
    cancel(): void {
      cancelled = true;
      finish('cancel');
    },
  };
}
