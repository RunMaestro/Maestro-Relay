/**
 * Provider-agnostic GitHub-style callout (a.k.a. "alert") detection and message
 * composition.
 *
 * GitHub renders a blockquote whose first line is `> [!NOTE]` (or `[!TIP]`,
 * `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) as a colored, icon-labeled
 * callout. Chat platforms don't, so we detect these blocks in outbound agent
 * text and hand providers a structured `CalloutPayload` they can render richly
 * (Discord embed, Slack attachment). The surrounding prose is split normally.
 *
 * Like `renderTables`, this module is pure and provider-free by design (see
 * CLAUDE.md): nothing here imports a chat SDK. Fence bookkeeping is shared with
 * `renderTables`/`splitMessage` via `./fences` so a callout marker that appears
 * inside a fenced code block is never mistaken for a real callout.
 */

import { parseFenceLine, closesFence, type Fence } from './fences';
import type { CalloutVariant, CalloutPayload, OutgoingMessage } from './types';

/** A run of ordinary (non-callout) markdown. */
export interface TextSegment {
  kind: 'text';
  body: string;
}

/** A detected callout block. `title` is reserved (never set in v1). */
export interface CalloutSegment {
  kind: 'callout';
  variant: CalloutVariant;
  title?: string;
  /** The `>`-stripped callout body markdown, marker line dropped (may be empty). */
  body: string;
}

export type Segment = TextSegment | CalloutSegment;

/**
 * Per-variant presentation metadata (plan §3.4). `hex` is a GitHub-matched
 * accent color providers can use for an embed/attachment stripe; `emoji` and
 * `label` prefix the rendered title.
 */
export const CALLOUT_META: Record<CalloutVariant, { label: string; emoji: string; hex: string }> = {
  NOTE: { label: 'Note', emoji: 'ℹ️', hex: '#1f6feb' },
  TIP: { label: 'Tip', emoji: '💡', hex: '#238636' },
  IMPORTANT: { label: 'Important', emoji: '❗', hex: '#8957e5' },
  WARNING: { label: 'Warning', emoji: '⚠️', hex: '#d29922' },
  CAUTION: { label: 'Caution', emoji: '🛑', hex: '#da3633' },
};

/**
 * A callout opener: `> [!VARIANT]` alone on the line (uppercase-only, GitHub
 * exact). Up to three leading spaces and one optional space after `>` are
 * allowed; any trailing prose (`> [!NOTE] hi`) disqualifies it.
 */
const OPENER_RE = /^ {0,3}> ?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/;

function matchOpener(line: string): CalloutVariant | null {
  const m = line.match(OPENER_RE);
  return m ? (m[1] as CalloutVariant) : null;
}

/** Whether a line is part of a blockquote run (a bare `>` counts). */
function isBlockquoteLine(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

/** Strip the `^ {0,3}> ?` blockquote prefix from a line. */
function stripQuote(line: string): string {
  return line.replace(/^ {0,3}> ?/, '');
}

/**
 * Split `text` into ordered text/callout segments. Fence-aware: while a
 * top-level code fence is open a callout is never started, so a `> [!NOTE]`
 * line that lives inside a fenced block stays part of the surrounding text.
 * Empty text segments are never emitted.
 */
export function splitCallouts(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let buf: string[] = [];
  let open: Fence | null = null; // current open top-level code fence, or null

  const flushText = () => {
    if (buf.length > 0) {
      const body = buf.join('\n');
      // Never emit an empty text segment: a blank-only buffer (e.g. the blank
      // line separating two adjacent callouts) carries no content and is dropped.
      if (body.trim().length > 0) {
        segments.push({ kind: 'text', body });
      }
      buf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = parseFenceLine(line);
    if (fence) {
      if (open) {
        if (closesFence(open, fence)) open = null;
      } else {
        open = fence;
      }
      buf.push(line);
      i++;
      continue;
    }

    if (open === null) {
      const variant = matchOpener(line);
      if (variant) {
        flushText();
        // Consume the contiguous blockquote run starting at the opener; it ends
        // at the first non-`>` line. A `>`-quoted fenced block survives here as
        // real markdown once the quote prefix is stripped.
        const bodyLines: string[] = [];
        let j = i;
        while (j < lines.length && isBlockquoteLine(lines[j])) {
          bodyLines.push(stripQuote(lines[j]));
          j++;
        }
        bodyLines.shift(); // drop the marker line
        segments.push({ kind: 'callout', variant, body: bodyLines.join('\n') });
        i = j;
        continue;
      }
    }

    buf.push(line);
    i++;
  }

  flushText();
  return segments;
}

/**
 * Reconstruct a lossless `> [!VARIANT]` blockquote from a callout segment so a
 * provider that ignores `.callout` still posts a faithful fallback.
 */
function rawBlockquote(seg: CalloutSegment): string {
  const out = [`> [!${seg.variant}]`];
  if (seg.body.length > 0) {
    for (const line of seg.body.split('\n')) out.push(`> ${line}`);
  }
  return out.join('\n');
}

/**
 * Turn raw agent text into an ordered `OutgoingMessage[]` (plan §3.3).
 *
 * Text segments are table-rendered then length-split via the injected helpers,
 * one message per chunk. Each callout becomes exactly one message carrying both
 * a reconstructed blockquote `text` fallback and a rich `callout` payload (whose
 * body is also table-rendered). `mention` is applied to only the first message.
 */
export function toOutgoing(
  text: string,
  opts: {
    split: (t: string) => string[];
    renderTables: (t: string) => string;
    mention?: boolean;
  },
): OutgoingMessage[] {
  const segments = splitCallouts(text);
  const messages: OutgoingMessage[] = [];

  for (const seg of segments) {
    if (seg.kind === 'text') {
      for (const part of opts.split(opts.renderTables(seg.body))) {
        messages.push({ text: part });
      }
    } else {
      const callout: CalloutPayload = {
        variant: seg.variant,
        body: opts.renderTables(seg.body),
      };
      messages.push({ text: rawBlockquote(seg), callout });
    }
  }

  if (opts.mention && messages.length > 0) {
    messages[0].mention = true;
  }

  return messages;
}
