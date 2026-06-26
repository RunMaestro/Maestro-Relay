/**
 * Minimal, CommonMark-aware fenced-code-block tracking, shared by
 * `renderTables` (skip tables inside fences) and `splitMessage` (re-fence
 * across chunk boundaries).
 *
 * The important subtlety: fences may be longer than three characters (e.g. a
 * ```` ```` block deliberately wraps content that itself contains ```), and a
 * closing fence must use the *same character*, be *at least as long* as the
 * opener, and carry *no info string*. Collapsing every marker to a 3-char token
 * would mistake an inner ``` line for a close.
 */

export interface Fence {
  char: '`' | '~';
  len: number;
  /** The info string (e.g. language) that follows an opening fence; '' for a bare/closing fence. */
  info: string;
}

/**
 * Parse a line as a fenced-code delimiter, or return null if it isn't one.
 * Per CommonMark a fence may be indented at most three spaces; four or more
 * makes it an indented-code line, not a fence, so we must not treat it as one.
 */
export function parseFenceLine(line: string): Fence | null {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*(.*)$/);
  if (!m) return null;
  const char = m[1][0] as '`' | '~';
  const info = m[2].trim();
  // CommonMark: a backtick fence's info string may not contain a backtick
  // (it would be ambiguous with inline code), so such a line is not a fence.
  if (char === '`' && info.includes('`')) return null;
  return { char, len: m[1].length, info };
}

/** Whether `fence` can close an open block started by `open`. */
export function closesFence(open: Fence, fence: Fence): boolean {
  return fence.char === open.char && fence.len >= open.len && fence.info === '';
}

/** The literal line that re-opens a block, preserving the original info string. */
export function openLine(f: Fence): string {
  return f.char.repeat(f.len) + (f.info ? f.info : '');
}

/** The literal line that closes a block (bare marker, no info string). */
export function closeLine(f: Fence): string {
  return f.char.repeat(f.len);
}

/**
 * Scan `text` and return the fence left open at the end, or null if balanced.
 * A fence-looking line that can't close the current block is treated as content.
 */
export function danglingFence(text: string): Fence | null {
  let open: Fence | null = null;
  for (const line of text.split('\n')) {
    const fence = parseFenceLine(line);
    if (!fence) continue;
    if (open) {
      if (closesFence(open, fence)) open = null;
      // else: shorter/different/info-bearing fence inside the block → content
    } else {
      open = fence;
    }
  }
  return open;
}
