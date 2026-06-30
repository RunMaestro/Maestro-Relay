import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  TurnContext,
  type ConversationReference,
} from 'botbuilder';
import * as restify from 'restify';
import type {
  AgentChannelInfo,
  BridgeProvider,
  ChannelTarget,
  ConversationRecord,
  IncomingMessage,
  KernelContext,
  OutgoingMessage,
} from '../../core/types';
import { AgentNotFoundError, RateLimitError } from '../../core/errors';
import { teamsConfig } from './config';
import { logger } from '../../core/logger';
import { MaestroTeamsBot } from './messageCreate';
import { conversationRefsDb } from './conversationRefsDb';

/**
 * Microsoft Teams provider.
 *
 * Phase 2 (TEAMS-02) stands up the adapter lifecycle only: the Bot
 * Framework `CloudAdapter`, the `restify` server, and the
 * `POST /api/messages` endpoint that the Azure Bot Service posts to.
 * The bot handler is a placeholder and inbound/outbound/command logic
 * is stubbed — TEAMS-03/04/05 fill these in.
 */
export class TeamsProvider implements BridgeProvider {
  readonly name = 'teams';
  private adapter: CloudAdapter | null = null;
  private server: restify.Server | null = null;
  private started = false;
  private pendingChannels = new Map<string, Promise<AgentChannelInfo>>();

  async start(ctx: KernelContext): Promise<void> {
    const auth = new ConfigurationBotFrameworkAuthentication(
      {},
      new ConfigurationServiceClientCredentialFactory({
        MicrosoftAppId: teamsConfig.appId,
        MicrosoftAppPassword: teamsConfig.appPassword,
        MicrosoftAppType: teamsConfig.appType,
        MicrosoftAppTenantId: teamsConfig.tenantId,
      }),
    );

    this.adapter = new CloudAdapter(auth);
    this.adapter.onTurnError = async (_c, err) => {
      void logger.error('teams/turn', String(err));
    };

    const bot = new MaestroTeamsBot(ctx);

    const server = restify.createServer();
    server.use(restify.plugins.bodyParser());
    server.post('/api/messages', (req, res) =>
      this.adapter!.process(req, res, (c) => bot.run(c)),
    );

    await new Promise<void>((resolve) => {
      server.listen(teamsConfig.port, () => {
        logger.info('teams/start', `listening on ${teamsConfig.port}`);
        resolve();
      });
    });

    this.server = server;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server = null;
    this.adapter = null;
    this.started = false;
  }

  isReady(): boolean {
    return this.started;
  }

  resolveConversation(_message: IncomingMessage): ConversationRecord | null {
    // TEAMS-05 implements the real lookup.
    return null;
  }

  async send(target: ChannelTarget, msg: OutgoingMessage): Promise<void> {
    if (!this.adapter) throw new Error('Teams adapter not initialised');

    const stored = conversationRefsDb.get(target.channelId);
    if (!stored) {
      void logger.error('teams/send:no-ref', `conversation=${target.channelId}`);
      throw new Error(`No conversation reference found for ${target.channelId}`);
    }

    let text = msg.text;
    if (msg.mention && teamsConfig.mentionUserId) {
      // TODO: entity mention — a proper <at> entity needs a matching
      // `mentions` entity in the activity. A plain prefix is acceptable
      // for Phase 1.
      text = `<at>${teamsConfig.mentionUserId}</at> ${text}`;
    }

    try {
      await this.adapter.continueConversationAsync(
        teamsConfig.appId,
        stored.reference as Partial<ConversationReference>,
        async (c) => {
          await c.sendActivity({ text, textFormat: 'markdown' });
        },
      );
    } catch (err) {
      const rl = toRateLimitError(err);
      if (rl) throw rl;
      throw err;
    }
  }

  // Teams bots cannot add reactions, so `react` is intentionally omitted
  // (it's optional in the BridgeProvider contract).

  async sendTyping(_target: ChannelTarget): Promise<void> {
    // TEAMS-04 fills this in.
  }

  async findOrCreateAgentChannel(agentId: string): Promise<AgentChannelInfo> {
    // TEAMS-05 adds the real lookup; Phase 1 is lookup-only and there is
    // nothing to look up yet, so surface AgentNotFoundError.
    throw new AgentNotFoundError(agentId);
  }
}

/**
 * Translate a Bot Framework HTTP 429 into the kernel-level `RateLimitError`.
 * Teams surfaces throttling as a `statusCode === 429` with a `retry-after`
 * header (seconds). We convert to ms so the kernel deals in a single unit.
 *
 * Returns `null` when the error is not a rate-limit; the caller rethrows the
 * original error in that case.
 */
export function toRateLimitError(err: unknown): RateLimitError | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as {
    statusCode?: number;
    retryAfter?: number;
    headers?: Record<string, string | string[] | undefined>;
  };
  if (e.statusCode !== 429) return null;

  let secs = typeof e.retryAfter === 'number' ? e.retryAfter : NaN;
  if (Number.isNaN(secs)) {
    const header = e.headers?.['retry-after'];
    const raw = Array.isArray(header) ? header[0] : header;
    secs = raw != null ? parseInt(String(raw), 10) : NaN;
  }
  if (Number.isNaN(secs) || secs < 1) secs = 1;

  return new RateLimitError(secs * 1000, `Teams rate limited; retry after ${secs}s`);
}
