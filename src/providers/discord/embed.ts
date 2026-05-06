// Discord embed limits — see https://discord.com/developers/docs/resources/channel#embed-object-embed-limits
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FIELD_VALUE_MAX = 1024;
const ELLIPSIS = '\n…';

/** Truncate `text` to `max` chars, appending an ellipsis marker if truncated. */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= ELLIPSIS.length) return text.slice(0, max);
  return text.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

export const clampTitle = (text: string): string => clampText(text, EMBED_TITLE_MAX);
export const clampDescription = (text: string): string => clampText(text, EMBED_DESCRIPTION_MAX);
export const clampFieldValue = (text: string): string => clampText(text, EMBED_FIELD_VALUE_MAX);
