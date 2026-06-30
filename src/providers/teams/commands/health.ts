import { maestro } from '../../../core/maestro';
import type { TeamsTurnLike } from './index';

/**
 * `health` — report relay health and whether `maestro-cli` is reachable.
 * Teams analogue of `src/providers/slack/commands/health.ts`.
 */
export async function handleHealth(turnCtx: TeamsTurnLike): Promise<void> {
  const installed = await maestro.isInstalled();
  if (installed) {
    await turnCtx.sendActivity('Maestro relay is healthy and `maestro-cli` is reachable.');
  } else {
    await turnCtx.sendActivity(
      'Maestro relay is running but `maestro-cli` is not reachable.',
    );
  }
}
