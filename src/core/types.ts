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
  /**
   * Optional sub-conversation id. When set, providers post into this
   * thread/reply rather than the top-level channel. Rooms use it so a room can
   * live in a dedicated thread of a channel.
   */
  threadId?: string;
}

export interface MessageTarget extends ChannelTarget {
  messageId: string;
}

export interface IncomingAttachment {
  /**
   * Direct download URL. For platforms that mint short-lived URLs (e.g.
   * Telegram's getFile, which expires after ~1 hour), prefer `resolveUrl`
   * so the URL is fetched just-in-time at download.
   */
  url: string;
  name: string;
  size: number;
  contentType?: string;
  /**
   * Optional lazy URL resolver. When present, `downloadAttachments` calls
   * this just before fetching to avoid using a stale pre-resolved URL. Use
   * this for providers whose download URLs are time-limited.
   */
  resolveUrl?: () => Promise<string>;
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
 * A per-message sender identity. Used by the optional `sendAs` capability so a
 * single conversation can carry many distinct personas (multi-agent rooms).
 * Kernel-generic: no provider types. `botUserId` lets the renderer self-exclude
 * a persona from its own native mentions and lets the transport pick the right
 * underlying client when a provider fronts several bot identities.
 */
export interface PersonaIdentity {
  name: string;
  avatarUrl?: string;
  /** Provider-side user id of the bot rendering this persona, if any. */
  botUserId?: string;
}

/**
 * Options carried alongside a room-bound message into the bus.
 *
 * `toAgentId` names the addressed participant the message routes to (the agent
 * the acting bot renders). `fromKind` classifies the author so the bus can
 * reset the burst-scoped turn counter on human input but not on a peer-bot hop.
 * Both are optional so a provider that cannot classify still submits cleanly.
 */
export interface RoomSubmitOptions {
  /** Agent the addressed message routes to (the acting bot's bound participant). */
  toAgentId?: string;
  /** Whether the author was a person or a peer relay bot. */
  fromKind?: 'human' | 'bot';
  /**
   * Provider message id identifying the ONE room utterance this submit derives
   * from. A single message addressing two bots enters the bus as two per-addressee
   * submits sharing this id, so the transcript buffer dedupes on it to record the
   * utterance exactly once. Optional: a provider that can't supply one still submits.
   */
  messageId?: string;
}

/**
 * Kernel-internal gateway to the multi-agent room bus. Providers consult
 * `isRoom` to decide whether an inbound message belongs to a room, and hand
 * room-bound messages to the bus via `submitMessage`. Provider-agnostic.
 */
export interface RoomGateway {
  isRoom(provider: ProviderName, channelId: string): boolean;
  submitMessage(
    provider: ProviderName,
    channelId: string,
    from: string,
    text: string,
    opts?: RoomSubmitOptions,
  ): void;
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
   * Optional: send a message under a distinct per-message identity (multi-agent
   * rooms). Slack/Teams mask via customized username/avatar; Discord routes to
   * the bot client bound to `identity.botUserId`. Optional like `react?`.
   */
  sendAs?(
    target: ChannelTarget,
    identity: PersonaIdentity,
    msg: OutgoingMessage,
  ): Promise<void>;

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
  warn(context: string, detail: string): void;
  info(context: string, detail: string): void;
  debug(context: string, detail: string): void;
}

export interface KernelContext {
  enqueue(message: IncomingMessage, options?: EnqueueOptions): void;
  logger: KernelLogger;
  /**
   * Optional multi-agent room gateway. Present once the room bus is wired
   * (Phase 4); providers guard on its presence before treating a channel as a
   * room. Optional so single-agent deployments run without it.
   */
  rooms?: RoomGateway;
}
