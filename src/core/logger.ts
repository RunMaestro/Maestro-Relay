import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from './config';

const LOG_DIR = process.env.LOG_DIR || join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'errors.log');

let dirReady = false;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function parseLevel(raw: string): number {
  const key = raw.toLowerCase() as LogLevel;
  return LEVELS[key] ?? LEVELS.info;
}

let currentLevel = parseLevel(config.logLevel);

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}

function sanitize(value: string): string {
  return value.replace(/[\r\n]+/g, '\\n');
}

/**
 * Discord bot-token shape: three base64url segments separated by dots.
 * Provider-agnostic in intent — masks anything token-shaped before it hits a sink,
 * so a leaked secret never lands in the console or `errors.log`.
 */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g;

function redactTokens(line: string): string {
  return line.replace(TOKEN_PATTERN, '[REDACTED_TOKEN]');
}

function formatEntry(level: string, context: string, detail: string): string {
  const ts = new Date().toISOString();
  return redactTokens(`[${ts}] ${level} [${sanitize(context)}] ${sanitize(detail)}\n`);
}

function shouldEmit(level: LogLevel): boolean {
  return LEVELS[level] >= currentLevel;
}

function emit(level: LogLevel, context: string, detail: string, sink: (line: string) => void) {
  if (!shouldEmit(level)) return;
  sink(formatEntry(level.toUpperCase(), context, detail).trimEnd());
}

export const logger = {
  /** Update the minimum log level at runtime (e.g. for tests or operator hot-toggle). */
  setLevel(level: LogLevel | string): void {
    currentLevel = parseLevel(level);
  },
  /** Current minimum level. */
  getLevel(): LogLevel {
    return (Object.keys(LEVELS) as LogLevel[]).find((k) => LEVELS[k] === currentLevel) ?? 'info';
  },
  /** Returns true if messages at the given level would be emitted. */
  isEnabled(level: LogLevel): boolean {
    return shouldEmit(level);
  },
  debug(context: string, detail: string): void {
    emit('debug', context, detail, (line) => console.debug(line));
  },
  info(context: string, detail: string): void {
    emit('info', context, detail, (line) => console.info(line));
  },
  warn(context: string, detail: string): void {
    emit('warn', context, detail, (line) => console.warn(line));
  },
  async error(context: string, detail: string): Promise<void> {
    if (shouldEmit('error')) console.error(formatEntry('ERROR', context, detail).trimEnd());
    try {
      await ensureDir();
      await appendFile(LOG_FILE, formatEntry('ERROR', context, detail));
    } catch {
      // If file logging fails, console.error above still ran (if enabled)
    }
  },
};
