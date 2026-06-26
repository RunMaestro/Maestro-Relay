import {
  type Fence,
  danglingFence,
  openLine,
  closeLine,
  parseFenceLine,
} from './fences';

export const DEFAULT_MAX_LENGTH = 1990;

/**
 * Headroom reserved from `maxLength` when the text contains code fences, so the
 * extra fence line that re-fencing prepends/appends to a chunk cannot push it
 * past `maxLength`. Covers a long fence marker plus its newline and info string.
 */
const FENCE_RESERVE = 16;

/**
 * Greedy newline-preserving split (the original behavior). Splits on the last
 * newline under `maxLength`, hard-splitting only when a single line is too long.
 */
function rawSplit(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = maxLength;

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

/** Does the text contain at least one fenced-code delimiter line? */
function hasFence(text: string): boolean {
  return text.split('\n').some((line) => parseFenceLine(line) !== null);
}

/**
 * Split a string into chunks that fit within `maxLength`.
 * Splits on newlines when possible to preserve formatting, and keeps fenced
 * code blocks intact by re-fencing across chunk boundaries. When fences are
 * present a small budget is reserved so re-fencing never exceeds `maxLength`.
 */
export function splitMessage(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string[] {
  const fenced = hasFence(text);
  const budget = fenced ? Math.max(1, maxLength - FENCE_RESERVE) : maxLength;
  const parts = rawSplit(text, budget);
  if (parts.length <= 1) return parts;
  return fenced ? repairFences(parts) : parts;
}
