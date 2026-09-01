import { db } from './core/db'; // initializes + migrates DB on startup
import { config } from './core/config';
import { logger } from './core/logger';
import { maestro } from './core/maestro';
import { createQueue } from './core/queue';
import { startServer } from './core/api';
import { buildProviders } from './core/providers';
import { createSusFactor } from './core/susfactor';
import type { KernelContext } from './core/types';

async function main() {
  const providers = await buildProviders(config.enabledProviders);
  if (providers.size === 0) {
    await logger.error(
      'bridge/startup',
      `No providers enabled. Set ENABLED_PROVIDERS in .env (default 'discord'). Exiting.`,
    );
    process.exit(1);
  }

  // Fail fast on a misconfigured screener: a security control that silently
  // disables itself is worse than one that refuses to start.
  let susFactor;
  try {
    susFactor = createSusFactor(config.susFactor);
  } catch (err) {
    await logger.error(
      'bridge/startup',
      `SusFactor configuration invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (susFactor.enabled) {
    logger.info(
      'bridge/startup',
      `SusFactor prompt screening enabled (mode=${susFactor.mode}, fail-${config.susFactor.failOpen ? 'open' : 'closed'})`,
    );
  }

  const queue = createQueue({
    maestro,
    getProvider: (name) => providers.get(name),
    susFactor,
    logger,
  });

  const ctx: KernelContext = {
    enqueue: queue.enqueue,
    logger,
  };

  for (const [name, provider] of providers) {
    try {
      await provider.start(ctx);
      logger.info('bridge/startup', `provider "${name}" started`);
    } catch (err) {
      await logger.error('bridge/startup', `provider "${name}" failed to start: ${String(err)}`);
      process.exit(1);
    }
  }

  const server = startServer(providers);

  const shutdown = async (signal: string) => {
    logger.info('bridge/shutdown', `received ${signal}, shutting down...`);
    server.close();
    for (const [name, provider] of providers) {
      try {
        await provider.stop();
      } catch (err) {
        await logger.error('bridge/shutdown', `error stopping provider "${name}": ${String(err)}`);
      }
    }
    try {
      db.exec('PRAGMA wal_checkpoint(RESTART);');
      db.close();
    } catch (err) {
      await logger.error('bridge/shutdown', `db shutdown error: ${String(err)}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
