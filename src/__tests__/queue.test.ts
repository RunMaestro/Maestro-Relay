import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, type QueueDeps } from '../core/queue';
import type {
  BridgeProvider,
  ConversationRecord,
  IncomingAttachment,
  IncomingMessage,
} from '../core/types';

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    provider: 'mock',
    messageId: 'msg-1',
    channelId: 'thread-1',
    authorId: 'user-1',
    authorName: 'User One',
    content: 'hello',
    attachments: [],
    isThread: true,
    ...overrides,
  };
}

function defaultSendResult(extra: Record<string, unknown> = {}) {
  return {
    success: true,
    response: 'Agent response',
    sessionId: 'session-1',
    usage: { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.001, contextUsagePercent: 5 },
    ...extra,
  };
}

interface MockProviderInstance extends BridgeProvider {
  sentTexts: string[];
}

interface MockSetup {
  deps: QueueDeps & { _mocks: Record<string, ReturnType<typeof mock.fn>> };
  provider: MockProviderInstance;
  conv: ConversationRecord;
}

function createMocks(overrides: Partial<ConversationRecord> = {}): MockSetup {
  const mockGetAgentCwd = mock.fn(async () => '/home/agent' as string | null);
  const mockSend = mock.fn(async () => defaultSendResult());
  const mockDownload = mock.fn(async () => ({
    downloaded: [] as { originalName: string; savedPath: string }[],
    failed: [] as string[],
  }));
  const mockFormat = mock.fn(() => '');
  const mockLoggerError = mock.fn();
  const mockPersistSession = mock.fn();

  const conv: ConversationRecord = {
    agentId: 'agent-1',
    sessionId: 'session-1',
    readOnly: false,
    persistSession: mockPersistSession as unknown as (s: string) => void,
    ...overrides,
  };

  const sentTexts: string[] = [];
  const provider: MockProviderInstance = {
    name: 'mock',
    sentTexts,
    async start() {},
    async stop() {},
    isReady: () => true,
    resolveConversation: () => conv,
    send: async (_target, msg) => {
      sentTexts.push(msg.text);
    },
    findOrCreateAgentChannel: async () => ({
      channelId: 'channel-1',
      agentId: conv.agentId,
      agentName: 'Agent',
    }),
    react: mock.fn(async () => ({ remove: async () => {} })) as unknown as BridgeProvider['react'],
    sendTyping: async () => {},
  };

  const deps: QueueDeps & { _mocks: Record<string, ReturnType<typeof mock.fn>> } = {
    maestro: { getAgentCwd: mockGetAgentCwd as any, send: mockSend as any },
    getProvider: (name) => (name === 'mock' ? provider : undefined),
    splitMessage: (text: string) => [text],
    downloadAttachments: mockDownload as any,
    formatAttachmentRefs: mockFormat as any,
    logger: { error: mockLoggerError as any },
    _mocks: {
      getAgentCwd: mockGetAgentCwd,
      send: mockSend,
      download: mockDownload,
      format: mockFormat,
      loggerError: mockLoggerError,
      persistSession: mockPersistSession,
    },
  };

  return { deps, provider, conv };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('queue calls downloadAttachments when message has attachments', async () => {
  const { deps, provider } = createMocks();
  const attachmentData = {
    downloaded: [
      { originalName: 'file.txt', savedPath: '/home/agent/.maestro/discord-files/123-file.txt' },
    ],
    failed: [],
  };
  deps._mocks.download.mock.mockImplementation(async () => attachmentData);
  deps._mocks.format.mock.mockImplementation(
    () => '[Attached: /home/agent/.maestro/discord-files/123-file.txt]',
  );

  const { enqueue } = createQueue(deps);
  const attachments: IncomingAttachment[] = [
    { url: 'https://cdn.example.com/file.txt', name: 'file.txt', size: 100 },
  ];
  enqueue(makeMessage({ content: 'check this file', attachments }));
  await settle();

  assert.equal(deps._mocks.download.mock.callCount(), 1);
  assert.equal(deps._mocks.getAgentCwd.mock.callCount(), 1);
  assert.equal(deps._mocks.getAgentCwd.mock.calls[0].arguments[0], 'agent-1');

  assert.equal(deps._mocks.format.mock.callCount(), 1);

  assert.equal(deps._mocks.send.mock.callCount(), 1);
  const sentMessage = deps._mocks.send.mock.calls[0].arguments[1];
  assert.equal(
    sentMessage,
    'check this file\n\n[Attached: /home/agent/.maestro/discord-files/123-file.txt]',
  );

  // Provider should have been used for the agent reply + the cost line
  assert.ok(provider.sentTexts.includes('Agent response'));
});

test('queue does not call downloadAttachments when message has no attachments', async () => {
  const { deps } = createMocks();
  const { enqueue } = createQueue(deps);

  enqueue(makeMessage({ content: 'just text' }));
  await settle();

  assert.equal(deps._mocks.download.mock.callCount(), 0);
  assert.equal(deps._mocks.getAgentCwd.mock.callCount(), 0);
  assert.equal(deps._mocks.send.mock.callCount(), 1);
  assert.equal(deps._mocks.send.mock.calls[0].arguments[1], 'just text');
});

test('queue sends only attachment refs when message content is empty', async () => {
  const { deps } = createMocks();
  deps._mocks.download.mock.mockImplementation(async () => ({
    downloaded: [
      { originalName: 'img.png', savedPath: '/home/agent/.maestro/discord-files/456-img.png' },
    ],
    failed: [],
  }));
  deps._mocks.format.mock.mockImplementation(
    () => '[Attached: /home/agent/.maestro/discord-files/456-img.png]',
  );

  const { enqueue } = createQueue(deps);
  enqueue(
    makeMessage({
      content: '',
      attachments: [{ url: 'https://cdn.example.com/img.png', name: 'img.png', size: 200 }],
    }),
  );
  await settle();

  assert.equal(deps._mocks.send.mock.callCount(), 1);
  assert.equal(
    deps._mocks.send.mock.calls[0].arguments[1],
    '[Attached: /home/agent/.maestro/discord-files/456-img.png]',
  );
});

test('queue handles attachment download failure gracefully', async () => {
  const { deps, provider } = createMocks();
  deps._mocks.download.mock.mockImplementation(async () => {
    throw new Error('Network timeout');
  });

  const { enqueue } = createQueue(deps);
  enqueue(
    makeMessage({
      content: 'check this file',
      attachments: [{ url: 'https://cdn.example.com/file.txt', name: 'file.txt', size: 100 }],
    }),
  );
  await settle();

  assert.equal(deps._mocks.loggerError.mock.callCount(), 1);
  const logArgs = deps._mocks.loggerError.mock.calls[0].arguments;
  assert.equal(logArgs[0], 'queue:attachment-download');
  assert.ok((logArgs[1] as string).includes('Network timeout'));

  assert.ok(provider.sentTexts.some((t) => t.includes('Failed to download attachments')));
  assert.equal(deps._mocks.send.mock.callCount(), 1);
  assert.equal(deps._mocks.send.mock.calls[0].arguments[1], 'check this file');
});

test('queue shows specific file names when some downloads fail', async () => {
  const { deps, provider } = createMocks();
  deps._mocks.download.mock.mockImplementation(async () => ({
    downloaded: [
      { originalName: 'ok.txt', savedPath: '/home/agent/.maestro/discord-files/ok.txt' },
    ],
    failed: ['broken.png', 'huge.bin'],
  }));
  deps._mocks.format.mock.mockImplementation(
    () => '[Attached: /home/agent/.maestro/discord-files/ok.txt]',
  );

  const { enqueue } = createQueue(deps);
  enqueue(
    makeMessage({
      content: 'files here',
      attachments: [
        { url: 'u1', name: 'ok.txt', size: 100 },
        { url: 'u2', name: 'broken.png', size: 100 },
        { url: 'u3', name: 'huge.bin', size: 100 },
      ],
    }),
  );
  await settle();

  assert.ok(
    provider.sentTexts.some((t) => t.includes('broken.png') && t.includes('huge.bin')),
    'expected a warning naming the failed files',
  );

  assert.equal(deps._mocks.send.mock.callCount(), 1);
  const sentMessage = deps._mocks.send.mock.calls[0].arguments[1];
  assert.ok((sentMessage as string).includes('[Attached:'));
});

test('queue warns when agent cwd cannot be resolved for attachments', async () => {
  const { deps, provider } = createMocks();
  deps._mocks.getAgentCwd.mock.mockImplementation(async () => null);

  const { enqueue } = createQueue(deps);
  enqueue(
    makeMessage({
      content: 'here is a file',
      attachments: [{ url: 'https://cdn.example.com/file.txt', name: 'file.txt', size: 100 }],
    }),
  );
  await settle();

  assert.equal(deps._mocks.download.mock.callCount(), 0);
  assert.ok(
    provider.sentTexts.some((t) => t.includes('Could not resolve agent working directory')),
    'expected a warning about unresolved agent cwd',
  );
});

test('queue uses contentOverride when provided', async () => {
  const { deps } = createMocks();
  const { enqueue } = createQueue(deps);
  enqueue(makeMessage({ content: 'original text' }), { contentOverride: 'transcribed text' });
  await settle();

  assert.equal(deps._mocks.send.mock.callCount(), 1);
  assert.equal(deps._mocks.send.mock.calls[0].arguments[1], 'transcribed text');
});

test('queue skips attachment downloads when attachmentsOverride is empty', async () => {
  const { deps } = createMocks();
  const { enqueue } = createQueue(deps);
  enqueue(
    makeMessage({
      content: 'voice text',
      attachments: [{ url: 'https://cdn.example.com/voice.ogg', name: 'voice.ogg', size: 100 }],
    }),
    { attachmentsOverride: [] },
  );
  await settle();

  assert.equal(deps._mocks.download.mock.callCount(), 0);
  assert.equal(deps._mocks.send.mock.callCount(), 1);
  assert.equal(deps._mocks.send.mock.calls[0].arguments[1], 'voice text');
});

test('queue downloads only the attachmentsOverride list (drops voice in mixed messages)', async () => {
  const { deps } = createMocks();
  const downloadedFile = {
    originalName: 'photo.png',
    savedPath: '/home/agent/.maestro/discord-files/photo.png',
  };
  deps._mocks.download.mock.mockImplementation(async () => ({
    downloaded: [downloadedFile],
    failed: [],
  }));
  deps._mocks.format.mock.mockImplementation(() => `[Attached: ${downloadedFile.savedPath}]`);

  const image: IncomingAttachment = {
    url: 'https://cdn.example.com/photo.png',
    name: 'photo.png',
    size: 100,
  };
  const overrideAttachments: IncomingAttachment[] = [image];

  const { enqueue } = createQueue(deps);
  enqueue(
    makeMessage({
      content: 'see photo',
      attachments: [
        { url: 'https://cdn.example.com/voice.ogg', name: 'voice.ogg', size: 100 },
        image,
      ],
    }),
    {
      contentOverride: 'see photo\n\nhello from voice',
      attachmentsOverride: overrideAttachments,
    },
  );
  await settle();

  assert.equal(deps._mocks.download.mock.callCount(), 1);
  assert.equal(
    deps._mocks.download.mock.calls[0].arguments[0],
    overrideAttachments,
    'queue should pass the override (image only), not the original mixed attachments',
  );
  assert.equal(deps._mocks.send.mock.callCount(), 1);
  assert.equal(
    deps._mocks.send.mock.calls[0].arguments[1],
    `see photo\n\nhello from voice\n\n[Attached: ${downloadedFile.savedPath}]`,
  );
});

test('queue persists session id from the first response', async () => {
  const { deps } = createMocks({ sessionId: null });
  const { enqueue } = createQueue(deps);
  enqueue(makeMessage());
  await settle();

  assert.equal(deps._mocks.persistSession.mock.callCount(), 1);
  assert.equal(deps._mocks.persistSession.mock.calls[0].arguments[0], 'session-1');
});

test('queue drops messages whose conversation cannot be resolved', async () => {
  const { deps, provider } = createMocks();
  provider.resolveConversation = () => null;

  const { enqueue } = createQueue(deps);
  enqueue(makeMessage());
  await settle();

  assert.equal(deps._mocks.send.mock.callCount(), 0);
});

test('queue logs and skips when the named provider is not registered', async () => {
  const { deps } = createMocks();
  deps.getProvider = () => undefined;

  const { enqueue } = createQueue(deps);
  enqueue(makeMessage({ provider: 'ghost' }));
  await settle();

  assert.equal(deps._mocks.send.mock.callCount(), 0);
  assert.equal(deps._mocks.loggerError.mock.callCount(), 1);
  assert.equal(deps._mocks.loggerError.mock.calls[0].arguments[0], 'queue:no-provider');
});
