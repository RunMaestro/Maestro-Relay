import dotenv from 'dotenv';
import type { SusFactorMode } from './susfactor';
dotenv.config();

export function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

const SUSFACTOR_MODES: SusFactorMode[] = ['off', 'log', 'flag', 'block'];

function optionalFloat(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const val = Number(raw);
  if (!Number.isFinite(val)) throw new Error(`${key} must be a number (got "${raw}")`);
  return val;
}

function positiveInt(key: string, fallback: number, min = 1): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const val = Number(raw);
  if (!Number.isInteger(val) || val < min) {
    throw new Error(`${key} must be an integer >= ${min} (got "${raw}")`);
  }
  return val;
}

/**
 * Floor for SUSFACTOR_MAX_CHARS. A sample smaller than this carries too little
 * of the prompt to classify, so accepting it would leave screening switched on
 * but blind — the failure mode the startup checks exist to prevent.
 */
const MIN_SUSFACTOR_MAX_CHARS = 256;

function csv(key: string): string[] {
  const val = process.env[key];
  if (!val) return [];
  return val
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Ambient-mode tuning. These are process-wide; whether ambient is actually on
 * is a per-channel flag in the database, set with `/agents ambient`.
 *
 * The window is the one number worth thinking about. Too short and the agent
 * answers half a thought; too long and it feels absent from the conversation.
 * Twenty seconds is a compromise that reads as "waited for a pause".
 */
export const ambientConfig = {
  get windowMs(): number {
    return parseInt(process.env.AMBIENT_WINDOW_MS || '20000', 10);
  },
  get maxBatch(): number {
    return parseInt(process.env.AMBIENT_MAX_BATCH || '25', 10);
  },
  get maxWaitMs(): number {
    return parseInt(process.env.AMBIENT_MAX_WAIT_MS || '120000', 10);
  },
};

/**
 * Provider-neutral kernel configuration. Each provider adapter loads its
 * own platform credentials (DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN, ...) on
 * `start()` so missing creds for a disabled provider don't fail the bot.
 */
export const config = {
  /** Comma-separated list of provider names to enable, e.g. `discord` or `discord,slack`. */
  get enabledProviders(): string[] {
    const raw = csv('ENABLED_PROVIDERS');
    return raw.length > 0 ? raw : ['discord'];
  },
  get apiPort() {
    return parseInt(process.env.API_PORT || '3457', 10);
  },
  get ffmpegPath() {
    return process.env.FFMPEG_PATH || 'ffmpeg';
  },
  get whisperCliPath() {
    return process.env.WHISPER_CLI_PATH || 'whisper-cli';
  },
  get whisperModelPath() {
    return process.env.WHISPER_MODEL_PATH || 'models/ggml-base.en.bin';
  },
  get whisperLanguage() {
    return process.env.WHISPER_LANGUAGE || 'auto';
  },
  /**
   * Minimum log level for console output. One of `debug`, `info`, `warn`,
   * `error`. Defaults to `info`. Console output for every level (including
   * `error`) is gated by this level, but `error` always appends to the log
   * file regardless of level.
   */
  get logLevel(): string {
    return (process.env.LOG_LEVEL || 'info').toLowerCase();
  },
  /**
   * SusFactor (0din.ai) prompt screening. Off unless `SUSFACTOR_MODE` is set,
   * so existing installs are unaffected.
   */
  get susFactor() {
    const raw = (process.env.SUSFACTOR_MODE || 'off').trim().toLowerCase();
    if (!SUSFACTOR_MODES.includes(raw as SusFactorMode)) {
      throw new Error(`SUSFACTOR_MODE must be one of ${SUSFACTOR_MODES.join('|')} (got "${raw}")`);
    }
    return {
      mode: raw as SusFactorMode,
      apiToken: process.env.SUSFACTOR_API_TOKEN || '',
      threshold: optionalFloat('SUSFACTOR_THRESHOLD'),
      timeoutMs: positiveInt('SUSFACTOR_TIMEOUT_MS', 8000),
      failOpen: (process.env.SUSFACTOR_FAIL_OPEN || 'true').trim().toLowerCase() !== 'false',
      maxChars: positiveInt('SUSFACTOR_MAX_CHARS', 8000, MIN_SUSFACTOR_MAX_CHARS),
      tokenUrl: process.env.SUSFACTOR_TOKEN_URL || undefined,
      susUrl: process.env.SUSFACTOR_SUS_URL || undefined,
    };
  },
};
