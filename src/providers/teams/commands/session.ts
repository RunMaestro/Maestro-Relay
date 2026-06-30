import { channelDb } from '../channelsDb';
import type { TeamsTurnLike } from './index';

/**
 * `session …` — session management for a Teams conversation. Phase 1 supports
 * only `session new`, which clears the stored session so the next message
 * starts a fresh Maestro session on the bound agent.
 */
export async function handleSession(
  turnCtx: TeamsTurnLike,
  sub: string | undefined,
): Promise<void> {
  switch ((sub ?? '').toLowerCase()) {
    case 'new':
      await handleNew(turnCtx);
      break;
    default:
      await turnCtx.sendActivity(`Unknown \`session\` subcommand: \`${sub ?? ''}\`. Try: \`new\`.`);
  }
}

async function handleNew(turnCtx: TeamsTurnLike): Promise<void> {
  const conversationId = turnCtx.activity.conversation.id;
  const existing = channelDb.get(conversationId);
  if (!existing) {
    await turnCtx.sendActivity(
      'This chat is bound to no agent. Type `agents new <agent-id>` first.',
    );
    return;
  }
  channelDb.updateSession(conversationId, null);
  await turnCtx.sendActivity('Started a fresh session.');
}
