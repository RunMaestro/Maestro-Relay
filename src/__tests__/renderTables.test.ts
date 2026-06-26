import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTables, MAX_TABLE_WIDTH } from '../core/renderTables';

test('renderTables converts a basic table to a fenced ASCII table', () => {
  const input = ['| Name | Qty |', '| --- | --- |', '| widget | 12 |', '| gadget | 3 |'].join(
    '\n',
  );
  const out = renderTables(input);

  assert.ok(out.startsWith('```\n'), 'wrapped in an opening fence');
  assert.ok(out.endsWith('\n```'), 'wrapped in a closing fence');
  assert.ok(out.includes('+--------+-----+'), 'has aligned rule lines');
  assert.ok(out.includes('| Name   | Qty |'), 'header is padded to column width');
  assert.ok(out.includes('| widget | 12  |'), 'body cells are padded to column width');
});

test('renderTables honors column alignment markers', () => {
  const input = ['| L | R | C |', '| :-- | --: | :-: |', '| a | b | c |'].join('\n');
  const out = renderTables(input);
  // Column widths are 1; with a width-1 column alignment is a no-op, so widen.
  const wide = ['| Left | Right | Mid |', '| :-- | --: | :-: |', '| a | b | c |'].join('\n');
  const w = renderTables(wide);

  assert.ok(out.includes('| a | b | c |'));
  assert.ok(
    w.includes('| a    |     b |  c  |'),
    'left col left-aligned, right col right-aligned, middle centered',
  );
});

test('renderTables normalizes ragged rows to the header column count', () => {
  const input = ['| A | B | C |', '| - | - | - |', '| 1 |', '| 1 | 2 | 3 | 4 |'].join('\n');
  const out = renderTables(input);

  // Short row is padded with empty cells; long row is truncated to 3 columns.
  assert.ok(out.includes('| 1 |   |   |'));
  assert.ok(out.includes('| 1 | 2 | 3 |'));
  assert.ok(!out.includes('| 4 |'));
});

test('renderTables unescapes \\| inside cells', () => {
  const input = ['| Expr |', '| --- |', '| a \\| b |'].join('\n');
  const out = renderTables(input);
  assert.ok(out.includes('a | b'));
});

test('renderTables handles tables without outer pipes', () => {
  const input = ['Name | Qty', '--- | ---', 'widget | 12'].join('\n');
  const out = renderTables(input);
  assert.ok(out.includes('| widget |'));
  assert.ok(out.includes('| Name   | Qty |'));
});

test('renderTables leaves non-table text untouched', () => {
  const input = 'Just a sentence.\nAnother line with a | pipe but no table.';
  assert.equal(renderTables(input), input);
});

test('renderTables preserves surrounding prose', () => {
  const input = ['Here are results:', '', '| A | B |', '| - | - |', '| 1 | 2 |', '', 'Done.'].join(
    '\n',
  );
  const out = renderTables(input);
  assert.ok(out.startsWith('Here are results:\n\n```'));
  assert.ok(out.endsWith('```\n\nDone.'));
});

test('renderTables does not touch a table already inside a code fence', () => {
  const input = ['```', '| A | B |', '| - | - |', '| 1 | 2 |', '```'].join('\n');
  assert.equal(renderTables(input), input);
});

test('renderTables converts multiple tables in one message', () => {
  const input = [
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    'between',
    '',
    '| C | D |',
    '| - | - |',
    '| 3 | 4 |',
  ].join('\n');
  const out = renderTables(input);
  const fences = out.split('```').length - 1;
  assert.equal(fences, 4, 'two tables → two open + two close fences');
  assert.ok(out.includes('between'));
});

test('renderTables keeps body rows that look like a separator (regression: data loss)', () => {
  // A dash-only data row must not terminate the table early.
  const input = ['| A | B |', '| --- | --- |', '| --- | --- |', '| 1 | 2 |'].join('\n');
  const out = renderTables(input);

  // All three body rows survive inside one fenced table; nothing leaks as raw markdown.
  assert.equal(out.split('```').length - 1, 2, 'exactly one fenced block');
  assert.ok(out.includes('| --- | --- |'), 'dash row rendered as data');
  assert.ok(out.includes('| 1   | 2   |'), 'trailing row survives');
});

test('renderTables ignores a table-like block inside a longer (4-backtick) fence', () => {
  const input = ['````', '| A | B |', '| - | - |', '| 1 | 2 |', '```', 'still inside', '````'].join(
    '\n',
  );
  // The inner ``` does not close the ```` block, so the table stays untouched.
  assert.equal(renderTables(input), input);
});

test('renderTables does not convert header/separator column-count mismatches', () => {
  const input = ['a | b | c', '--- | ---', '1 | 2'].join('\n');
  assert.equal(renderTables(input), input);
});

test('renderTables truncates wide cells with an ellipsis under the width cap', () => {
  const long = 'x'.repeat(120);
  const input = ['| Col |', '| --- |', `| ${long} |`].join('\n');
  const out = renderTables(input);

  assert.ok(out.includes('…'), 'truncation marker present');
  // No rendered content row should exceed the cap budget plus borders/padding.
  const longestRow = Math.max(...out.split('\n').map((l) => l.length));
  assert.ok(longestRow <= MAX_TABLE_WIDTH + 4, `row width ${longestRow} within cap`);
});
