/**
 * SusFactor audit trail.
 *
 * Appends every high-scoring screening verdict to a CSV file so the scores can
 * be reviewed later. This is a record for a human to read, separate from
 * `errors.log`: the log answers "what went wrong", this answers "what has been
 * probing the bridge, and how hard".
 *
 * Disabled unless `SUSFACTOR_AUDIT_LOG` names a path. Writes never throw and
 * never block message delivery. An audit failure must not cost the user their
 * message.
 */

import { appendFile, mkdir, stat } from 'fs/promises';
import { dirname } from 'path';

/** One screening verdict, as recorded. */
export interface SusAuditEntry {
  score: number;
  /** What the relay did: allow, flag, or block. */
  action: string;
  /** The configured mode at the time, so a policy change is visible in history. */
  mode: string;
  provider: string;
  channelId: string;
  authorId: string;
  authorName: string;
  agentId: string;
  /** True when the prompt was head/tail sampled before scoring. */
  sampled: boolean;
  /** Full length of the composed prompt, before any excerpting. */
  promptChars: number;
  /** The composed prompt. Truncated to `maxExcerptChars` on write. */
  prompt: string;
}

export interface SusAuditOptions {
  /** CSV path. Empty or undefined disables auditing. */
  path?: string;
  /** Only entries scoring at or above this are recorded. */
  minScore?: number;
  /** Prompt text is truncated to this length before being written. */
  maxExcerptChars?: number;
  /** Injectable for tests; must return an ISO timestamp. */
  now?: () => string;
}

export interface SusAudit {
  readonly enabled: boolean;
  readonly path: string | null;
  readonly minScore: number;
  /** Record a verdict. Resolves once written, or immediately if below threshold. */
  record(entry: SusAuditEntry): Promise<void>;
}

const DEFAULT_MIN_SCORE = 0.9;
const DEFAULT_MAX_EXCERPT_CHARS = 2000;

export const SUS_AUDIT_COLUMNS = [
  'timestamp',
  'score',
  'action',
  'mode',
  'provider',
  'channel_id',
  'author_id',
  'author_name',
  'agent_id',
  'sampled',
  'prompt_chars',
  'prompt_excerpt',
] as const;

/**
 * Escape one CSV field.
 *
 * Newlines are written as the two characters `\n` rather than as real line
 * breaks. RFC 4180 permits a break inside a quoted field, but keeping one
 * record per physical line is what makes `tail`, `wc -l`, and a quick grep
 * work on this file. Readers that want the original text unescape `\\n`.
 */
export function csvField(value: string | number | boolean): string {
  const raw = String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/\r/g, '\\n');
  return `"${raw.replace(/"/g, '""')}"`;
}

function toRow(entry: SusAuditEntry, timestamp: string, maxExcerptChars: number): string {
  const excerpt =
    entry.prompt.length > maxExcerptChars
      ? `${entry.prompt.slice(0, maxExcerptChars)}…[truncated]`
      : entry.prompt;

  return (
    [
      timestamp,
      entry.score.toFixed(6),
      entry.action,
      entry.mode,
      entry.provider,
      entry.channelId,
      entry.authorId,
      entry.authorName,
      entry.agentId,
      entry.sampled,
      entry.promptChars,
      excerpt,
    ]
      .map(csvField)
      .join(',') + '\n'
  );
}

const disabled: SusAudit = {
  enabled: false,
  path: null,
  minScore: DEFAULT_MIN_SCORE,
  async record() {},
};

export function createSusAudit(options: SusAuditOptions = {}): SusAudit {
  const path = options.path?.trim();
  if (!path) return disabled;

  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const maxExcerptChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const now = options.now ?? (() => new Date().toISOString());

  // Appends are serialized through this chain. Rows can exceed the atomic
  // append size, and several conversations are screened concurrently, so
  // unserialized appends would interleave and corrupt rows.
  let tail: Promise<void> = Promise.resolve();

  async function writeRow(row: string): Promise<void> {
    await mkdir(dirname(path!), { recursive: true });

    // A missing file and an existing empty one both need the header row.
    let needsHeader: boolean;
    try {
      needsHeader = (await stat(path!)).size === 0;
    } catch {
      needsHeader = true;
    }

    const header = needsHeader ? `${SUS_AUDIT_COLUMNS.map(csvField).join(',')}\n` : '';
    await appendFile(path!, header + row);
  }

  return {
    enabled: true,
    path,
    minScore,
    record(entry: SusAuditEntry): Promise<void> {
      if (!(entry.score >= minScore)) return Promise.resolve();

      const row = toRow(entry, now(), maxExcerptChars);
      tail = tail.then(
        () =>
          writeRow(row).catch((err) => {
            // Auditing is best-effort. Losing a row must not cost a message.
            console.error(
              `[susaudit] failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
        () => {},
      );
      return tail;
    },
  };
}
