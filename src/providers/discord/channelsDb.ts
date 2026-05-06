import { channelDb as core, type AgentChannel } from '../../core/db';

/**
 * Discord-side wrapper around the provider-aware core channel registry.
 * Pre-binds `provider='discord'` so adapter code reads naturally.
 */
export const channelDb = {
  register(channelId: string, guildId: string, agentId: string, agentName: string): void {
    core.register('discord', channelId, agentId, agentName, guildId);
  },
  get(channelId: string): AgentChannel | undefined {
    return core.get('discord', channelId);
  },
  getByAgentId(agentId: string): AgentChannel | undefined {
    return core.getByAgentId('discord', agentId);
  },
  updateSession(channelId: string, sessionId: string | null): void {
    core.updateSession('discord', channelId, sessionId);
  },
  setReadOnly(channelId: string, readOnly: boolean): void {
    core.setReadOnly('discord', channelId, readOnly);
  },
  remove(channelId: string): void {
    core.remove('discord', channelId);
  },
  listByAgentId(agentId: string): AgentChannel[] {
    return core.listByAgentId('discord', agentId);
  },
  listByGuild(guildId: string): AgentChannel[] {
    return core.listByGuild(guildId);
  },
};

export type { AgentChannel } from '../../core/db';
