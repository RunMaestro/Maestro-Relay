/**
 * Core types for the bridge kernel.
 *
 * The kernel is provider-agnostic: it speaks only in the types declared here.
 * Each chat provider (Discord, Slack, Teams, ...) ships an adapter that
 * implements `BridgeProvider` and translates platform events into
 * `IncomingMessage` and platform actions out of `OutgoingMessage`.
 */

export type ProviderName = string;

export interface ChannelTarget {
  provider: ProviderName;
  /** Conversation id — the channel id, or the thread/sub-conversation id if applicable. */
  channelId: string;
}

export interface MessageTarget extends ChannelTarget {
  messageId: string;
}

export interface IncomingAttachment {
  url: string;
  name: string;
  size: number;
  contentType?: string;
}

export interface IncomingMessage {
  provider: ProviderName;
  messageId: string;
  /** Conversation id — equal to threadId for thread messages, channelId otherwise. */
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  attachments: IncomingAttachment[];
  /** True when the message is in a sub-conversation (Discord thread, Slack thread reply, etc.). */
  isThread: boolean;
  /** Adapter-internal payload (raw discord.js Message, Slack event, etc.). Opaque to the kernel. */
  raw?: unknown;
}

export interface OutgoingMessage {
  text: string;
  /**
   * When true, render a user mention/notification alongside the text.
   * The provider decides the target (Discord uses DISCORD_MENTION_USER_ID,
   * Slack would use SLACK_MENTION_USER_ID, etc.).
   */
  mention?: boolean;
}

/**
 * Per-conversation state the queue needs to drive a maestro send.
 * Returned by the provider for each incoming message; encapsulates
 * the provider-specific channel-vs-thread storage decision.
 */
export interface ConversationRecord {
  agentId: string;
  sessionId: string | null;
  readOnly: boolean;
  /** Persist the maestro session id once the first response returns. */
  persistSession(sessionId: string): void;
}

export interface ReactionHandle {
  remove(): Promise<void>;
}

export interface AgentChannelInfo {
  channelId: string;
  agentId: string;
  agentName: string;
}

export interface BridgeProvider {
  readonly name: ProviderName;

  /** Connect to the platform and register event handlers. */
  start(ctx: KernelContext): Promise<void>;

  /** Disconnect and release resources. */
  stop(): Promise<void>;

  /**
   * Resolve the conversation context for an incoming message. Returns null if
   * the channel is not registered to an agent (and the kernel should drop the message).
   */
  resolveConversation(message: IncomingMessage): ConversationRecord | null;

  /** Send a message into a conversation. */
  send(target: ChannelTarget, msg: OutgoingMessage): Promise<void>;

  /**
   * Look up (or create) the platform channel bound to a given agent.
   * Used by the HTTP API for agent-initiated messages.
   */
  findOrCreateAgentChannel(agentId: string): Promise<AgentChannelInfo>;

  /** Optional: react to a message (used as a "queued" indicator). */
  react?(target: MessageTarget, emoji: string): Promise<ReactionHandle>;

  /** Optional: emit a typing indicator while the agent thinks. */
  sendTyping?(target: ChannelTarget): Promise<void>;

  /** Provider readiness — used by /api/health. */
  isReady(): boolean;
}

export type EnqueueOptions = {
  contentOverride?: string;
  attachmentsOverride?: IncomingAttachment[];
};

export interface KernelLogger {
  error(context: string, detail: string): void | Promise<void>;
}

export interface KernelContext {
  enqueue(message: IncomingMessage, options?: EnqueueOptions): void;
  logger: KernelLogger;
}
