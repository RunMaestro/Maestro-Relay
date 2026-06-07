import type { BridgeProvider } from './types';
import { logger } from './logger';

/**
 * Build the set of provider instances enabled in this deployment.
 * Adapters are dynamically imported so a disabled provider never loads
 * its config (and never fails on missing platform credentials).
 */
export async function buildProviders(
  enabled: string[],
): Promise<Map<string, BridgeProvider>> {
  const providers = new Map<string, BridgeProvider>();
  for (const name of enabled) {
    const adapter = await loadProvider(name);
    if (adapter) providers.set(adapter.name, adapter);
  }
  return providers;
}

async function loadProvider(name: string): Promise<BridgeProvider | null> {
  switch (name) {
    case 'discord': {
      const { DiscordProvider } = await import('../providers/discord/adapter');
      return new DiscordProvider();
    }
    case 'slack': {
      const { SlackProvider } = await import('../providers/slack/adapter');
      return new SlackProvider();
    }
    default:
      logger.warn('providers/load', `Unknown provider "${name}" — ignoring.`);
      return null;
  }
}
