import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const mod: { logger?: typeof import('../core/logger').logger } = {};

test('logger is a singleton with the expected surface', async () => {
  mod.logger = (await import('../core/logger')).logger;
  assert.equal(typeof mod.logger!.debug, 'function');
  assert.equal(typeof mod.logger!.info, 'function');
  assert.equal(typeof mod.logger!.warn, 'function');
  assert.equal(typeof mod.logger!.error, 'function');
  assert.equal(typeof mod.logger!.setLevel, 'function');
  assert.equal(typeof mod.logger!.isEnabled, 'function');
  assert.equal(typeof mod.logger!.getLevel, 'function');
});

afterEach(() => {
  mod.logger?.setLevel('info');
});

test('default level is info', async () => {
  const { logger } = await import('../core/logger');
  assert.equal(logger.getLevel(), 'info');
  assert.equal(logger.isEnabled('debug'), false);
  assert.equal(logger.isEnabled('info'), true);
  assert.equal(logger.isEnabled('warn'), true);
  assert.equal(logger.isEnabled('error'), true);
});

test('setLevel changes the gate', async () => {
  const { logger } = await import('../core/logger');
  logger.setLevel('warn');
  assert.equal(logger.isEnabled('debug'), false);
  assert.equal(logger.isEnabled('info'), false);
  assert.equal(logger.isEnabled('warn'), true);
  assert.equal(logger.isEnabled('error'), true);
  logger.setLevel('debug');
  assert.equal(logger.isEnabled('debug'), true);
  assert.equal(logger.isEnabled('info'), true);
  logger.setLevel('error');
  assert.equal(logger.isEnabled('debug'), false);
  assert.equal(logger.isEnabled('info'), false);
  assert.equal(logger.isEnabled('warn'), false);
  assert.equal(logger.isEnabled('error'), true);
});

test('unknown levels fall back to info', async () => {
  const { logger } = await import('../core/logger');
  logger.setLevel('bogus');
  assert.equal(logger.getLevel(), 'info');
});

test('level-gated methods do not emit when disabled', async () => {
  const { logger } = await import('../core/logger');
  const origDebug = console.debug;
  const origInfo = console.info;
  const origWarn = console.warn;
  const debugCalls: string[] = [];
  const infoCalls: string[] = [];
  const warnCalls: string[] = [];
  console.debug = (line: string) => debugCalls.push(line);
  console.info = (line: string) => infoCalls.push(line);
  console.warn = (line: string) => warnCalls.push(line);
  try {
    logger.setLevel('warn');
    logger.debug('test/ctx', 'debug-detail');
    logger.info('test/ctx', 'info-detail');
    logger.warn('test/ctx', 'warn-detail');
    assert.equal(debugCalls.length, 0, 'debug should be suppressed at warn level');
    assert.equal(infoCalls.length, 0, 'info should be suppressed at warn level');
    assert.equal(warnCalls.length, 1, 'warn should pass at warn level');
    assert.match(warnCalls[0], /\[WARN\] \[test\/ctx\] warn-detail/);
  } finally {
    console.debug = origDebug;
    console.info = origInfo;
    console.warn = origWarn;
  }
});

test('debug emits when level is debug', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.debug;
  const calls: string[] = [];
  console.debug = (line: string) => calls.push(line);
  try {
    logger.setLevel('debug');
    logger.debug('test/ctx', 'detail');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[DEBUG\] \[test\/ctx\] detail/);
  } finally {
    console.debug = orig;
  }
});

test('error always emits at any level that includes error', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.error;
  const calls: string[] = [];
  console.error = (line: string) => calls.push(line);
  try {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      logger.setLevel(level);
      calls.length = 0;
      await logger.error('test/ctx', 'err-detail');
      assert.equal(calls.length, 1, `error should fire at level=${level}`);
      assert.match(calls[0], /\[ERROR\] \[test\/ctx\] err-detail/);
    }
  } finally {
    console.error = orig;
  }
});

test('log lines are sanitized to keep them single-line', async () => {
  const { logger } = await import('../core/logger');
  const orig = console.error;
  const calls: string[] = [];
  console.error = (line: string) => calls.push(line);
  try {
    await logger.error('test/ctx', 'line one\nline two\rline three');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].includes('\n'), 'log line should not contain raw newlines');
    assert.ok(!calls[0].includes('\r'), 'log line should not contain raw carriage returns');
  } finally {
    console.error = orig;
  }
});
