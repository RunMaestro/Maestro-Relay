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
 * Slack adapter configuration. Loaded lazily so a deployment that
 * disables Slack (ENABLED_PROVIDERS=discord) does not fail at startup
 * for missing SLACK_BOT_TOKEN.
 */
export const slackConfig = {
  get token() {
    return required('SLACK_BOT_TOKEN');
  },
  get signingSecret() {
    return required('SLACK_SIGNING_SECRET');
  },
  get teamId() {
    return required('SLACK_TEAM_ID');
  },
  get appId() {
    return required('SLACK_APP_ID');
  },
  get socketModeToken() {
    return process.env.SLACK_SOCKET_MODE_TOKEN || '';
  },
  get allowedUserIds() {
    return csv('SLACK_ALLOWED_USER_IDS');
  },
  get mentionUserId() {
    return process.env.SLACK_MENTION_USER_ID || '';
  },
  get publicUrl() {
    return process.env.SLACK_BOT_PUBLIC_URL || '';
  },
  get port() {
    const parsed = parseInt(process.env.SLACK_PORT ?? '', 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) return 3000;
    return parsed;
  },
};
