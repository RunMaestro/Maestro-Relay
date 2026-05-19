import { required } from '../../core/config';

function csv(key: string): string[] {
  const val = process.env[key];
  if (!val) return [];
  return val
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Telegram adapter configuration. Loaded lazily so a deployment that
 * disables Telegram (ENABLED_PROVIDERS=discord) does not fail at startup
 * for missing TELEGRAM_BOT_TOKEN.
 */
export const telegramConfig = {
  get token() {
    return required('TELEGRAM_BOT_TOKEN');
  },
  get chatId() {
    return required('TELEGRAM_CHAT_ID');
  },
  get agentId() {
    return required('TELEGRAM_AGENT_ID');
  },
  get allowedUserIds() {
    return csv('TELEGRAM_ALLOWED_USER_IDS');
  },
  get mentionUserId() {
    return process.env.TELEGRAM_MENTION_USER_ID || '';
  },
};
