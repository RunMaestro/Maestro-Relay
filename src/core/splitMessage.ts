export const DEFAULT_MAX_LENGTH = 1990;

/**
 * Split a string into chunks that fit within `maxLength`.
 * Tries to split on newlines when possible to preserve formatting.
 */
export function splitMessage(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string[] {
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
