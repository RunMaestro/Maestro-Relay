import { db } from './core/db'; // initializes + migrates DB on startup
import { config } from './core/config';
import { logger } from './core/logger';
import { maestro } from './core/maestro';
import { createQueue } from './core/queue';
import { createRoomBus } from './core/room/bus';
import { roomsDb } from './core/room/roomsDb';
import { startServer } from './core/api';
import { buildProviders } from './core/providers';
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

  const queue = createQueue({
    maestro,
    getProvider: (name) => providers.get(name),
    logger,
  });

  // The multi-agent room bus: the per-room-serialized worker that drives an
  // auto-relay burst across many bots (Phase 4). It reaches each provider's
  // outbound path through `provider.sendAs`, so the Discord `RoomGatewayManager`
  // (constructed and torn down inside `DiscordProvider`) is shared implicitly —
  // the bus never touches a chat SDK. Exposed as `ctx.rooms` BEFORE providers
  // start so their room listeners can bind to it; single-agent deployments that
  // never register a room simply never call it.
  const roomBus = createRoomBus({
    db: roomsDb,
    maestro,
    getProvider: (name) => providers.get(name),
    logger,
  });

  const ctx: KernelContext = {
    enqueue: queue.enqueue,
    logger,
    rooms: roomBus,
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
