import http from 'http';
import type { BridgeProvider } from './types';
import { config } from './config';
import { logger } from './logger';
import { splitMessage as defaultSplit } from './splitMessage';
import { AgentNotFoundError, RateLimitError } from './errors';

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
  logger?: import('./types').KernelLogger;
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

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: object,
  headers?: Record<string, string | number>,
) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...(headers ?? {}) });
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
      if (err instanceof AgentNotFoundError) {
        sendJson(res, 404, { success: false, error: err.message });
      } else {
        const msg = (err as Error).message;
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
          if (err instanceof RateLimitError) {
            // Clamp the in-request backoff: never spin with a zero delay, and
            // never tie up the HTTP connection for more than a few seconds.
            // Larger backoffs are surfaced to the caller via Retry-After below.
            const waitMs = Math.min(Math.max(err.retryAfterMs, 100), 5000);
            await new Promise((r) => setTimeout(r, waitMs));
          } else {
            break;
          }
        }
      }
      if (lastError) {
        if (lastError instanceof RateLimitError) {
          await log.error('api', 'Rate limited by provider after 3 retries');
          // Round up to whole seconds; clamp to a minimum of 1 so we never
          // advertise a zero-second backoff that the kernel already waited
          // through and still hit the limit.
          const retryAfterSec = Math.max(1, Math.ceil(lastError.retryAfterMs / 1000));
          sendJson(
            res,
            429,
            { success: false, error: 'Rate limited, retry later' },
            { 'Retry-After': retryAfterSec },
          );
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
    void logger.error(
      'api/startup',
      err.code === 'EADDRINUSE'
        ? `API server failed to start: port ${config.apiPort} is already in use`
        : `API server error: ${err.message}`,
    );
    process.exit(1);
  });

  server.listen(config.apiPort, '127.0.0.1', () => {
    logger.info('api/startup', `API server listening on http://127.0.0.1:${config.apiPort}`);
  });

  return server;
}
