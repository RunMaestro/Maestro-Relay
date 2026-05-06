import type { BridgeProvider } from './types';

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
    default:
      console.warn(`[providers] Unknown provider "${name}" — ignoring.`);
      return null;
  }
}
