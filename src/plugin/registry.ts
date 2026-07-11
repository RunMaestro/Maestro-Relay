/**
 * Persistent state and configuration for the relay plugin, backed by the
 * brokered SDK. Replaces the Node service's `better-sqlite3` registry and `.env`.
 *
 * - **Channel -> agent bindings** and **bot tokens** live in the plugin's private
 *   `storage` KV (isolated per plugin id, string values, purged on uninstall).
 * - **Non-secret configuration** (enabled providers, ids, allow-lists) lives in
 *   plugin `settings` and is READ-ONLY from here: the host confines `settings.set`
 *   to `plugins.<id>.*` and the panel/host owns writes.
 *
 * Grounded in Maestro host 1.12.0 (`plugin-host-handlers.ts` storage/settings
 * handlers). Storage values must be strings, so structured data is JSON-encoded.
 */

import type { MaestroSdk } from './sdk';

const BINDINGS_KEY = 'relay:bindings';
const SECRET_PREFIX = 'relay:secret:';

/** Map of `provider:channelId` -> Maestro agent id. */
export interface Bindings {
  [conversationKey: string]: string;
}

export interface DiscordConfig {
  clientId: string;
  guildId: string;
  allowedUserIds: string[];
}

export interface SlackConfig {
  teamId: string;
  appId: string;
  allowedUserIds: string[];
}

export interface RelayConfig {
  enabledProviders: string[];
  logLevel: string;
  discord: DiscordConfig;
  slack: SlackConfig;
}

/** Stable key for a conversation binding across providers. */
export function conversationKey(provider: string, channelId: string): string {
  return `${provider}:${channelId}`;
}

function parseBindings(raw: string | null): Bindings {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Bindings;
    }
  } catch {
    // Corrupt payload: start clean rather than crash the router.
  }
  return {};
}

export async function loadBindings(sdk: MaestroSdk): Promise<Bindings> {
  return parseBindings(await sdk.storage.get(BINDINGS_KEY));
}

export async function getBinding(sdk: MaestroSdk, key: string): Promise<string | undefined> {
  const bindings = await loadBindings(sdk);
  const agentId = bindings[key];
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : undefined;
}

export async function setBinding(sdk: MaestroSdk, key: string, agentId: string): Promise<void> {
  const bindings = await loadBindings(sdk);
  bindings[key] = agentId;
  await sdk.storage.set(BINDINGS_KEY, JSON.stringify(bindings));
}

export async function removeBinding(sdk: MaestroSdk, key: string): Promise<boolean> {
  const bindings = await loadBindings(sdk);
  if (!Object.prototype.hasOwnProperty.call(bindings, key)) return false;
  delete bindings[key];
  await sdk.storage.set(BINDINGS_KEY, JSON.stringify(bindings));
  return true;
}

/** Read a bot token / app-level secret from private KV. */
export async function getSecret(sdk: MaestroSdk, name: string): Promise<string | undefined> {
  const value = await sdk.storage.get(SECRET_PREFIX + name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Persist a bot token / app-level secret into private KV. */
export async function setSecret(sdk: MaestroSdk, name: string, value: string): Promise<void> {
  await sdk.storage.set(SECRET_PREFIX + name, value);
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Read one non-secret setting. Panel writes are namespace-confined by the host
 * (`settings.set` rejects any key outside `plugins.<id>.*`), so the
 * fully-qualified `plugins.<id>.<key>` form is authoritative and read FIRST;
 * the bare declared key is next (some hosts surface a contributed default
 * there), then the static `fallback`. A stored value of ANY string wins —
 * including `''`, so a saved empty (e.g. `enabledProviders: ''` to disable every
 * provider) is honored rather than snapping back to the fallback. The host
 * returns `null` for an absent key, so `''` is unambiguously an explicit write.
 */
async function readSetting(sdk: MaestroSdk, key: string, fallback: string): Promise<string> {
  const namespaced = await sdk.settings.get(`plugins.${sdk.pluginId}.${key}`);
  if (typeof namespaced === 'string') return namespaced;
  const bare = await sdk.settings.get(key);
  if (typeof bare === 'string') return bare;
  return fallback;
}

/** Load the full non-secret relay configuration from plugin settings. */
export async function loadConfig(sdk: MaestroSdk): Promise<RelayConfig> {
  return {
    enabledProviders: csv(await readSetting(sdk, 'enabledProviders', 'discord,slack')),
    logLevel: await readSetting(sdk, 'logLevel', 'info'),
    discord: {
      clientId: await readSetting(sdk, 'discordClientId', ''),
      guildId: await readSetting(sdk, 'discordGuildId', ''),
      allowedUserIds: csv(await readSetting(sdk, 'discordAllowedUserIds', '')),
    },
    slack: {
      teamId: await readSetting(sdk, 'slackTeamId', ''),
      appId: await readSetting(sdk, 'slackAppId', ''),
      allowedUserIds: csv(await readSetting(sdk, 'slackAllowedUserIds', '')),
    },
  };
}
