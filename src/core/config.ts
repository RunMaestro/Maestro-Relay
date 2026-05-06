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
};
