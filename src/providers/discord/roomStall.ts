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
   * A room message arrived in this channel. It satisfies — and clears — ONLY the
   * expectation of the addressee that produced it (`addressee` = the author's
   * participant handle, or undefined for a human/third-party message, which
   * clears nothing). A co-mentioned sibling that never replied keeps its timer.
   */
  observe(channelId: string, messageId: string, addressee?: string): void;
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
 * Timer-backed detector: one pending expectation **per (channel, addressee)**.
 * A single room message can `@`-mention two bots at once, and each bot's
 * listener arms its own expectation; keying only on channel would let the
 * second arm cancel the first, so only the last-mentioned bot was ever watched
 * and the first bot's stall went silently unreported. Keying per addressee arms
 * both independently.
 *
 * Arming re-arms only that addressee's timer; a follow-up message clears only
 * the expectation of the addressee that authored it (a co-mentioned sibling that
 * is genuinely stalled keeps its timer), shutdown clears the channel's
 * expectations, and a fired timer logs the suspected stall and runs the optional
 * `onStall` side-effect.
 */
export class TimeoutStallDetector implements RoomStallDetector {
  // channelId → (addressee → pending). Nested so per-addressee arming never
  // touches a sibling addressee's timer.
  private readonly pending = new Map<string, Map<string, Pending>>();
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
    // Re-arm ONLY this addressee's expectation; leave any sibling (a co-mentioned
    // bot armed by the same message) untouched.
    this.remove(channelId, addressee, true);
    const timer = setTimeout(() => {
      this.remove(channelId, addressee, false);
      void this.log.warn(
        'discord/roomStall',
        `room stall suspected: no response from @${addressee} in channel ${channelId} ` +
          `within ${Math.round(this.timeoutMs / 1000)}s`,
      );
      void this.onStall?.({ channelId, addressee, timeoutMs: this.timeoutMs });
    }, this.timeoutMs);
    // Do not keep the process alive solely for a stall timer.
    if (typeof timer.unref === 'function') timer.unref();
    const byAddressee = this.pending.get(channelId) ?? new Map<string, Pending>();
    byAddressee.set(addressee, { addressee, armMessageId, timer });
    this.pending.set(channelId, byAddressee);
  }

  observe(channelId: string, messageId: string, addressee?: string): void {
    const byAddressee = this.pending.get(channelId);
    if (!byAddressee) return;
    // A follow-up satisfies ONLY the expectation of the addressee that authored
    // it. Without an identifiable addressee (a human or third-party message) it
    // clears nothing — a co-mentioned bot that is genuinely stalled keeps its
    // timer, so its stall still fires. Clearing every sibling here (the old
    // behaviour) meant one bot's reply cancelled the other's watch.
    if (addressee === undefined) return;
    const p = byAddressee.get(addressee);
    // The arming message shares its id (every peer bot observes it too), so it
    // must never clear the very expectation it just armed.
    if (!p || p.armMessageId === messageId) return;
    clearTimeout(p.timer);
    byAddressee.delete(addressee);
    if (byAddressee.size === 0) this.pending.delete(channelId);
  }

  clear(): void {
    for (const byAddressee of this.pending.values()) {
      for (const { timer } of byAddressee.values()) clearTimeout(timer);
    }
    this.pending.clear();
  }

  /** Drop one (channel, addressee) expectation; optionally clear its timer. */
  private remove(channelId: string, addressee: string, clearActiveTimer: boolean): void {
    const byAddressee = this.pending.get(channelId);
    const p = byAddressee?.get(addressee);
    if (!p) return;
    if (clearActiveTimer) clearTimeout(p.timer);
    byAddressee!.delete(addressee);
    if (byAddressee!.size === 0) this.pending.delete(channelId);
  }
}

/** No-op detector — the listener default, so tests never leak timers. */
export const NoopStallDetector: RoomStallDetector = {
  expect() {},
  observe() {},
  clear() {},
};
