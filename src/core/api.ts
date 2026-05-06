import http from 'http';
import type { BridgeProvider } from './types';
import { config } from './config';
import { logger } from './logger';
import { splitMessage as defaultSplit } from './splitMessage';

export interface SendRequest {
  agentId: string;
  message: string;
  mention?: boolean;
  /** Optional provider name; defaults to 'discord' for back-compat. */
  provider?: string;
}

export type ApiDeps = {
  /** Map provider-name → BridgeProvider instance. */
  providers: Map<string, BridgeProvider>;
  splitMessage?: (text: string) => string[];
  logger?: { error(...args: unknown[]): unknown };
};

const MAX_BODY_SIZE = 1_048_576; // 1 MB

export function parseBody(req: http.IncomingMessage): Promise<SendRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(JSON.parse(body) as SendRequest);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function createServerHandler(deps: ApiDeps) {
  const split = deps.splitMessage ?? defaultSplit;
  const log = deps.logger ?? logger;

  async function handleSend(req: http.IncomingMessage, res: http.ServerResponse) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 415, { success: false, error: 'Content-Type must be application/json' });
      return;
    }

    let body: SendRequest;
    try {
      body = await parseBody(req);
    } catch (err) {
      const message = (err as Error).message;
      const status = message === 'Request body too large' ? 413 : 400;
      sendJson(res, status, { success: false, error: message });
      return;
    }

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.agentId !== 'string' ||
      body.agentId.trim() === '' ||
      typeof body.message !== 'string' ||
      body.message.trim() === ''
    ) {
      sendJson(res, 400, {
        success: false,
        error: 'agentId and message are required non-empty strings',
      });
      return;
    }

    const providerName = body.provider ?? 'discord';
    const provider = deps.providers.get(providerName);
    if (!provider) {
      sendJson(res, 400, {
        success: false,
        error: `Unknown or disabled provider: ${providerName}`,
      });
      return;
    }
    if (!provider.isReady()) {
      await log.error('api', `Provider not ready: ${providerName}`);
      sendJson(res, 503, {
        success: false,
        error: `Provider ${providerName} is not connected`,
      });
      return;
    }

    let info;
    try {
      info = await provider.findOrCreateAgentChannel(body.agentId);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('Agent not found:')) {
        sendJson(res, 404, { success: false, error: msg });
      } else {
        await log.error('api/findOrCreateAgentChannel', msg);
        sendJson(res, 500, { success: false, error: msg });
      }
      return;
    }

    const target = { provider: providerName, channelId: info.channelId };
    const parts = split(body.message);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Mention only on the first part; provider decides how to render.
          await provider.send(target, { text: part, mention: i === 0 && !!body.mention });
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err as Error;
          const discordErr = err as { status?: number; retryAfter?: number };
          const isRateLimited = discordErr.status === 429 || discordErr.retryAfter != null;
          if (isRateLimited) {
            const delay = discordErr.retryAfter ?? 1000;
            await new Promise((r) => setTimeout(r, delay));
          } else {
            break;
          }
        }
      }
      if (lastError) {
        const discordErr = lastError as Error & { status?: number; retryAfter?: number };
        const isRateLimited = discordErr.status === 429 || discordErr.retryAfter != null;
        if (isRateLimited) {
          await log.error('api', 'Rate limited by provider after 3 retries');
          sendJson(res, 429, { success: false, error: 'Rate limited, retry later' });
        } else {
          await log.error('api', lastError.message);
          sendJson(res, 500, { success: false, error: lastError.message });
        }
        return;
      }
    }

    sendJson(res, 200, { success: true, channelId: info.channelId });
  }

  return function handler(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url || '';

    if (url === '/api/health') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      const ready = [...deps.providers.values()].some((p) => p.isReady());
      const providers: Record<string, boolean> = {};
      for (const [name, p] of deps.providers) providers[name] = p.isReady();
      sendJson(res, ready ? 200 : 503, {
        success: ready,
        status: ready ? 'ok' : 'not_ready',
        uptime: process.uptime(),
        providers,
      });
      return;
    }

    if (url === '/api/send') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }
      handleSend(req, res).catch(async (err) => {
        const msg = (err as Error).message || 'Internal server error';
        await log.error('api/unhandled', msg);
        sendJson(res, 500, { success: false, error: msg });
      });
      return;
    }

    sendJson(res, 404, { success: false, error: 'Not found' });
  };
}

export function startServer(providers: Map<string, BridgeProvider>): http.Server {
  const handler = createServerHandler({ providers });

  const server = http.createServer(handler);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`API server failed to start: port ${config.apiPort} is already in use`);
    } else {
      console.error('API server error:', err.message);
    }
    process.exit(1);
  });

  server.listen(config.apiPort, '127.0.0.1', () => {
    console.log(`API server listening on http://127.0.0.1:${config.apiPort}`);
  });

  return server;
}
