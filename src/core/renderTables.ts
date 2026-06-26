/**
 * Provider-agnostic GitHub-flavored-markdown table normalization.
 *
 * Chat platforms (Discord, Slack mrkdwn, ...) don't render markdown tables —
 * they show the raw `| a | b |` pipes. Every platform we target does render
 * triple-backtick code blocks in a fixed-width font, so we detect GFM tables
 * and re-emit them as width-aligned ASCII tables wrapped in a code fence. The
 * columns then line up on every client.
 *
 * This module is pure and provider-free by design (see CLAUDE.md): adapters
 * and the kernel call `renderTables` on outbound agent text; nothing here
 * imports a chat SDK.
 */

import { parseFenceLine, closesFence, type Fence } from './fences';

/** Max combined content width (sum of column widths) before we truncate cells. */
export const MAX_TABLE_WIDTH = 56;

/** Minimum width a column may be shrunk to (room for one char + the ellipsis). */
const MIN_COL_WIDTH = 3;

type Align = 'left' | 'right' | 'center';

/**
 * A GFM separator row, e.g. `|---|:--:|` or `:-- | --:`.
 * A pipe is required: without one, `---` is a thematic break, not a table.
 */
function isSeparator(line: string): boolean {
  const s = line.trim();
  if (!s.includes('|') || !s.includes('-')) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(s);
}

/** A candidate table row: contains a pipe and isn't a fence delimiter. */
function isTableRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 0 && parseFenceLine(line) === null;
}

/** Split a markdown table row into trimmed cells, honoring `\|` escapes and optional outer pipes. */
function splitCells(row: string): string[] {
  const s = row.trim();
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  // Outer pipes produce empty leading/trailing cells — drop a single one of each.
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function parseAligns(separator: string, columns: number): Align[] {
  const cells = splitCells(separator);
  const aligns: Align[] = [];
  for (let i = 0; i < columns; i++) {
    const spec = cells[i] ?? '';
    const left = spec.startsWith(':');
    const right = spec.endsWith(':');
    if (left && right) aligns.push('center');
    else if (right) aligns.push('right');
    else aligns.push('left');
  }
  return aligns;
}

/** Shrink the widest columns until the total content width fits the cap. */
function capWidths(widths: number[], cap: number): number[] {
  const w = [...widths];
  const sum = () => w.reduce((a, b) => a + b, 0);
  while (sum() > cap) {
    let idx = 0;
    for (let i = 1; i < w.length; i++) if (w[i] > w[idx]) idx = i;
    if (w[idx] <= MIN_COL_WIDTH) break; // can't shrink further without losing all signal
    w[idx]--;
  }
  return w;
}

/** Truncate a cell to `width`, marking the cut with an ellipsis. */
function fit(s: string, width: number): string {
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return s.slice(0, width - 1) + '…';
}

function pad(s: string, width: number, align: Align): string {
  const space = width - s.length;
  if (space <= 0) return s;
  if (align === 'right') return ' '.repeat(space) + s;
  if (align === 'center') {
    const l = Math.floor(space / 2);
    return ' '.repeat(l) + s + ' '.repeat(space - l);
  }
  return s + ' '.repeat(space);
}

function rule(widths: number[]): string {
  return '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
}

function renderRow(cells: string[], widths: number[], aligns: Align[]): string {
  return (
    '|' +
    widths
      .map((w, i) => ' ' + pad(fit(cells[i] ?? '', w), w, aligns[i]) + ' ')
      .join('|') +
    '|'
  );
}

/** Render one parsed table (header + body rows) as a fenced ASCII table. */
function renderTable(headerLine: string, separatorLine: string, bodyLines: string[]): string {
  const header = splitCells(headerLine);
  const columns = header.length;
  const aligns = parseAligns(separatorLine, columns);
  const body = bodyLines.map((l) => {
    const cells = splitCells(l);
    // Normalize each row to the header's column count.
    return Array.from({ length: columns }, (_, i) => cells[i] ?? '');
  });

  let widths = Array.from({ length: columns }, (_, i) =>
    Math.max(header[i].length, ...body.map((r) => r[i].length), 1),
  );
  widths = capWidths(widths, MAX_TABLE_WIDTH);

  const lines: string[] = [];
  lines.push(rule(widths));
  lines.push(renderRow(header, widths, aligns));
  lines.push(rule(widths));
  for (const row of body) lines.push(renderRow(row, widths, aligns));
  lines.push(rule(widths));

  return '```\n' + lines.join('\n') + '\n```';
}

/**
 * Replace every GFM table block in `text` with a fenced ASCII rendering.
 * Non-table text is returned unchanged; tables already inside a code fence
 * are left alone (the agent fenced them deliberately).
 */
export function renderTables(text: string): string {
  if (!text.includes('|')) return text; // fast path: no pipes, no tables
  const lines = text.split('\n');
  const out: string[] = [];
  let open: Fence | null = null; // current open code fence, or null
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
      out.push(line);
      i++;
      continue;
    }

    if (
      open === null &&
      isTableRow(line) &&
      i + 1 < lines.length &&
      isSeparator(lines[i + 1]) &&
      // A real GFM table's separator has the same column count as its header;
      // requiring this avoids rewriting prose that merely looks table-ish.
      splitCells(lines[i + 1]).length === splitCells(line).length
    ) {
      const header = line;
      const separator = lines[i + 1];
      const body: string[] = [];
      let j = i + 2;
      // Collect every subsequent table row. A row of dashes (e.g. `| --- |`)
      // is valid table data, so the separator check is NOT a terminator here —
      // GFM ends a table at the first non-row line (typically a blank line).
      while (j < lines.length && isTableRow(lines[j])) {
        body.push(lines[j]);
        j++;
      }
      out.push(renderTable(header, separator, body));
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  return out.join('\n');
}
