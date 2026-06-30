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
import { AgentNotFoundError } from '../../core/errors';
import { teamsConfig } from './config';
import { logger } from '../../core/logger';
import { MaestroTeamsBot } from './messageCreate';
import { conversationRefsDb } from './conversationRefsDb';
import { channelDb } from './channelsDb';
import { toRateLimitError } from './errors';

// Re-exported so existing importers (`./adapter`) keep working; the
// implementation lives in the SDK-free `./errors` module so it can be
// unit-tested without pulling the `botbuilder` runtime.
export { toRateLimitError };

/**
 * Microsoft Teams provider (Phase 1, DM/`personal` scope).
 *
 * Runs the Bot Framework `CloudAdapter` behind a `restify` `POST /api/messages`
 * endpoint that the Azure Bot Service posts inbound activities to. Inbound turns
 * are handled by `MaestroTeamsBot` (see `messageCreate.ts`); outbound replies and
 * proactive `/api/send` pushes go out via `continueConversationAsync`, keyed on a
 * conversation reference captured from the user's first message. Teams bots cannot
 * add reactions, so `react` is intentionally not implemented. Channel/`team` scope
 * is a later phase.
 */
export class TeamsProvider implements BridgeProvider {
  readonly name = 'teams';
  private adapter: CloudAdapter | null = null;
  private server: restify.Server | null = null;
  private started = false;

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

  resolveConversation(message: IncomingMessage): ConversationRecord | null {
    // Phase 1 is flat — a Teams conversation maps 1:1 to a binding with no
    // thread branch (Slack-style thread registries arrive in a later phase).
    const channelInfo = channelDb.get(message.channelId);
    if (!channelInfo) return null;
    return {
      agentId: channelInfo.agent_id,
      sessionId: channelInfo.session_id ?? null,
      readOnly: !!channelInfo.read_only,
      persistSession: (sessionId: string) =>
        channelDb.updateSession(message.channelId, sessionId),
    };
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

  async sendTyping(target: ChannelTarget): Promise<void> {
    const stored = conversationRefsDb.get(target.channelId);
    if (!this.adapter || !stored) return;

    try {
      await this.adapter.continueConversationAsync(
        teamsConfig.appId,
        stored.reference as Partial<ConversationReference>,
        async (c) => {
          await c.sendActivity({ type: 'typing' });
        },
      );
    } catch (err) {
      // Best-effort indicator: never let a typing failure break the turn.
      void logger.debug('teams/typing', String(err));
    }
  }

  async findOrCreateAgentChannel(agentId: string): Promise<AgentChannelInfo> {
    // Lookup-only: Phase 1 cannot proactively spin up a 1:1 Teams chat — the
    // user must have messaged the bot first so a conversation reference (and
    // binding) exists. Graph-based creation is Phase 3.
    const existing = channelDb.getByAgentId(agentId);
    if (existing) {
      return {
        channelId: existing.channel_id,
        agentId,
        agentName: existing.agent_name,
      };
    }
    throw new AgentNotFoundError(agentId);
  }
}
