import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `LOG_DIR` is captured when core/logger is first loaded, so it has to be set
// before the first dynamic import below — not inside a test body.
const TMP_LOG_DIR = mkdtempSync(join(tmpdir(), 'relay-logger-redaction-'));
process.env.LOG_DIR = TMP_LOG_DIR;

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

/**
 * One synthetic credential per provider the relay ships or plans to ship, each
 * assembled from parts for the same secret-scanner reason as `FAKE_TOKEN`.
 * These are shapes, not live values.
 */
const PROVIDER_FIXTURES: Record<string, string> = {
  'slack bot (xoxb)': ['xoxb', '1234567890', '1234567890123', 'abcdefghijklmnopqrstuvwx'].join('-'),
  'slack user (xoxp)': ['xoxp', '1234567890', '1234567890123', 'abcdefghijklmnop'].join('-'),
  'slack app-level (xapp)': [
    'xapp',
    '1',
    'A0123456789',
    '1234567890123',
    'abcdefghijklmnopqrstuvwxyz',
  ].join('-'),
  'telegram bot': ['123456789', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'].join(':'),
  'github pat (ghp_)': 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  'github fine-grained': 'github_pat_' + '11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789',
};

/**
 * Log content that merely *looks* structured and must survive untouched. A
 * redactor that eats snowflake ids or file paths makes the logs useless, which
 * is the failure mode that gets redaction turned off entirely.
 */
const BENIGN_LINES: Record<string, string> = {
  'agent/session pairs': 'agent=agent-1 session=session-1 channel=chan-1 error=timeout',
  'module path': 'some.module.name',
  'discord snowflakes': 'channel=1234567890123456789 user=9876543210987654321',
  'clock time and ratio': 'took 12:30 and 1234567:89',
  'file path': '/home/chris/code/Maestro-Relay/src/core/logger.ts',
  'api url': 'https://api.github.com/repos/RunMaestro/Maestro-Relay/pulls/73',
  semver: 'v0.4.1-rc.2',
  'session uuid': 'session=2dc65f8f-6b38-44bb-ac5c-296d1f72a1ea',
  'gist url': 'https://gist.github.com/chr1syy/a1b2c3d4e5f6a7b8c9d0',
  'nested error': 'Error: ENOENT: no such file or directory, open ok',
};

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
    assert.ok(calls[0].includes('[REDACTED_TOKEN]'), 'redaction placeholder should be present');
    assert.ok(!calls[0].includes(FAKE_TOKEN), 'raw token must never appear in log output');
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
    const second = makeFakeToken('ZzZzZzZzZzZzZzZzZzZzZz', 'DdDdDd', 'EeEeEeEeEeEeEeEeEeEeEeEeE');
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

test('the errors.log sink is redacted too, not just the console', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.error;
  console.error = () => {};
  try {
    await logger.error('test/ctx', `writing ${FAKE_TOKEN} to disk`);
  } finally {
    console.error = orig;
  }

  // The file sink is the one that persists a leaked secret past process exit,
  // so it is worth asserting separately from the console sinks above.
  const written = readFileSync(join(TMP_LOG_DIR, 'errors.log'), 'utf8');
  assert.ok(written.includes('[REDACTED_TOKEN]'), 'placeholder should reach the file');
  assert.ok(!written.includes(FAKE_TOKEN), 'raw token must never be written to errors.log');
  assert.ok(written.includes('writing'), 'surrounding context should survive');

  rmSync(TMP_LOG_DIR, { recursive: true, force: true });
});

test('every shipped provider credential shape is redacted', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.warn;
  for (const [label, secret] of Object.entries(PROVIDER_FIXTURES)) {
    const calls: string[] = [];
    console.warn = (line: string) => calls.push(line);
    try {
      logger.warn('test/ctx', `connecting with ${secret} now`);
    } finally {
      console.warn = orig;
    }
    assert.equal(calls.length, 1, `${label}: expected one log line`);
    assert.ok(!calls[0].includes(secret), `${label}: raw credential must not appear`);
    assert.ok(calls[0].includes('[REDACTED_TOKEN]'), `${label}: should be redacted`);
    assert.ok(calls[0].includes('connecting with'), `${label}: context should survive`);
  }
});

test('structured but non-secret log content is never redacted', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.info;
  for (const [label, line] of Object.entries(BENIGN_LINES)) {
    const calls: string[] = [];
    console.info = (l: string) => calls.push(l);
    try {
      logger.info('test/ctx', line);
    } finally {
      console.info = orig;
    }
    assert.equal(calls.length, 1, `${label}: expected one log line`);
    assert.ok(!calls[0].includes('[REDACTED_TOKEN]'), `${label}: must not be treated as a secret`);
    assert.ok(calls[0].includes(line), `${label}: content should pass through verbatim`);
  }
});

test('the same line redacts identically on repeated calls (no lastIndex drift)', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.warn;
  const calls: string[] = [];
  console.warn = (line: string) => calls.push(line);
  try {
    // Module-level /g regexes carry `lastIndex` between calls. Without a reset,
    // the second pass over an identical line can start mid-string and miss.
    for (let i = 0; i < 3; i++) logger.warn('test/ctx', `token ${FAKE_TOKEN} here`);
  } finally {
    console.warn = orig;
  }
  assert.equal(calls.length, 3);
  for (const [i, line] of calls.entries()) {
    assert.ok(!line.includes(FAKE_TOKEN), `call ${i + 1} leaked the raw token`);
    assert.ok(line.includes('[REDACTED_TOKEN]'), `call ${i + 1} was not redacted`);
  }
});
