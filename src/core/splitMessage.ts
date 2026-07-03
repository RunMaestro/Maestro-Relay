import {
  type Fence,
  danglingFence,
  openLine,
  closeLine,
  parseFenceLine,
} from './fences';

export const DEFAULT_MAX_LENGTH = 1990;

/**
 * Worst-case headroom that re-fencing can add to a single chunk: a continuation
 * chunk may be prepended with the re-opened fence line (marker + info + newline)
 * AND appended with a closing fence line (marker + newline). Sized from the
 * actual fences in the text so it covers any fence length or language label — a
 * fixed reserve cannot, since info strings are unbounded. Returns 0 when there
 * are no fences, leaving fence-free splitting byte-for-byte unchanged.
 */
function fenceReserve(text: string): number {
  let maxPrepend = 0;
  let maxAppend = 0;
  for (const line of text.split('\n')) {
    const f = parseFenceLine(line);
    if (!f) continue;
    maxPrepend = Math.max(maxPrepend, openLine(f).length + 1); // re-opened line + '\n'
    maxAppend = Math.max(maxAppend, closeLine(f).length + 1); // closing line + '\n'
  }
  return maxPrepend + maxAppend;
}

/**
 * Discord mention/channel tokens that must never be cut across a chunk
 * boundary: user (`<@id>` / `<@!id>`), role (`<@&id>`), and channel (`<#id>`).
 * A token torn at a boundary fires no ping, so it is treated as indivisible.
 */
const MENTION_TOKEN = /<(?:@[!&]?|#)\d+>/g;

/**
 * Nudge a candidate split index so it never lands *inside* a Discord mention
 * token. If the boundary would straddle a token, break **before** it so the
 * whole token carries to the next chunk. Newline-based boundaries are already
 * safe (a token contains no newline); this only ever moves a hard-split index.
 * Falls back to the original index when the offending token starts at 0 (a lone
 * token longer than the budget), so the loop always makes progress.
 */
function avoidMentionCut(text: string, splitAt: number): number {
  MENTION_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_TOKEN.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start >= splitAt) break; // tokens are ordered; none earlier can straddle
    if (splitAt > start && splitAt < end) {
      return start > 0 ? start : splitAt;
    }
  }
  return splitAt;
}

/**
 * Greedy newline-preserving split (the original behavior). Splits on the last
 * newline under `maxLength`, hard-splitting only when a single line is too long.
 * A hard-split boundary is pulled back before any Discord mention token it would
 * otherwise slice through, keeping mention tokens atomic.
 */
function rawSplit(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    splitAt = avoidMentionCut(remaining, splitAt);

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

/**
 * Re-balance code fences across chunk boundaries: when a chunk ends inside a
 * fenced block, close the fence on that chunk and re-open it (preserving the
 * original marker length and info string) on the next, so a code block — e.g. a
 * rendered table — never loses its monospace rendering when a long message is
 * split.
 */
function repairFences(parts: string[]): string[] {
  const out: string[] = [];
  let carry: Fence | null = null; // fence to re-open at the start of the next chunk

  for (let part of parts) {
    if (carry) part = openLine(carry) + '\n' + part;
    const open = danglingFence(part);
    if (open) {
      part = part + '\n' + closeLine(open);
      carry = open;
    } else {
      carry = null;
    }
    out.push(part);
  }
  return out;
}

/**
 * Split a string into chunks that fit within `maxLength`.
 * Splits on newlines when possible to preserve formatting, and keeps fenced
 * code blocks intact by re-fencing across chunk boundaries. When fences are
 * present, budget is reserved up front (sized from the actual fences) so
 * re-fencing never pushes a chunk past `maxLength`.
 */
export function splitMessage(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string[] {
  // A message that already fits is sent as-is — the fence reserve only matters
  // once a split is actually required, so don't let it force an unneeded split.
  if (text.length <= maxLength) return [text];
  const reserve = fenceReserve(text);
  const budget = reserve > 0 ? Math.max(1, maxLength - reserve) : maxLength;
  const parts = rawSplit(text, budget);
  if (parts.length <= 1) return parts;
  return reserve > 0 ? repairFences(parts) : parts;
}
