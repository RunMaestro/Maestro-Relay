import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, DEFAULT_MAX_LENGTH } from '../core/splitMessage';

const MAX_LENGTH = DEFAULT_MAX_LENGTH;

test('splitMessage returns a single part when under limit', () => {
  const input = 'hello world';
  const parts = splitMessage(input);
  assert.deepEqual(parts, [input]);
});

test('splitMessage splits on newline when possible', () => {
  const left = 'a'.repeat(1000);
  const right = 'b'.repeat(1200);
  const input = `${left}\n${right}`;
  const parts = splitMessage(input);

  assert.equal(parts.length, 2);
  assert.equal(parts[0], left);
  assert.equal(parts[1], right);
});

test('splitMessage hard-splits and trims leading whitespace', () => {
  const input = 'x'.repeat(MAX_LENGTH) + '\n' + '  y';
  const parts = splitMessage(input);

  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, MAX_LENGTH);
  assert.equal(parts[1], 'y');
  assert.ok(parts.every((part) => part.length <= MAX_LENGTH));
});

test('splitMessage re-fences a code block split across a boundary', () => {
  const before = 'p'.repeat(1500);
  const code = 'c'.repeat(1500);
  const input = `${before}\n\`\`\`\n${code}\n\`\`\``;
  const parts = splitMessage(input);

  assert.ok(parts.length >= 2, 'message was split');
  // Every part must contain a balanced number of fence delimiters.
  for (const part of parts) {
    const fences = part.split('```').length - 1;
    assert.equal(fences % 2, 0, `part has balanced fences: ${fences}`);
  }
  // The fenced content survives across the boundary.
  assert.ok(parts.some((p) => p.includes(code.slice(0, 100))));
});

test('splitMessage leaves fence-free splits unchanged', () => {
  const left = 'a'.repeat(1000);
  const right = 'b'.repeat(1200);
  const parts = splitMessage(`${left}\n${right}`);
  assert.deepEqual(parts, [left, right]);
});
