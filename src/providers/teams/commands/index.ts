import { teamsConfig } from '../config';
import { logger } from '../../../core/logger';
import { handleHealth } from './health';
import { handleAgents } from './agents';
import { handleSession } from './session';

/**
 * Structural view of the bits of a Bot Framework `TurnContext` the command
 * handlers consume. Declaring it here (instead of importing `TurnContext`)
 * keeps the handlers unit-testable with a plain fake and avoids dragging the
 * `botbuilder` runtime into the command tests. A real `TurnContext` is
 * structurally assignable to this shape.
 */
export interface TeamsTurnLike {
  activity: { conversation: { id: string } };
  sendActivity(text: string): Promise<unknown>;
}

/**
 * Teams has no slash-command dispatch — commands are plain typed text parsed
 * from the message. This mirrors the Slack `/health`, `/agents`, `/session`
 * surface (see `src/providers/slack/commands/`).
 *
 * Returns `true` when the message was a command (consumed — do not forward to
 * the agent), `false` when it should flow through to the bound agent.
 */
export async function tryHandleCommand(
  turnCtx: TeamsTurnLike,
  text: string,
  userId: string,
): Promise<boolean> {
  // Authorization gate runs first: an excluded user gets a single reply and the
  // message is consumed, so nothing reaches a command handler or the agent.
  const allowed = teamsConfig.allowedUserIds;
  if (allowed.length > 0 && !allowed.includes(userId)) {
    await turnCtx.sendActivity('You are not authorized.');
    return true;
  }

  const [verb, sub, ...rest] = text.split(/\s+/);

  try {
    switch (verb?.toLowerCase()) {
      case 'health':
        await handleHealth(turnCtx);
        return true;
      case 'agents':
        await handleAgents(turnCtx, sub, rest);
        return true;
      case 'session':
        await handleSession(turnCtx, sub);
        return true;
      default:
        // Not a known command — let the message flow to the agent.
        return false;
    }
  } catch (err) {
    void logger.error('teams/commands', err instanceof Error ? err.message : String(err));
    await turnCtx.sendActivity('Failed to execute command.');
    return true;
  }
}
