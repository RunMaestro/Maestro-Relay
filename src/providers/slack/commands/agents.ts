import type { SlackCommandMiddlewareArgs, SayFn } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { WebClient } from '@slack/web-api';
import { slackConfig } from '../config';
import { channelDb } from '../channelsDb';
import { conversationDb } from '../conversationsDb';
import { maestro } from '../../../core/maestro';
import { logger } from '../../../core/logger';
import { findOrCreateSlackChannel } from '../adapter';

export async function handle({
  ack,
  say,
  command,
}: SlackCommandMiddlewareArgs): Promise<void> {
  await ack();

  const allowed = slackConfig.allowedUserIds;
  if (allowed.length > 0 && !allowed.includes(command.user_id)) {
    await say('You are not authorized to use this command.');
    return;
  }

  try {
    const [subcommand, ...args] = (command.text || '').trim().split(/\s+/);

    switch (subcommand?.toLowerCase()) {
      case 'new':
        await handleNew(say, command.channel_id, args[0], command.user_id);
        break;
      case 'disconnect':
        await handleDisconnect(say, command.channel_id, args[0]);
        break;
      case 'readonly':
        await handleReadonly(say, command.channel_id, args[0]);
        break;
      case 'list':
      case '':
      case undefined:
        await handleList(say);
        break;
      default:
        await say(
          `Unknown subcommand: \`${subcommand}\`. Try: \`list\`, \`new\`, \`disconnect\`, \`readonly\``,
        );
    }
  } catch (err) {
    void logger.error('slack/agents', err instanceof Error ? err.message : String(err));
    await say('Failed to execute agents command.');
  }
}

async function handleList(say: SayFn): Promise<void> {
  const agents = await maestro.listAgents();

  if (agents.length === 0) {
    await say('No agents available.');
    return;
  }

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Available Maestro Agents:*' },
    },
  ];

  for (const agent of agents) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `• *${agent.name}* (\`${agent.id}\`)` },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Register an agent:* `/agents new <agent-id>`\n*Unregister (run inside the agent channel):* `/agents disconnect`\n*Toggle read-only (run inside the agent channel):* `/agents readonly <on|off>`',
    },
  });

  await say({ blocks });
}

async function handleNew(
  say: SayFn,
  channelId: string,
  agentId: string | undefined,
  userId?: string,
): Promise<void> {
  if (!agentId) {
    await say('Usage: `/agents new <agent-id>`');
    return;
  }

  // Lookup mirrors Discord's /agents new: exact id, id-prefix, or exact name.
  // Keeping the two providers identical here means agent IDs/names that work
  // in one chat platform work in the other.
  const agents = await maestro.listAgents();
  const agent = agents.find(
    (a) => a.id === agentId || a.id.startsWith(agentId) || a.name === agentId,
  );
  if (!agent) {
    await say(`Agent \`${agentId}\` not found. Use \`/agents list\` to see available agents.`);
    return;
  }

  const client = new WebClient(slackConfig.token);

  let newChannelId: string;
  try {
    const result = await findOrCreateSlackChannel(client, agent);
    newChannelId = result.channelId;
  } catch (err) {
    void logger.error(
      'slack/agents:findOrCreate',
      err instanceof Error ? err.message : String(err),
    );
    await say('Failed to create channel for agent.');
    return;
  }

  if (userId) {
    try {
      await client.conversations.invite({ channel: newChannelId, users: userId });
    } catch {
      // non-fatal
    }
  }

  channelDb.register(newChannelId, agent.id, agent.name);

  await client.chat.postMessage({
    channel: newChannelId,
    text: `*${agent.name}* agent is ready.\n\nMention me (@app) in this channel to start a conversation thread.`,
  });

  await say(`Created channel <#${newChannelId}> for *${agent.name}* (\`${agent.id}\`)`);
}

async function handleDisconnect(
  say: SayFn,
  channelId: string,
  agentId: string | undefined,
): Promise<void> {
  const existing = channelDb.get(channelId);

  if (!existing) {
    await say('No agent is registered in this channel.');
    return;
  }

  if (agentId && existing.agent_id !== agentId) {
    await say(`Agent \`${agentId}\` is not registered in this channel.`);
    return;
  }

  const client = new WebClient(slackConfig.token);
  await say(`Agent *${existing.agent_name}* has been disconnected. This channel is now archived.`);

  conversationDb.removeByChannel(channelId);
  channelDb.remove(channelId);

  try {
    await client.conversations.archive({ channel: channelId });
  } catch {
    // non-fatal if archive fails
  }
}

async function handleReadonly(
  say: SayFn,
  channelId: string,
  mode: string | undefined,
): Promise<void> {
  const existing = channelDb.get(channelId);
  if (!existing) {
    await say('No agent is registered in this channel.');
    return;
  }

  const normalized = mode?.toLowerCase();
  if (normalized !== 'on' && normalized !== 'off') {
    await say('Usage: `/agents readonly <on|off>`');
    return;
  }
  const readOnly = normalized === 'on';
  channelDb.setReadOnly(channelId, readOnly);
  const status = readOnly ? 'read-only' : 'read-write';
  await say(`Agent *${existing.agent_name}* is now in ${status} mode for this channel.`);
}
