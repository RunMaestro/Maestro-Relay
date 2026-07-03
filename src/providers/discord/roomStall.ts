/**
 * Discord multi-agent rooms — stall detection (Phase 3, belt-and-suspenders).
 *
 * The honest contract for the room mechanic is **best-effort-with-catch-up,
 * never exactly-once** (see `roomGateways.ts` / the plan §Reconciliation).
 * Reconnect-gap reconciliation recovers a hop lost to a transient gateway drop
 * on the next `resume`. Stall detection is the independent floor for anything
 * reconciliation still cannot see (e.g. a message deleted before refetch, or a
 * bot that simply never answers): if a room has an outstanding mention
 * expectation and no follow-up room message lands within a timeout, we surface
 * it — `log room stall suspected` and, optionally, post an `@human` notice —
 * rather than hang silently forever.
 *
 * This shares no state with the reconciliation path; the room listener merely
 * notifies it. The default (`NoopStallDetector`) does nothing, so the listener
 * and its unit tests never leak timers unless a real detector is wired in.
 */

import type { KernelLogger } from '../../core/types';

/** What the listener tells the detector as room traffic flows. */
export interface RoomStallDetector {
  /**
   * A mention was just routed to a bot in this channel — arm the stall timeout.
   * `armMessageId` is the id of the message that armed it, so `observe` can
   * ignore that very message (every peer bot's listener also observes it).
   */
  expect(channelId: string, addressee: string, armMessageId: string): void;
  /**
   * A room message arrived in this channel. Any message whose id differs from
   * the arming message clears the pending expectation — the room is alive.
   */
  observe(channelId: string, messageId: string): void;
  /** Cancel all pending timers (graceful shutdown). */
  clear(): void;
}

/** Details handed to the stall callback when a timeout fires. */
export interface RoomStallInfo {
  channelId: string;
  addressee: string;
  timeoutMs: number;
}

export interface TimeoutStallDetectorOptions {
  /** How long to wait for a follow-up before flagging a stall. */
  timeoutMs?: number;
  logger?: KernelLogger;
  /**
   * Optional side-effect fired on stall (in addition to the log line) — e.g.
   * posting `@human — no response from @Ada in Ns` into the room channel.
   */
  onStall?: (info: RoomStallInfo) => void | Promise<void>;
}

interface Pending {
  addressee: string;
  armMessageId: string;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Timer-backed detector: one pending expectation per channel. Arming resets the
 * timer; a follow-up message (or shutdown) clears it; the timer firing logs the
 * suspected stall and runs the optional `onStall` side-effect.
 */
export class TimeoutStallDetector implements RoomStallDetector {
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly log: KernelLogger;
  private readonly onStall?: (info: RoomStallInfo) => void | Promise<void>;

  constructor(opts: TimeoutStallDetectorOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.logger ?? {
      error() {},
      warn() {},
      info() {},
      debug() {},
    };
    this.onStall = opts.onStall;
  }

  expect(channelId: string, addressee: string, armMessageId: string): void {
    this.cancel(channelId);
    const timer = setTimeout(() => {
      this.pending.delete(channelId);
      void this.log.warn(
        'discord/roomStall',
        `room stall suspected: no response from @${addressee} in channel ${channelId} ` +
          `within ${Math.round(this.timeoutMs / 1000)}s`,
      );
      void this.onStall?.({ channelId, addressee, timeoutMs: this.timeoutMs });
    }, this.timeoutMs);
    // Do not keep the process alive solely for a stall timer.
    if (typeof timer.unref === 'function') timer.unref();
    this.pending.set(channelId, { addressee, armMessageId, timer });
  }

  observe(channelId: string, messageId: string): void {
    const p = this.pending.get(channelId);
    // Ignore the very message that armed the expectation (all peer bots observe
    // it too); only a *later* message counts as the awaited follow-up.
    if (!p || p.armMessageId === messageId) return;
    this.cancel(channelId);
  }

  clear(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private cancel(channelId: string): void {
    const p = this.pending.get(channelId);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(channelId);
    }
  }
}

/** No-op detector — the listener default, so tests never leak timers. */
export const NoopStallDetector: RoomStallDetector = {
  expect() {},
  observe() {},
  clear() {},
};
