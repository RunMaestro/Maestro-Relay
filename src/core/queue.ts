import type {
  BridgeProvider,
  EnqueueOptions,
  IncomingAttachment,
  IncomingMessage,
  KernelLogger,
  ReactionHandle,
} from './types';
import { splitMessage as defaultSplitMessage } from './splitMessage';
import { downloadAttachments as defaultDownload, formatAttachmentRefs } from './attachments';

interface QueueEntry {
  message: IncomingMessage;
  options?: EnqueueOptions;
}

export type QueueDeps = {
  /** Maestro CLI surface needed by the queue. */
  maestro: {
    getAgentCwd: (agentId: string) => Promise<string | null>;
    send: (
      agentId: string,
      message: string,
      sessionId?: string,
      readOnly?: boolean,
    ) => Promise<{
      success: boolean;
      response: string | null;
      error?: string;
      sessionId?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalCostUsd?: number;
        contextUsagePercent?: number;
      };
    }>;
  };
  /** Resolves provider name → BridgeProvider instance. */
  getProvider: (name: string) => BridgeProvider | undefined;
  splitMessage?: (text: string) => string[];
  downloadAttachments?: (
    attachments: IncomingAttachment[],
    agentCwd: string,
  ) => Promise<{
    downloaded: { originalName: string; savedPath: string }[];
    failed: string[];
  }>;
  formatAttachmentRefs?: (files: { originalName: string; savedPath: string }[]) => string;
  logger: KernelLogger;
};

/**
 * Build a per-conversation FIFO queue. Each conversation (provider+channel)
 * is processed serially; multiple conversations run concurrently.
 *
 * The queue is provider-agnostic — it speaks only via the BridgeProvider
 * interface (send / react / sendTyping) and the maestro CLI wrapper.
 */
export function createQueue(deps: QueueDeps) {
  const split = deps.splitMessage ?? defaultSplitMessage;
  const download = deps.downloadAttachments ?? defaultDownload;
  const fmtAttachments = deps.formatAttachmentRefs ?? formatAttachmentRefs;

  const queues = new Map<string, QueueEntry[]>();
  const processing = new Set<string>();

  function key(message: IncomingMessage): string {
    return `${message.provider}:${message.channelId}`;
  }

  function enqueue(message: IncomingMessage, options?: EnqueueOptions): void {
    const k = key(message);
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k)!.push({ message, options });

    if (!processing.has(k)) {
      void processNext(k);
    }
  }

  async function processNext(k: string): Promise<void> {
    const queue = queues.get(k);
    if (!queue || queue.length === 0) {
      processing.delete(k);
      return;
    }

    processing.add(k);
    const { message, options } = queue.shift()!;

    const provider = deps.getProvider(message.provider);
    if (!provider) {
      void deps.logger.error(
        'queue:no-provider',
        `unknown provider="${message.provider}" channel=${message.channelId}`,
      );
      void processNext(k);
      return;
    }

    const conv = provider.resolveConversation(message);
    if (!conv) {
      void processNext(k);
      return;
    }

    const target = { provider: message.provider, channelId: message.channelId };
    const messageTarget = { ...target, messageId: message.messageId };

    let reaction: ReactionHandle | undefined;
    if (provider.react) {
      try {
        reaction = await provider.react(messageTarget, '⏳');
      } catch {
        // best-effort indicator; ignore failures
      }
    }

    const typingInterval = provider.sendTyping
      ? setInterval(() => {
          provider.sendTyping?.(target).catch(() => {});
        }, 8000)
      : null;
    if (provider.sendTyping) {
      provider.sendTyping(target).catch(() => {});
    }

    try {
      let attachmentRefs = '';
      const attachmentsToProcess = options?.attachmentsOverride ?? message.attachments;
      if (attachmentsToProcess.length > 0) {
        try {
          const agentCwd = await deps.maestro.getAgentCwd(conv.agentId);
          if (agentCwd) {
            const result = await download(attachmentsToProcess, agentCwd);
            attachmentRefs = fmtAttachments(result.downloaded);
            if (result.failed.length > 0) {
              await provider.send(target, {
                text: `⚠️ Failed to download: ${result.failed.join(', ')}. Sending message without those files.`,
              });
            }
          } else {
            await provider.send(target, {
              text: '⚠️ Could not resolve agent working directory for file downloads.',
            });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          void deps.logger.error(
            'queue:attachment-download',
            `agent=${conv.agentId} channel=${message.channelId} error=${errMsg}`,
          );
          await provider.send(target, {
            text: '⚠️ Failed to download attachments. Sending message without them.',
          });
        }
      }

      const fullMessage = [options?.contentOverride ?? message.content, attachmentRefs]
        .filter(Boolean)
        .join('\n\n');
      const result = await deps.maestro.send(
        conv.agentId,
        fullMessage,
        conv.sessionId ?? undefined,
        conv.readOnly,
      );

      if (!conv.sessionId && result.sessionId) {
        conv.persistSession(result.sessionId);
      }

      if (typingInterval) clearInterval(typingInterval);

      try {
        await reaction?.remove();
      } catch {
        // ignore cleanup failure
      }

      if (!result.success || !result.response) {
        const reason = result.error ?? 'The agent could not complete this request.';
        const hint = conv.readOnly
          ? '\n-# The agent is in **read-only** mode and cannot modify files.'
          : '';
        void deps.logger.error(
          'queue:agent-failure',
          `agent=${conv.agentId} session=${conv.sessionId ?? 'new'} channel=${message.channelId} reason=${reason}`,
        );
        await provider.send(target, { text: `⚠️ ${reason}${hint}` });
      } else {
        const parts = split(result.response);
        for (const part of parts) {
          await provider.send(target, { text: part });
        }
      }

      const cost = (result.usage?.totalCostUsd ?? 0).toFixed(4);
      const ctx = (result.usage?.contextUsagePercent ?? 0).toFixed(1);
      const tokens = (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      await provider.send(target, {
        text: `-# 💬 ${tokens} tokens • $${cost} • ${ctx}% context${conv.readOnly ? ' • 📖 read-only' : ''}`,
      });
    } catch (err) {
      if (typingInterval) clearInterval(typingInterval);
      try {
        await reaction?.remove();
      } catch {
        /* best-effort */
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      void deps.logger.error(
        'queue:send-error',
        `agent=${conv.agentId} session=${conv.sessionId ?? 'new'} channel=${message.channelId} error=${errMsg}`,
      );
      await provider.send(target, {
        text: `❌ Failed to get response from agent:\n\`\`\`\n${errMsg}\n\`\`\``,
      });
    }

    void processNext(k);
  }

  return { enqueue };
}
