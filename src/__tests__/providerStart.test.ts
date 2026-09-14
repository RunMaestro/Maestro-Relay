import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLateNetworkErrorHandler,
  isTransientNetworkError,
  startProviderWithRetry,
} from '../core/providerStart';
import type { BridgeProvider, KernelContext, KernelLogger } from '../core/types';

/**
 * Regression for 2026-09-14. discord.com timed out for ten hours and the relay
 * exited on every failed start. launchd ran it 82 times, the API port stayed
 * closed, and the doctor paged an agent for a network outage. These tests pin
 * the replacement: retry a network failure in the process, fail fast on
 * anything else, and survive the late socket error that @discordjs/ws leaves
 * without a listener.
 */

function recordingLogger(): KernelLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    error: (context, detail) => {
      lines.push(`error ${context} ${detail}`);
    },
    warn: (context, detail) => {
      lines.push(`warn ${context} ${detail}`);
    },
    info: (context, detail) => {
      lines.push(`info ${context} ${detail}`);
    },
    debug: () => {},
  };
}

/** The shape undici threw on 2026-09-14. */
function connectTimeout(): Error {
  return Object.assign(
    new Error('Connect Timeout Error (attempted address: discord.com:443, timeout: 10000ms)'),
    { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
  );
}

function fakeProvider(failures: unknown[]) {
  const calls = { starts: 0, stops: 0 };
  const provider: BridgeProvider = {
    name: 'discord',
    async start() {
      calls.starts += 1;
      const next = failures.shift();
      if (next !== undefined) throw next;
    },
    async stop() {
      calls.stops += 1;
    },
    isReady: () => false,
    resolveConversation: () => null,
    send: async () => {},
    findOrCreateAgentChannel: async (agentId) => ({ channelId: 'c1', agentId, agentName: 'Agent' }),
  };
  return { provider, calls };
}

const ctx: KernelContext = { enqueue: () => {}, logger: recordingLogger() };

test('a network failure is retried in the process until the provider starts', async () => {
  const { provider, calls } = fakeProvider([
    connectTimeout(),
    new Error('Opening handshake has timed out'),
  ]);
  const waits: number[] = [];
  const logger = recordingLogger();

  const started = await startProviderWithRetry('discord', provider, ctx, {
    logger,
    delaysMs: [5, 15],
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(started, true);
  assert.equal(calls.starts, 3);
  // Each failed attempt releases its half-built client before the next one.
  assert.equal(calls.stops, 2);
  assert.deepEqual(waits, [5, 15]);
  // The doctor's upstream-unreachable signature reads "failed to start".
  assert.equal(logger.lines.filter((l) => l.includes('failed to start')).length, 2);
  // Only the first failure goes to errors.log; the rest are warnings.
  assert.equal(logger.lines.filter((l) => l.startsWith('error')).length, 1);
});

test('the last backoff step repeats for as long as the outage lasts', async () => {
  const { provider } = fakeProvider([
    connectTimeout(),
    connectTimeout(),
    connectTimeout(),
    connectTimeout(),
  ]);
  const waits: number[] = [];

  await startProviderWithRetry('discord', provider, ctx, {
    logger: recordingLogger(),
    delaysMs: [1, 2],
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  assert.deepEqual(waits, [1, 2, 2, 2]);
});

test('a configuration failure is not retried and rejects at once, as before', async () => {
  const badToken = Object.assign(new Error('An invalid token was provided.'), {
    code: 'TokenInvalid',
  });
  const { provider, calls } = fakeProvider([badToken]);
  let slept = false;

  await assert.rejects(
    startProviderWithRetry('discord', provider, ctx, {
      logger: recordingLogger(),
      sleep: async () => {
        slept = true;
      },
    }),
    /invalid token/,
  );
  assert.equal(calls.starts, 1);
  assert.equal(slept, false);
});

test('shutdown ends the retry loop instead of waiting on the network', async () => {
  const { provider, calls } = fakeProvider([connectTimeout(), connectTimeout()]);
  let stopping = false;

  const started = await startProviderWithRetry('discord', provider, ctx, {
    logger: recordingLogger(),
    delaysMs: [1],
    sleep: async () => {
      stopping = true;
    },
    shouldStop: () => stopping,
  });

  assert.equal(started, false);
  assert.equal(calls.starts, 1);
});

test('network errors are recognised in the shapes the relay has actually logged', () => {
  assert.equal(isTransientNetworkError(connectTimeout()), true);
  assert.equal(isTransientNetworkError(new Error('Opening handshake has timed out')), true);
  const refused = Object.assign(new Error('connect ECONNREFUSED 162.159.135.232:443'), {
    code: 'ECONNREFUSED',
  });
  assert.equal(isTransientNetworkError(Object.assign(new TypeError('fetch failed'), { cause: refused })), true);
  assert.equal(
    isTransientNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND discord.com'), { code: 'ENOTFOUND' })),
    true,
  );

  assert.equal(
    isTransientNetworkError(Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' })),
    false,
  );
  assert.equal(isTransientNetworkError(new TypeError("Cannot read properties of undefined (reading 'id')")), false);
  assert.equal(isTransientNetworkError(new TypeError('fetch failed')), false);
  assert.equal(isTransientNetworkError(undefined), false);
});

test('a late socket error from a discarded connection does not kill the relay', () => {
  const logger = recordingLogger();
  let exitCode: number | null = null;
  const handler = createLateNetworkErrorHandler(logger, (code) => {
    exitCode = code;
  });

  handler(new Error('Opening handshake has timed out'));

  assert.equal(exitCode, null);
  assert.ok(logger.lines.some((l) => l.startsWith('warn bridge/network')));
});

test('any other uncaught exception still exits non-zero', async () => {
  const logger = recordingLogger();
  let exitCode: number | null = null;
  const handler = createLateNetworkErrorHandler(logger, (code) => {
    exitCode = code;
  });

  handler(new TypeError('boom'));
  await new Promise((done) => setImmediate(done));

  assert.equal(exitCode, 1);
  assert.ok(logger.lines.some((l) => l.startsWith('error bridge/fatal') && l.includes('boom')));
});
