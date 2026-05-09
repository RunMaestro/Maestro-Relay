import type { SlackCommandMiddlewareArgs, SayFn, KnownBlock } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { slackConfig } from '../config';
import { channelDb } from '../channelsDb';
import { conversationDb } from '../conversationsDb';
import { maestro } from '../../../core/maestro';

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
        await handleReadonly(say, command.channel_id, args[0], args[1]);
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
    console.error('[slack/agents] command failed:', err);
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
      text: '*Register an agent:* `/agents new <agent-id>`\n*Unregister:* `/agents disconnect <agent-id>`\n*Toggle read-only:* `/agents readonly <agent-id> <on|off>`',
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

  const agents = await maestro.listAgents();
  let agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    agent = agents.find((a) => a.name.toLowerCase() === agentId.toLowerCase());
  }
  if (!agent) {
    await say(`Agent \`${agentId}\` not found. Use \`/agents list\` to see available agents.`);
    return;
  }

  const client = new WebClient(slackConfig.token);
  const sanitizedName = agent.name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 70);
  const channelName = `maestro-${sanitizedName}`;

  let newChannelId: string | undefined;
  let isArchived = false;

  try {
    const listRes = await client.conversations.list({
      exclude_archived: false,
      types: 'public_channel',
      limit: 1000,
    });
    const existing = listRes.channels?.find((ch) => ch.name === channelName);
    if (existing?.id) {
      newChannelId = existing.id;
      isArchived = existing.is_archived ?? false;
    }
  } catch (err) {
    console.error('[slack/agents] conversations.list failed:', err);
    // ignore — will create below
  }

  if (!newChannelId) {
    const res = await client.conversations.create({ name: channelName, is_private: false });
    if (!res.channel?.id) {
      await say('Failed to create channel for agent.');
      return;
    }
    newChannelId = res.channel.id;
  }

  if (isArchived) {
    try {
      await client.conversations.unarchive({ channel: newChannelId });
    } catch {
      const fallbackName = `${channelName}-${Date.now().toString().slice(-6)}`.substring(0, 80);
      const res = await client.conversations.create({ name: fallbackName, is_private: false });
      if (!res.channel?.id) {
        await say('Failed to create channel for agent.');
        return;
      }
      newChannelId = res.channel.id;
    }
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
  agentId: string | undefined,
  mode: string | undefined,
): Promise<void> {
  if (!agentId || !mode) {
    await say('Usage: `/agents readonly <agent-id> <on|off>`');
    return;
  }

  const existing = channelDb.get(channelId);

  if (!existing) {
    await say('No agent is registered in this channel.');
    return;
  }

  if (existing.agent_id !== agentId) {
    await say(`Agent \`${agentId}\` is not registered in this channel.`);
    return;
  }

  const readOnly = mode.toLowerCase() === 'on';
  channelDb.setReadOnly(channelId, readOnly);
  const status = readOnly ? 'read-only' : 'read-write';
  await say(`Agent *${existing.agent_name}* is now in ${status} mode for this channel.`);
}
