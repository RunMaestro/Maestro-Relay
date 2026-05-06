import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { ApiDeps } from '../core/api';
import type { BridgeProvider } from '../core/types';

const mod: {
  createServerHandler?: typeof import('../core/api').createServerHandler;
  parseBody?: typeof import('../core/api').parseBody;
} = {};

before(async () => {
  process.env.DISCORD_BOT_TOKEN = 'test-token';
  process.env.DISCORD_CLIENT_ID = 'test-client';
  process.env.DISCORD_GUILD_ID = 'test-guild';
  const imported = await import('../core/api');
  mod.createServerHandler = imported.createServerHandler;
  mod.parseBody = imported.parseBody;
});

interface MockProviderOpts {
  ready?: boolean;
  agentName?: string;
  channelId?: string;
  /** if set, throw when findOrCreateAgentChannel is called */
  findThrows?: Error;
  /** capture sent messages */
  sentMessages?: string[];
}

function makeProvider(name: string, opts: MockProviderOpts = {}): BridgeProvider {
  const sent = opts.sentMessages ?? [];
  return {
    name,
    isReady: () => opts.ready !== false,
    async start() {},
    async stop() {},
    resolveConversation: () => null,
    send: async (_target, msg) => {
      sent.push(msg.mention ? `<@MENTION> ${msg.text}` : msg.text);
    },
    findOrCreateAgentChannel: async (agentId) => {
      if (opts.findThrows) throw opts.findThrows;
      return {
        channelId: opts.channelId ?? 'ch-1',
        agentId,
        agentName: opts.agentName ?? 'Test',
      };
    },
  };
}

function makeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    providers: new Map([['discord', makeProvider('discord')]]),
    splitMessage: (s: string) => [s],
    logger: { error: async () => undefined },
    ...overrides,
  };
}

function request(
  server: http.Server,
  options: { method: string; path: string; body?: object; contentType?: string },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = options.body ? JSON.stringify(options.body) : undefined;
    const ct = options.contentType ?? (payload ? 'application/json' : undefined);
    const headers: Record<string, string | number> = {};
    if (ct) headers['Content-Type'] = ct;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: options.path,
        method: options.method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startTestServer(deps: ApiDeps): Promise<http.Server> {
  const handler = mod.createServerHandler!(deps);
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// --- Health endpoint ---

test('GET /api/health returns 200 when at least one provider is ready', async () => {
  const server = await startTestServer(makeDeps());
  try {
    const res = await request(server, { method: 'GET', path: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, 'ok');
    assert.equal(typeof res.body.uptime, 'number');
    assert.deepEqual(res.body.providers, { discord: true });
  } finally {
    server.close();
  }
});

test('GET /api/health returns 503 when no providers are ready', async () => {
  const server = await startTestServer(
    makeDeps({
      providers: new Map([['discord', makeProvider('discord', { ready: false })]]),
    }),
  );
  try {
    const res = await request(server, { method: 'GET', path: '/api/health' });
    assert.equal(res.status, 503);
    assert.equal(res.body.success, false);
    assert.equal(res.body.status, 'not_ready');
  } finally {
    server.close();
  }
});

test('POST /api/health returns 405', async () => {
  const server = await startTestServer(makeDeps());
  try {
    const res = await request(server, { method: 'POST', path: '/api/health', body: {} });
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});

// --- Unknown route ---

test('unknown route returns 404', async () => {
  const server = await startTestServer(makeDeps());
  try {
    const res = await request(server, { method: 'GET', path: '/api/unknown' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

// --- Send endpoint ---

test('GET /api/send returns 405', async () => {
  const server = await startTestServer(makeDeps());
  try {
    const res = await request(server, { method: 'GET', path: '/api/send' });
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});

test('POST /api/send returns 503 when provider is not ready', async () => {
  const server = await startTestServer(
    makeDeps({
      providers: new Map([['discord', makeProvider('discord', { ready: false })]]),
    }),
  );
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/send',
      body: { agentId: 'a-1', message: 'hi' },
    });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /not connected/);
  } finally {
    server.close();
  }
});

test('POST /api/send returns 400 for missing fields', async () => {
  const server = await startTestServer(makeDeps());
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/send',
      body: { agentId: 'a-1' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /required/);
  } finally {
    server.close();
  }
});

test('POST /api/send returns 200 on success and routes to default discord provider', async () => {
  const sent: string[] = [];
  const server = await startTestServer(
    makeDeps({
      providers: new Map([['discord', makeProvider('discord', { sentMessages: sent })]]),
    }),
  );
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/send',
      body: { agentId: 'a-1', message: 'hello' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.channelId, 'ch-1');
    assert.deepEqual(sent, ['hello']);
  } finally {
    server.close();
  }
});

test('POST /api/send forwards mention=true to the provider on the first part only', async () => {
  const sent: string[] = [];
  const server = await startTestServer(
    makeDeps({
      providers: new Map([['discord', makeProvider('discord', { sentMessages: sent })]]),
      // Force a multi-part split so we can verify mention only applies to part 0.
      splitMessage: () => ['part-0', 'part-1'],
    }),
  );
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/send',
      body: { agentId: 'a-1', message: 'done', mention: true },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(sent, ['<@MENTION> part-0', 'part-1']);
  } finally {
    server.close();
  }
});

test('POST /api/send routes to the named provider when supplied', async () => {
  const discordSent: string[] = [];
  const slackSent: string[] = [];
  const server = await startTestServer(
    makeDeps({
      providers: new Map([
        ['discord', makeProvider('discord', { sentMessages: discordSent })],
        ['slack', makeProvider('slack', { sentMessages: slackSent })],
      ]),
    }),
  );
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/send',
      body: { agentId: 'a-1', message: 'hello slack', provider: 'slack' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(slackSent, ['hello slack']);
    assert.deepEqual(discordSent, []);
  } finally {
    server.close();
  }
});

test('POST /api/send returns 400 for an unknown provider', async () => {
  const server = await startTestServer(makeDeps());
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/send',
      body: { agentId: 'a-1', message: 'hi', provider: 'matrix' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unknown or disabled provider/);
  } finally {
    server.close();
  }
});

test('POST /api/send returns 404 for unknown agent', async () => {
  const server = await startTestServer(
    makeDeps({
      providers: new Map([
        [
          'discord',
          makeProvider('discord', { findThrows: new Error('Agent not found: missing') }),
        ],
      ]),
    }),
  );
  try {
    const res = await request(server, {
      method: 'POST',
      path: '/api/send',
      body: { agentId: 'missing', message: 'hi' },
    });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Agent not found/);
  } finally {
    server.close();
  }
});

test('POST /api/send returns 415 for wrong content type', async () => {
  const server = await startTestServer(makeDeps());
  try {
    const addr = server.address() as { port: number };
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: '/api/send',
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      req.write('not json');
      req.end();
    });
    assert.equal(res.status, 415);
  } finally {
    server.close();
  }
});

// --- parseBody ---

test('parseBody rejects invalid JSON', async () => {
  const { Readable } = await import('node:stream');
  const req = new Readable({
    read() {
      this.push('not json');
      this.push(null);
    },
  }) as any;
  req.headers = {};
  req.destroy = () => {};
  await assert.rejects(mod.parseBody!(req), /Invalid JSON/);
});
