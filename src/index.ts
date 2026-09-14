import { db } from './core/db'; // initializes + migrates DB on startup
import { config } from './core/config';
import { logger } from './core/logger';
import { maestro } from './core/maestro';
import { createQueue } from './core/queue';
import { startServer } from './core/api';
import { buildProviders } from './core/providers';
import { createLateNetworkErrorHandler, startProviderWithRetry } from './core/providerStart';
import { createSusFactor } from './core/susfactor';
import { createSusAudit } from './core/susAudit';
import { pendingDb, MAX_REPLAY_ATTEMPTS } from './core/db/pending';
import type { IncomingMessage, KernelContext } from './core/types';

/**
 * Re-enqueue messages that were accepted but never answered.
 *
 * Discord hands a message to the gateway exactly once. Before this existed, a
 * restart while a reply was being generated left the user staring at a ⏳ that
 * never resolved, because the in-memory queue died with the process. The
 * durable table gives startup a work list to finish.
 *
 * `raw` is not restored — it held a live discord.js object. Everything the
 * queue reads is reconstructed from the plain columns.
 */
function replayPending(enqueue: KernelContext['enqueue']): void {
  const rows = pendingDb.all();
  if (rows.length === 0) return;

  let replayed = 0;
  for (const row of rows) {
    const attempts = pendingDb.bumpAttempts(row.provider, row.message_id);
    if (attempts > MAX_REPLAY_ATTEMPTS) {
      // A message that keeps killing the process must not be retried forever.
      pendingDb.clear(row.provider, row.message_id);
      void logger.error(
        'bridge/replay',
        `dropping message ${row.message_id} after ${attempts} attempts`,
      );
      continue;
    }

    const message: IncomingMessage = {
      provider: row.provider,
      messageId: row.message_id,
      channelId: row.channel_id,
      authorId: row.author_id,
      authorName: row.author_name,
      content: row.content,
      attachments: JSON.parse(row.attachments) as IncomingMessage['attachments'],
      isThread: row.is_thread === 1,
    };
    enqueue(message, row.options ? JSON.parse(row.options) : undefined);
    replayed += 1;
  }

  if (replayed > 0) {
    logger.info('bridge/replay', `replayed ${replayed} unanswered message(s) from the last run`);
  }
}

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
  const susAudit = createSusAudit(config.susAudit);
  if (susFactor.enabled && susAudit.enabled) {
    logger.info(
      'bridge/startup',
      `SusFactor audit trail at ${susAudit.path} (score >= ${susAudit.minScore})`,
    );
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
    susAudit,
    logger,
  });

  const ctx: KernelContext = {
    enqueue: queue.enqueue,
    logger,
  };

  // Serve the API before any provider connects. A platform outage then reads
  // as a relay that is up and not ready (503), which is true. Before this the
  // port stayed closed until Discord answered, so an outage looked like a crash.
  const server = startServer(providers, { inFlight: queue.inFlight });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('bridge/shutdown', `received ${signal}, shutting down...`);
    server.close();

    // Finish replies already in progress. Cutting one off loses the user's
    // message: Discord will not redeliver it, and the durable record only
    // helps on the next boot.
    const busy = queue.inFlight();
    if (busy > 0) {
      logger.info('bridge/shutdown', `draining ${busy} in-flight message(s)...`);
      const drained = await queue.drain();
      logger.info(
        'bridge/shutdown',
        drained ? 'drain complete' : 'drain timed out; unfinished work will replay on next start',
      );
    }

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
  process.on('uncaughtException', createLateNetworkErrorHandler(logger));

  for (const [name, provider] of providers) {
    try {
      const started = await startProviderWithRetry(name, provider, ctx, {
        logger,
        shouldStop: () => shuttingDown,
      });
      if (!started) return;
      logger.info('bridge/startup', `provider "${name}" started`);
    } catch (err) {
      await logger.error('bridge/startup', `provider "${name}" failed to start: ${String(err)}`);
      process.exit(1);
    }
  }

  // Providers are live now, so anything left over from the last run can be
  // answered as if it had just arrived.
  replayPending(queue.enqueue);
}

void main();
