import type { IncomingMessage, KernelLogger } from './types';

/**
 * Ambient mode: the agent listens to an ordinary channel conversation and
 * answers when it has something to add, instead of being addressed each time.
 *
 * Two problems have to be solved for that to feel natural rather than annoying.
 *
 * The first is turn boundaries. People type in fragments — three short lines
 * are one thought, not three. Forwarding each line separately would spawn a
 * separate agent turn per line: expensive, slow, and the agent would answer the
 * first fragment before reading the rest. So messages are buffered and flushed
 * once the channel has been quiet for a moment, which is the same cue a person
 * in the room uses to decide someone has finished talking.
 *
 * The second is restraint. Most of what two collaborators say to each other
 * does not need a third voice. The batch is handed to the agent with explicit
 * permission to say nothing, and a reply of exactly SILENCE_SENTINEL is dropped
 * by the queue rather than posted. An ambient agent that answers everything is
 * worse than no ambient agent at all.
 *
 * This module owns only the buffering. It has no Discord types in it and no
 * database access, so it can be unit-tested with a fake clock.
 */

/** A reply consisting of exactly this token means "I have nothing to add". */
export const SILENCE_SENTINEL = '[silence]';

/** Quiet period before a batch is considered finished. */
export const DEFAULT_WINDOW_MS = 20_000;

/** Flush early once this many messages pile up, however fast people are typing. */
export const DEFAULT_MAX_BATCH = 25;

/** Hard ceiling on how long a single batch may keep growing before it is forced out. */
export const DEFAULT_MAX_WAIT_MS = 120_000;

export type AmbientEntry = {
  authorName: string;
  content: string;
  /** The provider message this came from. The last one in a batch anchors the reply. */
  message: IncomingMessage;
};

export type AmbientFlush = {
  channelId: string;
  entries: AmbientEntry[];
  /** Rendered `[Name] said this` transcript, oldest first. */
  transcript: string;
  /** The most recent message in the batch — use it as the enqueue anchor. */
  anchor: IncomingMessage;
  reason: 'quiet' | 'full' | 'max-wait' | 'manual';
};

export type AmbientBufferOptions = {
  windowMs?: number;
  maxBatch?: number;
  maxWaitMs?: number;
  onFlush: (flush: AmbientFlush) => void | Promise<void>;
  logger?: KernelLogger;
  /** Injectable for tests. Defaults to the real timer functions. */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
    clearTimeout: (handle: NodeJS.Timeout) => void;
  };
};

type ChannelState = {
  entries: AmbientEntry[];
  quietTimer?: NodeJS.Timeout;
  maxWaitTimer?: NodeJS.Timeout;
};

/** Render a batch the way a transcript reads, so the agent knows who said what. */
export function renderTranscript(entries: AmbientEntry[]): string {
  return entries
    .map((e) => `[${e.authorName}] ${e.content}`.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Wrap a transcript in the instruction that makes ambient mode work.
 *
 * The wording matters more than it looks. "You may stay silent" on its own is
 * not enough — a model asked to consider a conversation will nearly always find
 * something to say. Silence has to be named as the expected default, with the
 * bar for speaking set explicitly.
 */
export function buildAmbientPrompt(transcript: string, purview?: string): string {
  const scope = purview?.trim() ? `Your purview is: ${purview.trim()}\n\n` : '';
  return (
    `You are listening to an ongoing conversation in a channel you are part of. ` +
    `Nobody has addressed you directly.\n\n` +
    scope +
    `${transcript}\n\n` +
    `---\n` +
    `Decide whether to say anything. **Staying silent is the normal outcome** — ` +
    `these people are talking to each other, not to you. Speak only if you can ` +
    `add something they do not already have: a correction, a number you can ` +
    `check, an answer to a question that was actually asked, or a flag that ` +
    `something stated is wrong.\n\n` +
    `Do not summarise what they said, do not agree, do not encourage, and do ` +
    `not announce that you are listening.\n\n` +
    `If you have nothing to add, reply with exactly ${SILENCE_SENTINEL} and ` +
    `nothing else.`
  );
}

/** True when an agent reply means "nothing to add" and should not be posted. */
export function isSilence(response: string | null | undefined): boolean {
  if (!response) return true;
  const trimmed = response.trim();
  if (!trimmed) return true;
  // Tolerate a model that wraps the sentinel in punctuation or code fences.
  const stripped = trimmed.replace(/^[`*_\s]+|[`*_\s.]+$/g, '').toLowerCase();
  return stripped === SILENCE_SENTINEL.toLowerCase() || stripped === 'silence';
}

export function createAmbientBuffer(options: AmbientBufferOptions) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const timers = options.timers ?? { setTimeout, clearTimeout };
  const log = options.logger;

  const channels = new Map<string, ChannelState>();

  function clearTimers(state: ChannelState): void {
    if (state.quietTimer) timers.clearTimeout(state.quietTimer);
    if (state.maxWaitTimer) timers.clearTimeout(state.maxWaitTimer);
    state.quietTimer = undefined;
    state.maxWaitTimer = undefined;
  }

  function flush(channelId: string, reason: AmbientFlush['reason']): void {
    const state = channels.get(channelId);
    if (!state || state.entries.length === 0) return;

    clearTimers(state);
    const entries = state.entries;
    channels.delete(channelId);

    const anchor = entries[entries.length - 1].message;
    log?.debug('ambient/flush', `channel=${channelId} reason=${reason} messages=${entries.length}`);

    void Promise.resolve(
      options.onFlush({
        channelId,
        entries,
        transcript: renderTranscript(entries),
        anchor,
        reason,
      }),
    ).catch((err) => {
      void log?.error('ambient/flush', `channel=${channelId} error=${String(err)}`);
    });
  }

  return {
    /** Buffer one message. Flushes on quiet, on batch size, or on max wait. */
    add(channelId: string, entry: AmbientEntry): void {
      let state = channels.get(channelId);
      if (!state) {
        state = { entries: [] };
        channels.set(channelId, state);
        // Started a new batch — bound how long it may keep growing.
        state.maxWaitTimer = timers.setTimeout(() => flush(channelId, 'max-wait'), maxWaitMs);
      }

      state.entries.push(entry);

      if (state.entries.length >= maxBatch) {
        flush(channelId, 'full');
        return;
      }

      // Each new message pushes the quiet deadline back.
      if (state.quietTimer) timers.clearTimeout(state.quietTimer);
      state.quietTimer = timers.setTimeout(() => flush(channelId, 'quiet'), windowMs);
    },

    /** Force a channel's batch out now. Used by `/agents ambient off` and shutdown. */
    flushNow(channelId: string): void {
      flush(channelId, 'manual');
    },

    /** Drop a channel's pending batch without delivering it. */
    discard(channelId: string): void {
      const state = channels.get(channelId);
      if (!state) return;
      clearTimers(state);
      channels.delete(channelId);
    },

    /** Number of messages currently buffered for a channel. */
    pending(channelId: string): number {
      return channels.get(channelId)?.entries.length ?? 0;
    },

    /** Clear every timer. Call on shutdown so the process can exit. */
    dispose(): void {
      for (const state of channels.values()) clearTimers(state);
      channels.clear();
    },
  };
}

export type AmbientBuffer = ReturnType<typeof createAmbientBuffer>;
