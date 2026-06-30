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
 * Teams adapter configuration. Loaded lazily so a deployment that
 * disables Teams (ENABLED_PROVIDERS=discord) does not fail at startup
 * for missing TEAMS_APP_ID.
 */
export const teamsConfig = {
  get appId() {
    return required('TEAMS_APP_ID');
  },
  get appPassword() {
    return required('TEAMS_APP_PASSWORD');
  },
  get appType() {
    return process.env.TEAMS_APP_TYPE || 'SingleTenant';
  },
  get tenantId() {
    return required('TEAMS_TENANT_ID');
  },
  get port() {
    const parsed = parseInt(process.env.TEAMS_PORT ?? '', 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) return 3978;
    return parsed;
  },
  get publicUrl() {
    return process.env.TEAMS_PUBLIC_URL || '';
  },
  get allowedUserIds() {
    return csv('TEAMS_ALLOWED_USER_IDS');
  },
  get mentionUserId() {
    return process.env.TEAMS_MENTION_USER_ID || '';
  },
};
