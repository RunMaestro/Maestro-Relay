import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A synthetic string with the Discord-bot-token *shape* (three base64url segments,
 * dot-separated) that the logger's redaction regex matches. Assembled at runtime from
 * parts so the file contains no contiguous token literal — this keeps GitHub push
 * protection (and any real secret scanner) from flagging the test fixture, and the
 * parts are deliberately non-decodable to a snowflake so it can never be a real token.
 */
function makeFakeToken(a: string, b: string, c: string): string {
  return [a, b, c].join('.');
}
const FAKE_TOKEN = makeFakeToken(
  'AaAaAaAaAaAaAaAaAaAaAaAa',
  'BbBbBb',
  'CcCcCcCcCcCcCcCcCcCcCcCcCcCcCc',
);

afterEach(async () => {
  const { logger } = await import('../core/logger');
  logger.setLevel('info');
});

test('a token-shaped string is redacted and the raw token never appears', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.warn;
  const calls: string[] = [];
  console.warn = (line: string) => calls.push(line);
  try {
    logger.warn('test/ctx', `starting bot with token ${FAKE_TOKEN} now`);
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].includes('[REDACTED_TOKEN]'),
      'redaction placeholder should be present',
    );
    assert.ok(
      !calls[0].includes(FAKE_TOKEN),
      'raw token must never appear in log output',
    );
    // Surrounding context is preserved.
    assert.ok(calls[0].includes('starting bot with token'));
    assert.ok(calls[0].includes('now'));
  } finally {
    console.warn = orig;
  }
});

test('multiple token-shaped strings on one line are all redacted', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.warn;
  const calls: string[] = [];
  console.warn = (line: string) => calls.push(line);
  try {
    const second = makeFakeToken(
      'ZzZzZzZzZzZzZzZzZzZzZz',
      'DdDdDd',
      'EeEeEeEeEeEeEeEeEeEeEeEeE',
    );
    logger.warn('test/ctx', `${FAKE_TOKEN} and ${second}`);
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].includes(FAKE_TOKEN));
    assert.ok(!calls[0].includes(second));
    const matches = calls[0].match(/\[REDACTED_TOKEN\]/g) ?? [];
    assert.equal(matches.length, 2, 'both tokens should be redacted');
  } finally {
    console.warn = orig;
  }
});

test('ordinary log lines without tokens are left intact', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.info;
  const calls: string[] = [];
  console.info = (line: string) => calls.push(line);
  try {
    logger.info('test/ctx', 'nothing secret here');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('nothing secret here'));
    assert.ok(!calls[0].includes('[REDACTED_TOKEN]'));
  } finally {
    console.info = orig;
  }
});
