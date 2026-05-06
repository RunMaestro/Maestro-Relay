import './core/db'; // ensure DB is initialized + migrated on startup
import { config } from './core/config';
import { logger } from './core/logger';
import { maestro } from './core/maestro';
import { createQueue } from './core/queue';
import { startServer } from './core/api';
import { buildProviders } from './core/providers';
import type { KernelContext } from './core/types';

async function main() {
  const providers = await buildProviders(config.enabledProviders);
  if (providers.size === 0) {
    console.error(
      `No providers enabled. Set ENABLED_PROVIDERS in .env (default 'discord'). Exiting.`,
    );
    process.exit(1);
  }

  const queue = createQueue({
    maestro,
    getProvider: (name) => providers.get(name),
    logger,
  });

  const ctx: KernelContext = {
    enqueue: queue.enqueue,
    logger,
  };

  for (const [name, provider] of providers) {
    try {
      await provider.start(ctx);
      console.log(`[bridge] provider "${name}" started`);
    } catch (err) {
      console.error(`[bridge] provider "${name}" failed to start:`, err);
      process.exit(1);
    }
  }

  const server = startServer(providers);

  const shutdown = async (signal: string) => {
    console.log(`\n[bridge] received ${signal}, shutting down...`);
    server.close();
    for (const [name, provider] of providers) {
      try {
        await provider.stop();
      } catch (err) {
        console.error(`[bridge] error stopping provider "${name}":`, err);
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
