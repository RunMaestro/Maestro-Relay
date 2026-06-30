import { channelDb as core, type AgentChannel } from '../../core/db';

/**
 * Teams-side wrapper around the provider-aware core channel registry.
 * Pre-binds `provider='teams'` so adapter code reads naturally.
 */
export const channelDb = {
  register(channelId: string, agentId: string, agentName: string): void {
    core.register('teams', channelId, agentId, agentName, null);
  },
  /**
   * Bind an unbound conversation, or rebind one that already holds a binding.
   * Rebinding switches the agent and resets the session (the old session
   * belongs to the previous agent). A Teams DM holds exactly one binding, so
   * unlike Slack we cannot avoid this by spawning a fresh channel.
   */
  bindOrRebind(channelId: string, agentId: string, agentName: string): 'bound' | 'rebound' {
    if (!core.get('teams', channelId)) {
      core.register('teams', channelId, agentId, agentName, null);
      return 'bound';
    }
    core.rebind('teams', channelId, agentId, agentName);
    return 'rebound';
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
