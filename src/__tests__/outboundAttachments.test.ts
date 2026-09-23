import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stripMarkers,
  resolveOutboundFile,
  extractOutboundAttachments,
  MAX_OUTBOUND_FILES,
} from '../core/outboundAttachments';

async function fixture(): Promise<{ root: string; outside: string; cleanup: () => Promise<void> }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'outbound-attach-'));
  const root = path.join(base, 'artifacts');
  const outside = path.join(base, 'private');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, 'table.png'), 'PNG');
  await fs.writeFile(path.join(root, 'notes.md'), '# secret-ish');
  await fs.writeFile(path.join(outside, 'id_ed25519'), 'PRIVATE KEY');
  await fs.writeFile(path.join(outside, 'stolen.png'), 'PNG');
  await fs.mkdir(path.join(root, 'pedcast'), { recursive: true });
  await fs.writeFile(path.join(root, 'pedcast', 'episode.mp3'), 'ID3');
  await fs.writeFile(path.join(outside, 'episode.mp3'), 'ID3');
  return { root, outside, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

test('stripMarkers removes the marker line and keeps the prose intact', () => {
  const { text, requested } = stripMarkers(
    'Here is the table.\n[[attach: discord/t.png]]\nAnd the caption.',
  );
  assert.equal(requested.length, 1);
  assert.equal(requested[0], 'discord/t.png');
  assert.equal(text, 'Here is the table.\nAnd the caption.');
  assert.ok(!text.includes('attach'));
  assert.ok(!text.includes('.png'));
});

test('stripMarkers tolerates spacing and case', () => {
  const { requested } = stripMarkers('  [[ ATTACH :  a/b.png ]]  ');
  assert.deepEqual(requested, ['a/b.png']);
});

test('stripMarkers ignores a marker that is not alone on its line', () => {
  const { text, requested } = stripMarkers('inline [[attach: x.png]] mention');
  assert.deepEqual(requested, []);
  assert.equal(text, 'inline [[attach: x.png]] mention');
});

test('a path inside the root resolves', async () => {
  const f = await fixture();
  const r = await resolveOutboundFile('table.png', f.root);
  assert.equal(r.ok, true);
  await f.cleanup();
});

test('an mp3 inside the root resolves', async () => {
  const f = await fixture();
  const r = await resolveOutboundFile('pedcast/episode.mp3', f.root);
  assert.equal(r.ok, true);
  await f.cleanup();
});

test('an mp3 outside the root is refused', async () => {
  const f = await fixture();
  const r = await resolveOutboundFile('../private/episode.mp3', f.root);
  assert.equal(r.ok, false);
  await f.cleanup();
});

test('dot-dot escape from the root is refused', async () => {
  const f = await fixture();
  const r = await resolveOutboundFile('../private/stolen.png', f.root);
  assert.equal(r.ok, false);
  await f.cleanup();
});

test('a symlink inside the root pointing outside it is refused', async () => {
  const f = await fixture();
  await fs.symlink(path.join(f.outside, 'stolen.png'), path.join(f.root, 'link.png'));
  const r = await resolveOutboundFile('link.png', f.root);
  assert.equal(r.ok, false, 'realpath must run before the containment test');
  await f.cleanup();
});

test('an absolute path is refused even when it is inside the root', async () => {
  const f = await fixture();
  const r = await resolveOutboundFile(path.join(f.root, 'table.png'), f.root);
  assert.equal(r.ok, false);
  await f.cleanup();
});

test('an extension outside the allowlist is refused', async () => {
  const f = await fixture();
  const r = await resolveOutboundFile('notes.md', f.root);
  assert.equal(r.ok, false);
  await f.cleanup();
});

test('a missing file is refused', async () => {
  const f = await fixture();
  const r = await resolveOutboundFile('nope.png', f.root);
  assert.equal(r.ok, false);
  await f.cleanup();
});

test('with no root configured the feature is off and markers still vanish', async () => {
  const out = await extractOutboundAttachments('text\n[[attach: table.png]]', undefined);
  assert.deepEqual(out.files, []);
  assert.equal(out.text, 'text');
  assert.equal(out.rejected.length, 1);
});

test('extract keeps the good file and drops the escaping one', async () => {
  const f = await fixture();
  const out = await extractOutboundAttachments(
    'both\n[[attach: table.png]]\n[[attach: ../private/stolen.png]]',
    f.root,
  );
  assert.equal(out.files.length, 1);
  assert.ok(out.files[0].endsWith('table.png'));
  assert.equal(out.rejected.length, 1);
  assert.equal(out.text, 'both');
  await f.cleanup();
});

test('the per-reply file count is capped', async () => {
  const f = await fixture();
  for (let i = 0; i < MAX_OUTBOUND_FILES + 2; i++) {
    await fs.writeFile(path.join(f.root, `f${i}.png`), 'PNG');
  }
  const markers = Array.from({ length: MAX_OUTBOUND_FILES + 2 }, (_, i) => `[[attach: f${i}.png]]`);
  const out = await extractOutboundAttachments(`x\n${markers.join('\n')}`, f.root);
  assert.equal(out.files.length, MAX_OUTBOUND_FILES);
  assert.equal(out.rejected.length, 2);
  await f.cleanup();
});
