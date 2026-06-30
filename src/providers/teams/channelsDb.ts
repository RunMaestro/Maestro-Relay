import { channelDb as core, type AgentChannel } from '../../core/db';

/**
 * Teams-side wrapper around the provider-aware core channel registry.
 * Pre-binds `provider='teams'` so adapter code reads naturally.
 */
export const channelDb = {
  register(channelId: string, agentId: string, agentName: string): void {
    core.register('teams', channelId, agentId, agentName, null);
  },
  get(channelId: string): AgentChannel | undefined {
    return core.get('teams', channelId);
  },
  getByAgentId(agentId: string): AgentChannel | undefined {
    return core.getByAgentId('teams', agentId);
  },
  updateSession(channelId: string, sessionId: string | null): void {
    core.updateSession('teams', channelId, sessionId);
  },
  setReadOnly(channelId: string, readOnly: boolean): void {
    core.setReadOnly('teams', channelId, readOnly);
  },
  remove(channelId: string): void {
    core.remove('teams', channelId);
  },
  listByAgentId(agentId: string): AgentChannel[] {
    return core.listByAgentId('teams', agentId);
  },
};

export type { AgentChannel } from '../../core/db';
