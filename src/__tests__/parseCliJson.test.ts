import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliJson } from '../core/maestro';

// maestro-cli logs some subsystems through console.info, which Node writes to
// stdout. The bundled WakaTime tracker does this on every invocation, so the
// JSON payload can arrive behind an arbitrary number of log lines.
const WAKATIME_NOISE = [
  '[2026-08-27T02:38:08.926Z] [INFO] [[WakaTime]] Downloading WakaTime CLI from https://example/x.zip ',
  '[2026-08-27T02:38:09.544Z] [INFO] [[WakaTime]] WakaTime CLI installed successfully ',
].join('\n');

test('parseCliJson parses clean JSON objects', () => {
  assert.deepEqual(parseCliJson<{ a: number }>('{"a":1}'), { a: 1 });
});

test('parseCliJson parses clean JSON arrays', () => {
  assert.deepEqual(parseCliJson<number[]>('[1,2,3]'), [1, 2, 3]);
});

test('parseCliJson skips log lines printed ahead of an object payload', () => {
  const raw = `${WAKATIME_NOISE}\n{\n  "agentId": "abc",\n  "response": "hi"\n}`;
  assert.deepEqual(parseCliJson<{ agentId: string; response: string }>(raw), {
    agentId: 'abc',
    response: 'hi',
  });
});

test('parseCliJson skips log lines printed ahead of an array payload', () => {
  const raw = `${WAKATIME_NOISE}\n[{"id":"a"}]`;
  assert.deepEqual(parseCliJson<Array<{ id: string }>>(raw), [{ id: 'a' }]);
});

test('parseCliJson does not mistake a bracketed log line for the payload', () => {
  // The log lines themselves start with '[', so a naive scan for the first
  // bracket would try to parse the timestamp as an array element.
  const raw = `[2026-08-27T02:38:08.926Z] [INFO] noise\n{"ok":true}`;
  assert.deepEqual(parseCliJson<{ ok: boolean }>(raw), { ok: true });
});

test('parseCliJson rethrows the original parse error when no payload is present', () => {
  assert.throws(() => parseCliJson(WAKATIME_NOISE), SyntaxError);
});
