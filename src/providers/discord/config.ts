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
 * Discord adapter configuration. Loaded lazily so a deployment that
 * disables Discord (ENABLED_PROVIDERS=slack) does not fail at startup
 * for missing DISCORD_BOT_TOKEN.
 */
export const discordConfig = {
  get token() {
    return required('DISCORD_BOT_TOKEN');
  },
  get clientId() {
    return required('DISCORD_CLIENT_ID');
  },
  get guildId() {
    return required('DISCORD_GUILD_ID');
  },
  get allowedUserIds() {
    return csv('DISCORD_ALLOWED_USER_IDS');
  },
  /**
   * Users who may run read-only commands but not ones that make an agent
   * execute something. Empty by default, which reproduces the previous
   * single-list behavior exactly.
   */
  get viewerUserIds() {
    return csv('DISCORD_VIEWER_USER_IDS');
  },
  get mentionUserId() {
    return process.env.DISCORD_MENTION_USER_ID || '';
  },
};
