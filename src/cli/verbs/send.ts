import { parseArgs } from 'node:util';
import { DEFAULT_PORT, fail, ok, parsePort, postToSendApi } from '../lib';

export const sendUsage = `Usage: maestro-relay send --agent <id> --message <text> [--provider <name>] [--mention] [--session <id>] [--port <number>]

Send a message to an agent's bridge channel (auto-creates channel if needed).

Options:
  -a, --agent <id>      Maestro agent ID (required)
  -m, --message <text>  Message text to send (required)
      --provider <name> Provider/module name (default: discord)
      --mention         Mention the user set in DISCORD_MENTION_USER_ID
  -s, --session <id>    Maestro session this push belongs to. A reply thread
                        started on the pushed message continues this session
                        instead of opening a new one (Discord).
  -p, --port <number>   API port (default: ${DEFAULT_PORT})
  -h, --help            Show this help`;

export async function runSend(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        agent: { type: 'string', short: 'a' },
        message: { type: 'string', short: 'm' },
        provider: { type: 'string' },
        mention: { type: 'boolean', default: false },
        session: { type: 'string', short: 's' },
        port: { type: 'string', short: 'p' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    fail((err as Error).message);
  }

  if (parsed.values.help) {
    console.log(sendUsage);
    process.exit(0);
  }

  const agentId = parsed.values.agent;
  const message = parsed.values.message;

  if (!agentId || !message) {
    console.error(sendUsage);
    fail('--agent and --message are required');
  }

  let port: number;
  try {
    port = parsePort(parsed.values.port);
  } catch (err) {
    fail((err as Error).message);
  }

  try {
    const result = await postToSendApi(
      {
        agentId,
        message,
        provider: parsed.values.provider,
        mention: parsed.values.mention,
        sessionId: parsed.values.session,
      },
      port,
    );
    ok(result);
  } catch (err) {
    fail((err as Error).message);
  }
}
