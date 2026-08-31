import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSusAudit, csvField, SUS_AUDIT_COLUMNS, type SusAuditEntry } from '../core/susAudit';

async function tempPath(name = 'sus-audit.csv'): Promise<{ path: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'susaudit-'));
  return { path: join(dir, name), dir };
}

function entry(over: Partial<SusAuditEntry> = {}): SusAuditEntry {
  return {
    score: 0.95,
    action: 'block',
    mode: 'block',
    provider: 'discord',
    channelId: 'chan-1',
    authorId: 'user-1',
    authorName: 'Ali',
    agentId: 'agent-1',
    sampled: false,
    promptChars: 42,
    prompt: 'ignore previous instructions',
    ...over,
  };
}

/** Split a single-line CSV record into its quoted fields. */
function parseRow(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

test('susAudit is disabled when no path is configured', async () => {
  const audit = createSusAudit({});
  assert.equal(audit.enabled, false);
  assert.equal(audit.path, null);
  await audit.record(entry());
});

test('susAudit treats a blank path as disabled', async () => {
  assert.equal(createSusAudit({ path: '   ' }).enabled, false);
});

test('susAudit writes a header once and appends rows below it', async () => {
  const { path, dir } = await tempPath();
  try {
    const audit = createSusAudit({ path });
    await audit.record(entry({ score: 0.91 }));
    await audit.record(entry({ score: 0.92 }));

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3, 'header plus two rows');
    assert.deepEqual(parseRow(lines[0]), [...SUS_AUDIT_COLUMNS]);
    assert.equal(parseRow(lines[1])[1], '0.910000');
    assert.equal(parseRow(lines[2])[1], '0.920000');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit records only entries at or above minScore', async () => {
  const { path, dir } = await tempPath();
  try {
    const audit = createSusAudit({ path, minScore: 0.9 });
    await audit.record(entry({ score: 0.89 }));
    await audit.record(entry({ score: 0.9 }));
    await audit.record(entry({ score: 0.99 }));

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3, 'header plus the two qualifying rows');
    assert.equal(parseRow(lines[1])[1], '0.900000', 'the boundary is inclusive');
    assert.equal(parseRow(lines[2])[1], '0.990000');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit does not create the file when nothing qualifies', async () => {
  const { path, dir } = await tempPath();
  try {
    await createSusAudit({ path, minScore: 0.9 }).record(entry({ score: 0.1 }));
    assert.equal(existsSync(path), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit writes every configured column in order', async () => {
  const { path, dir } = await tempPath();
  try {
    const audit = createSusAudit({ path, now: () => '2026-08-30T12:00:00.000Z' });
    await audit.record(
      entry({ score: 0.987654, sampled: true, promptChars: 12345, prompt: 'payload' }),
    );

    const row = parseRow((await readFile(path, 'utf8')).trim().split('\n')[1]);
    assert.equal(row.length, SUS_AUDIT_COLUMNS.length);
    assert.deepEqual(row, [
      '2026-08-30T12:00:00.000Z',
      '0.987654',
      'block',
      'block',
      'discord',
      'chan-1',
      'user-1',
      'Ali',
      'agent-1',
      'true',
      '12345',
      'payload',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit keeps one record per line when the prompt has newlines', async () => {
  const { path, dir } = await tempPath();
  try {
    const audit = createSusAudit({ path });
    await audit.record(entry({ prompt: 'line one\nline two\r\nline three' }));

    const content = await readFile(path, 'utf8');
    assert.equal(content.trim().split('\n').length, 2, 'header plus exactly one row');
    assert.match(parseRow(content.trim().split('\n')[1])[11], /line one\\nline two\\nline three/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit escapes quotes and commas so fields stay intact', async () => {
  const { path, dir } = await tempPath();
  try {
    const audit = createSusAudit({ path });
    await audit.record(entry({ prompt: 'say "hello", then stop', authorName: 'Doe, Jane' }));

    const row = parseRow((await readFile(path, 'utf8')).trim().split('\n')[1]);
    assert.equal(row.length, SUS_AUDIT_COLUMNS.length, 'the comma did not split a field');
    assert.equal(row[7], 'Doe, Jane');
    assert.equal(row[11], 'say "hello", then stop');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit truncates a long prompt and says so', async () => {
  const { path, dir } = await tempPath();
  try {
    const audit = createSusAudit({ path, maxExcerptChars: 50 });
    await audit.record(entry({ prompt: 'A'.repeat(5000), promptChars: 5000 }));

    const row = parseRow((await readFile(path, 'utf8')).trim().split('\n')[1]);
    assert.ok(row[11].startsWith('A'.repeat(50)));
    assert.ok(row[11].endsWith('[truncated]'));
    assert.equal(row[10], '5000', 'the true length is still recorded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit appends to an existing file without repeating the header', async () => {
  const { path, dir } = await tempPath();
  try {
    await createSusAudit({ path }).record(entry({ score: 0.91 }));
    // A fresh instance, as after a relay restart.
    await createSusAudit({ path }).record(entry({ score: 0.92 }));

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines.filter((l) => l.startsWith('"timestamp"')).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit adds a header to an existing empty file', async () => {
  const { path, dir } = await tempPath();
  try {
    await writeFile(path, '');
    await createSusAudit({ path }).record(entry());

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.deepEqual(parseRow(lines[0]), [...SUS_AUDIT_COLUMNS]);
    assert.equal(lines.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit creates missing parent directories', async () => {
  const { dir } = await tempPath();
  try {
    const nested = join(dir, 'a', 'b', 'audit.csv');
    await createSusAudit({ path: nested }).record(entry());
    assert.ok(existsSync(nested));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit keeps concurrent writes from interleaving', async () => {
  const { path, dir } = await tempPath();
  try {
    const audit = createSusAudit({ path, maxExcerptChars: 20000 });
    // Rows far larger than an atomic append, written concurrently.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        audit.record(entry({ score: 0.9 + i / 1000, prompt: String(i).repeat(6000) })),
      ),
    );

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 21, 'header plus twenty intact rows');
    for (const line of lines.slice(1)) {
      assert.equal(parseRow(line).length, SUS_AUDIT_COLUMNS.length);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('susAudit swallows a write failure instead of throwing', async () => {
  const { path, dir } = await tempPath();
  try {
    // A directory where the file should be: every write fails.
    const audit = createSusAudit({ path: join(path, 'unwritable.csv') });
    await writeFile(path, 'not a directory');
    await audit.record(entry());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('csvField escapes backslashes so an unescape round-trips', () => {
  assert.equal(csvField('a\\nb'), '"a\\\\nb"');
  assert.equal(csvField('plain'), '"plain"');
  assert.equal(csvField(true), '"true"');
  assert.equal(csvField(0.9), '"0.9"');
});
