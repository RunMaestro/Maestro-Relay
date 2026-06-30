import { maestro } from '../../../core/maestro';
import { channelDb } from '../channelsDb';
import { conversationRefsDb } from '../conversationRefsDb';
import type { TeamsTurnLike } from './index';

/**
 * `agents …` — the binding surface for a Teams conversation. Mirrors the Slack
 * `/agents` command (`src/providers/slack/commands/agents.ts`), but a Teams DM
 * holds exactly one binding: switching agents *rebinds the same conversation*
 * rather than spawning a fresh channel.
 */
export async function handleAgents(
  turnCtx: TeamsTurnLike,
  sub: string | undefined,
  rest: string[],
): Promise<void> {
  const conversationId = turnCtx.activity.conversation.id;

  switch ((sub ?? 'list').toLowerCase()) {
    case '':
    case 'list':
      await handleList(turnCtx);
      break;
    case 'new':
      // Join the remaining tokens so multi-word agent names shown by
      // `agents list` (e.g. "My Agent") resolve — not just the first word.
      await handleNew(turnCtx, conversationId, rest.join(' ').trim() || undefined);
      break;
    case 'current':
      await handleCurrent(turnCtx, conversationId);
      break;
    case 'disconnect':
      await handleDisconnect(turnCtx, conversationId);
      break;
    case 'readonly':
      await handleReadonly(turnCtx, conversationId, rest[0]);
      break;
    default:
      await turnCtx.sendActivity(
        `Unknown \`agents\` subcommand: \`${sub}\`. Try: \`list\`, \`new <agent-id>\`, \`current\`, \`disconnect\`, \`readonly <on|off>\`.`,
      );
  }
}

async function handleList(turnCtx: TeamsTurnLike): Promise<void> {
  const agents = await maestro.listAgents();
  if (agents.length === 0) {
    await turnCtx.sendActivity('No agents available.');
    return;
  }
  const lines = agents.map((a) => `• ${a.name} (${a.id})`);
  await turnCtx.sendActivity(['**Available Maestro Agents:**', ...lines].join('\n'));
}

async function handleNew(
  turnCtx: TeamsTurnLike,
  conversationId: string,
  agentId: string | undefined,
): Promise<void> {
  if (!agentId) {
    await turnCtx.sendActivity('Usage: `agents new <agent-id>`');
    return;
  }

  // Lookup mirrors Slack/Discord `agents new`: exact id, id-prefix, or exact
  // name. Keeping the providers identical means ids/names that resolve in one
  // chat platform resolve in the other.
  const agents = await maestro.listAgents();
  const agent = agents.find(
    (a) => a.id === agentId || a.id.startsWith(agentId) || a.name === agentId,
  );
  if (!agent) {
    await turnCtx.sendActivity(
      `Agent \`${agentId}\` not found. Type \`agents list\` to see available agents.`,
    );
    return;
  }

  const result = channelDb.bindOrRebind(conversationId, agent.id, agent.name);
  if (result === 'bound') {
    await turnCtx.sendActivity(
      `Bound this chat to **${agent.name}** (\`${agent.id}\`). Send a message to start.`,
    );
  } else {
    await turnCtx.sendActivity(
      `Rebound this chat to **${agent.name}** (\`${agent.id}\`). The previous session was reset.`,
    );
  }
}

async function handleCurrent(
  turnCtx: TeamsTurnLike,
  conversationId: string,
): Promise<void> {
  const existing = channelDb.get(conversationId);
  if (!existing) {
    await turnCtx.sendActivity(
      'This chat is bound to no agent. Type `agents new <agent-id>` to bind one.',
    );
    return;
  }
  const mode = existing.read_only ? ' (read-only)' : '';
  await turnCtx.sendActivity(
    `This chat is bound to **${existing.agent_name}** (\`${existing.agent_id}\`)${mode}.`,
  );
}

async function handleDisconnect(
  turnCtx: TeamsTurnLike,
  conversationId: string,
): Promise<void> {
  const existing = channelDb.get(conversationId);
  if (!existing) {
    await turnCtx.sendActivity('This chat is bound to no agent.');
    return;
  }
  conversationRefsDb.remove(conversationId);
  channelDb.remove(conversationId);
  await turnCtx.sendActivity(`Disconnected **${existing.agent_name}** from this chat.`);
}

async function handleReadonly(
  turnCtx: TeamsTurnLike,
  conversationId: string,
  mode: string | undefined,
): Promise<void> {
  const existing = channelDb.get(conversationId);
  if (!existing) {
    await turnCtx.sendActivity('This chat is bound to no agent.');
    return;
  }
  const normalized = mode?.toLowerCase();
  if (normalized !== 'on' && normalized !== 'off') {
    await turnCtx.sendActivity('Usage: `agents readonly <on|off>`');
    return;
  }
  const readOnly = normalized === 'on';
  channelDb.setReadOnly(conversationId, readOnly);
  await turnCtx.sendActivity(
    `**${existing.agent_name}** is now in ${readOnly ? 'read-only' : 'read-write'} mode.`,
  );
}
