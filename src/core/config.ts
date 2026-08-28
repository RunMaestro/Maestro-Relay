import dotenv from 'dotenv';
dotenv.config();

export function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

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
function positiveIntEnv(key: string, fallback: number, min: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  // Number(), not parseInt(): parseInt('2m') is 2, which would silently set a
  // two-millisecond window and turn every message into its own agent turn.
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[config] ${key}=${JSON.stringify(raw)} is not a positive number; using ${fallback}`);
    return fallback;
  }
  const clamped = Math.max(min, Math.trunc(parsed));
  if (clamped !== Math.trunc(parsed)) {
    console.warn(`[config] ${key}=${raw} is below the minimum of ${min}; using ${clamped}`);
  }
  return clamped;
}

export const ambientConfig = {
  get windowMs(): number {
    return positiveIntEnv('AMBIENT_WINDOW_MS', 20_000, 1_000);
  },
  get maxBatch(): number {
    return positiveIntEnv('AMBIENT_MAX_BATCH', 25, 1);
  },
  get maxWaitMs(): number {
    return positiveIntEnv('AMBIENT_MAX_WAIT_MS', 120_000, 5_000);
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
};
