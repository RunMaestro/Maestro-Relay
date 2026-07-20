// Discord embed limits — see https://discord.com/developers/docs/resources/channel#embed-object-embed-limits
import { clampText } from '../../core/clampText';

export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FIELD_VALUE_MAX = 1024;

// Re-exported so existing callers keep importing the clamp from the embed
// module they already depend on; the implementation is shared with Slack.
export { clampText };

export const clampTitle = (text: string): string => clampText(text, EMBED_TITLE_MAX);
export const clampDescription = (text: string): string => clampText(text, EMBED_DESCRIPTION_MAX);
export const clampFieldValue = (text: string): string => clampText(text, EMBED_FIELD_VALUE_MAX);
