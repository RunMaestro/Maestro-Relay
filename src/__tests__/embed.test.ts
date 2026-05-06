import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_TITLE_MAX,
  clampDescription,
  clampFieldValue,
  clampText,
  clampTitle,
} from '../providers/discord/embed';

test('clampText returns input unchanged when within limit', () => {
  assert.equal(clampText('hello', 10), 'hello');
  assert.equal(clampText('a'.repeat(10), 10), 'a'.repeat(10));
});

test('clampText truncates and appends ellipsis marker when over limit', () => {
  const out = clampText('a'.repeat(20), 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith('\n…'));
});

test('clampText hard-slices when limit is shorter than ellipsis marker', () => {
  assert.equal(clampText('hello', 1), 'h');
});

test('clampDescription enforces the 4096 description limit', () => {
  const huge = 'x'.repeat(EMBED_DESCRIPTION_MAX + 500);
  const out = clampDescription(huge);
  assert.equal(out.length, EMBED_DESCRIPTION_MAX);
});

test('clampFieldValue enforces the 1024 field-value limit', () => {
  const huge = 'y'.repeat(EMBED_FIELD_VALUE_MAX + 500);
  const out = clampFieldValue(huge);
  assert.equal(out.length, EMBED_FIELD_VALUE_MAX);
});

test('clampTitle enforces the 256 title limit', () => {
  const huge = 'z'.repeat(EMBED_TITLE_MAX + 500);
  const out = clampTitle(huge);
  assert.equal(out.length, EMBED_TITLE_MAX);
  assert.ok(out.endsWith('\n…'));
});

test('clampTitle leaves short titles unchanged', () => {
  assert.equal(clampTitle('My Title'), 'My Title');
});
