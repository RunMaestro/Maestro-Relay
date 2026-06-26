export const DEFAULT_MAX_LENGTH = 1990;

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

/** The open fence marker (``` or ~~~) left dangling at the end of `chunk`, or null if balanced. */
function danglingFence(chunk: string): string | null {
  let open: string | null = null;
  for (const line of chunk.split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (!m) continue;
    const marker = m[1][0].repeat(3); // normalize to a 3-char marker
    if (open === null) open = marker;
    else if (open[0] === marker[0]) open = null; // same fence char closes the block
  }
  return open;
}

/**
 * Re-balance code fences across chunk boundaries: when a chunk ends inside a
 * fenced block, close the fence on that chunk and re-open it on the next, so a
 * code block (e.g. a rendered table) never loses its monospace rendering when
 * a long message is split. Adds at most a 4-char fence line per affected chunk,
 * which stays within the 2000-char platform ceiling given DEFAULT_MAX_LENGTH.
 */
function repairFences(parts: string[]): string[] {
  const out: string[] = [];
  let carry: string | null = null; // fence to re-open at the start of the next chunk

  for (let part of parts) {
    if (carry) part = carry + '\n' + part;
    const open = danglingFence(part);
    if (open) {
      part = part + '\n' + open; // close the still-open fence
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
 * code blocks intact by re-fencing across chunk boundaries.
 */
export function splitMessage(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string[] {
  const parts = rawSplit(text, maxLength);
  if (parts.length <= 1) return parts;
  return repairFences(parts);
}
