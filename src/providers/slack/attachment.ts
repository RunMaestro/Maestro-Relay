/**
 * Slack attachment field limits.
 *
 * Slack's limits are less crisply documented than Discord's. Only the top-level
 * message `text` cap is official: 40,000 characters, per the 2018 truncation
 * changelog (https://docs.slack.dev/changelog/2018-truncating-really-long-messages/).
 * Secondary attachments are a legacy surface and Slack publishes no hard caps
 * for `title` / `text`; the widely-reproduced observed behavior is that
 * attachment text collapses behind "Show more" past ~700 chars and is truncated
 * server-side around 8,000.
 *
 * We therefore clamp to the *observed* truncation point rather than the official
 * message cap: clamping ourselves appends a visible `…` marker, whereas letting
 * Slack truncate drops the tail silently with no indication content was lost.
 * `ATTACHMENT_TITLE_MAX` is a self-imposed presentation cap (a title renders on
 * one line, so a multi-KB title is a layout bug, not a payload error) chosen to
 * match Discord's 256 for cross-provider consistency — it is not a Slack-imposed
 * limit.
 */

import { clampText } from '../../core/clampText';

/** Observed server-side truncation point for attachment `text`. */
export const ATTACHMENT_TEXT_MAX = 8000;
/** Self-imposed single-line title cap (Slack documents no limit). */
export const ATTACHMENT_TITLE_MAX = 256;
/** Official cap on a message's top-level `text` field. */
export const MESSAGE_TEXT_MAX = 40000;

export const clampAttachmentTitle = (text: string): string =>
  clampText(text, ATTACHMENT_TITLE_MAX);
export const clampAttachmentText = (text: string): string => clampText(text, ATTACHMENT_TEXT_MAX);
export const clampMessageText = (text: string): string => clampText(text, MESSAGE_TEXT_MAX);
