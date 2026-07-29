import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SendApiPayload {
  agentId: string;
  message: string;
  mention?: boolean;
  provider?: string;
  /**
   * Maestro session the push belongs to. Recorded against the posted messages so
   * a reply thread started on one of them continues this session.
   */
  sessionId?: string;
  /**
   * Platform user id allowed to continue `sessionId` from a reply thread on the
   * push. Omitted means the provider's configured mention user, and failing
   * that no vetted owner — a reply thread then starts a fresh session.
   */
  userId?: string;
}

export interface SendApiResult {
  success: boolean;
  channelId?: string;
  /** Platform message ids of the posted messages (providers that report them). */
  messageIds?: string[];
  error?: string;
}

export const DEFAULT_PORT = 3457;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export function postToSendApi(
  payload: SendApiPayload,
  port: number,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<SendApiResult> {
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          settle(() => {
            try {
              resolve(JSON.parse(chunks) as SendApiResult);
            } catch {
              reject(new Error('Invalid response from bot'));
            }
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      const err = new Error(`Request to bot timed out after ${timeoutMs}ms`);
      req.destroy(err);
      settle(() => reject(err));
    });

    req.on('error', (err) => {
      settle(() => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
          reject(new Error('Bot is not running or API server is not started'));
        } else {
          reject(err);
        }
      });
    });

    req.write(body);
    req.end();
  });
}

/**
 * Strictly parse a `--port` flag value into a valid TCP port number.
 * Throws an `Error` if the value is missing/blank or not an integer in 1..65535.
 */
export function parsePort(raw: string | undefined, fallback: number = DEFAULT_PORT): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  return port;
}

export async function runMaestroCli(args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync('maestro-cli', args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export function fail(message: string, code = 1): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

export function ok(result: SendApiResult): never {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}
