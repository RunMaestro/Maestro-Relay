/**
 * Length clamping for provider payload fields.
 *
 * Every chat platform caps the fields of a rich message (Discord embed titles,
 * Slack attachment text, ...) and rejects or silently truncates anything longer.
 * The clamp itself is identical everywhere — cut to the limit, mark that a cut
 * happened — so it lives here in the pure core while each provider keeps its own
 * limit constants next to the code that knows them (`discord/embed.ts`,
 * `slack/attachment.ts`).
 */

const ELLIPSIS = '\n…';

/** Truncate `text` to `max` chars, appending an ellipsis marker if truncated. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= ELLIPSIS.length) return text.slice(0, max);
  return text.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}
