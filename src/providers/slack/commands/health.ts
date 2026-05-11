import type { SlackCommandMiddlewareArgs } from '@slack/bolt';

export async function handle({ ack, say }: SlackCommandMiddlewareArgs): Promise<void> {
  await ack();
  await say('Maestro relay is healthy and running.');
}
