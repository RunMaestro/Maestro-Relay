import type { SlackCommandMiddlewareArgs, SayFn } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { slackConfig } from '../config';
import { channelDb } from '../channelsDb';
import { conversationDb } from '../conversationsDb';

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
      default:
        await say(`Unknown subcommand: \`${subcommand}\`. Try: \`new [session-name]\``);
    }
  } catch (err) {
    await say('Failed to execute session command.');
  }
}

async function handleNew(
  say: SayFn,
  channelId: string,
  sessionName: string | undefined,
  userId?: string,
): Promise<void> {
  const agentChannel = channelDb.get(channelId);
  if (!agentChannel) {
    await say('No agent is registered in this channel. Use `/agents new <agent-id>` first.');
    return;
  }

  const { agent_id: agentId, agent_name: agentName } = agentChannel;
  const client = new WebClient(slackConfig.token);
  const sessionLabel = sessionName ? ` — ${sessionName}` : '';

  const msgRes = await client.chat.postMessage({
    channel: channelId,
    text: `*${agentName}* — ready for a new session${sessionLabel}.\nType your first message to begin.${userId ? ` Only <@${userId}> can interact with the agent in this thread.` : ''}`,
  });

  if (!msgRes.ts) {
    await say('Failed to create session message.');
    return;
  }

  const threadTs = msgRes.ts;
  conversationDb.register(threadTs, channelId, agentId, userId ?? null);

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: 'Session ready. Send your first message here to start.',
  });
}
