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

test('splitMessage treats an inner ``` inside a 4-backtick block as content', () => {
  const before = 'p'.repeat(1500);
  const inner = 'c'.repeat(800) + '\n```\n' + 'd'.repeat(800); // a literal ``` line inside
  const input = `${before}\n\`\`\`\`\n${inner}\n\`\`\`\``;
  const parts = splitMessage(input);

  assert.ok(parts.length >= 2, 'message was split');
  // Each chunk must have balanced 4-backtick fences; the inner ``` must not be
  // mistaken for a close/open, which would corrupt the block.
  for (const part of parts) {
    const four = part.split('````').length - 1;
    assert.equal(four % 2, 0, `balanced 4-backtick fences: ${four}`);
  }
});

test('splitMessage reserves for fence info strings (language labels)', () => {
  // A re-opened ```typescript line is longer than a bare ``` — the reserve must
  // be sized from the actual fence, not a fixed constant.
  const input = '```typescript\n' + 'x'.repeat(5000) + '\n```';
  const parts = splitMessage(input);

  assert.ok(parts.length > 1, 'split into multiple chunks');
  for (const part of parts) {
    assert.ok(part.length <= MAX_LENGTH, `chunk length ${part.length} <= ${MAX_LENGTH}`);
  }
  // The language label is preserved on every re-opened chunk.
  assert.ok(parts.slice(1, -1).every((p) => p.startsWith('```typescript')));
});

test('splitMessage honors a custom maxLength even when re-fencing', () => {
  const code = 'c'.repeat(120);
  const input = `\`\`\`\n${code}\n\`\`\``;
  const max = 40;
  const parts = splitMessage(input, max);

  assert.ok(parts.length > 1, 'split into multiple chunks');
  for (const part of parts) {
    assert.ok(part.length <= max, `chunk length ${part.length} <= ${max}`);
  }
});
