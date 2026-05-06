import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

const LOG_DIR = process.env.LOG_DIR || join(process.cwd(), 'logs');
const LOG_FILE = join(LOG_DIR, 'errors.log');

let dirReady = false;

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}

function sanitize(value: string): string {
  return value.replace(/[\r\n]+/g, '\\n');
}

function formatEntry(level: string, context: string, detail: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] ${level} [${sanitize(context)}] ${sanitize(detail)}\n`;
}

export const logger = {
  async error(context: string, detail: string): Promise<void> {
    const line = formatEntry('ERROR', context, detail);
    console.error(line.trimEnd());
    try {
      await ensureDir();
      await appendFile(LOG_FILE, line);
    } catch {
      // If file logging fails, console.error above still ran
    }
  },
};
