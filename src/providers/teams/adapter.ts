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

  async start(_ctx: KernelContext): Promise<void> {
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

    // TEAMS-03 replaces this placeholder with the real MaestroTeamsBot.
    const bot = { run: async (_c: TurnContext) => {} };

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

  async send(_target: ChannelTarget, _msg: OutgoingMessage): Promise<void> {
    throw new Error('not implemented until TEAMS-04');
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
