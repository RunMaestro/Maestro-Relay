import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  downloadAttachments,
  formatAttachmentRefs,
  cleanupAgentFiles,
  MAX_FILE_SIZE,
  DEFAULT_FILES_SUBDIR,
  DownloadedFile,
} from '../core/attachments';
import type { IncomingAttachment } from '../core/types';

function makeAttachment(overrides: Partial<IncomingAttachment> & { name: string; url: string; size: number }): IncomingAttachment {
  return {
    contentType: 'application/octet-stream',
    ...overrides,
  };
}

function okResponse(body: string | Buffer): Response {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    ok: true,
    status: 200,
    arrayBuffer: () =>
      Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
  } as unknown as Response;
}

function failResponse(status: number): Response {
  return {
    ok: false,
    status,
    arrayBuffer: () => Promise.reject(new Error('should not be called')),
  } as unknown as Response;
}

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'attachments-test-'));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  await rm(tmpDir, { recursive: true, force: true });
});

test('downloadAttachments creates the default files subdirectory', async () => {
  globalThis.fetch = () => Promise.resolve(okResponse('content'));

  const result = await downloadAttachments(
    [makeAttachment({ name: 'test.txt', url: 'https://cdn.example.com/test.txt', size: 100 })],
    tmpDir,
  );

  const dirStat = await stat(path.join(tmpDir, DEFAULT_FILES_SUBDIR));
  assert.ok(dirStat.isDirectory());
  assert.equal(result.downloaded.length, 1);
  assert.deepEqual(result.failed, []);
});

test('downloadAttachments saves files with UUID-prefixed names', async () => {
  globalThis.fetch = () => Promise.resolve(okResponse('file content'));

  const { downloaded, failed } = await downloadAttachments(
    [makeAttachment({ name: 'photo.png', url: 'https://cdn.example.com/photo.png', size: 500 })],
    tmpDir,
  );

  assert.equal(downloaded.length, 1);
  assert.deepEqual(failed, []);
  assert.equal(downloaded[0].originalName, 'photo.png');
  assert.ok(downloaded[0].savedPath.includes(DEFAULT_FILES_SUBDIR));

  const basename = path.basename(downloaded[0].savedPath);
  assert.match(basename, /^[0-9a-f-]{36}-photo\.png$/);

  const content = await readFile(downloaded[0].savedPath, 'utf-8');
  assert.equal(content, 'file content');
});

test('downloadAttachments skips oversized attachments and reports them as failed', async () => {
  globalThis.fetch = () => {
    throw new Error('fetch should not be called for oversized files');
  };

  const { downloaded, failed } = await downloadAttachments(
    [
      makeAttachment({
        name: 'huge.bin',
        url: 'https://cdn.example.com/huge.bin',
        size: MAX_FILE_SIZE + 1,
      }),
    ],
    tmpDir,
  );

  assert.equal(downloaded.length, 0);
  assert.deepEqual(failed, ['huge.bin']);
});

test('downloadAttachments skips failed fetches, reports them, and continues', async () => {
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    if (callCount === 1) return Promise.resolve(failResponse(404));
    return Promise.resolve(okResponse('second file'));
  };

  const { downloaded, failed } = await downloadAttachments(
    [
      makeAttachment({
        name: 'missing.txt',
        url: 'https://cdn.example.com/missing.txt',
        size: 100,
      }),
      makeAttachment({ name: 'ok.txt', url: 'https://cdn.example.com/ok.txt', size: 100 }),
    ],
    tmpDir,
  );

  assert.equal(downloaded.length, 1);
  assert.equal(downloaded[0].originalName, 'ok.txt');
  assert.deepEqual(failed, ['missing.txt']);
});

test('downloadAttachments returns empty result for empty list', async () => {
  const result = await downloadAttachments([], tmpDir);
  assert.deepEqual(result, { downloaded: [], failed: [] });
});

test('formatAttachmentRefs produces correct format', () => {
  const files: DownloadedFile[] = [
    { originalName: 'a.txt', savedPath: '/home/agent/files/123-a.txt' },
    { originalName: 'b.png', savedPath: '/home/agent/files/456-b.png' },
  ];
  const result = formatAttachmentRefs(files);
  assert.equal(
    result,
    '[Attached: /home/agent/files/123-a.txt]\n[Attached: /home/agent/files/456-b.png]',
  );
});

test('formatAttachmentRefs returns empty string for empty array', () => {
  assert.equal(formatAttachmentRefs([]), '');
});

test('cleanupAgentFiles removes the default files directory', async () => {
  const filesDir = path.join(tmpDir, DEFAULT_FILES_SUBDIR);
  await mkdir(filesDir, { recursive: true });
  await writeFile(path.join(filesDir, 'test.txt'), 'content');

  await cleanupAgentFiles(tmpDir);

  await assert.rejects(() => stat(path.join(tmpDir, DEFAULT_FILES_SUBDIR)), { code: 'ENOENT' });
});

test('cleanupAgentFiles does not throw if directory does not exist', async () => {
  await assert.doesNotReject(() => cleanupAgentFiles(tmpDir));
});

test('downloadAttachments reports all files as failed when mkdir fails', async () => {
  const fileAsCwd = path.join(tmpDir, 'not-a-directory');
  await writeFile(fileAsCwd, 'x');

  const { downloaded, failed } = await downloadAttachments(
    [
      makeAttachment({ name: 'a.txt', url: 'https://cdn.example.com/a.txt', size: 100 }),
      makeAttachment({ name: 'b.txt', url: 'https://cdn.example.com/b.txt', size: 100 }),
    ],
    fileAsCwd,
  );

  assert.equal(downloaded.length, 0);
  assert.deepEqual(failed, ['a.txt', 'b.txt']);
});

test('downloadAttachments handles partial failures', async () => {
  let callCount = 0;
  globalThis.fetch = () => {
    callCount++;
    if (callCount === 2) return Promise.reject(new Error('network error'));
    return Promise.resolve(okResponse(`content-${callCount}`));
  };

  const { downloaded, failed } = await downloadAttachments(
    [
      makeAttachment({ name: 'first.txt', url: 'https://cdn.example.com/first.txt', size: 100 }),
      makeAttachment({ name: 'broken.txt', url: 'https://cdn.example.com/broken.txt', size: 100 }),
      makeAttachment({ name: 'third.txt', url: 'https://cdn.example.com/third.txt', size: 100 }),
    ],
    tmpDir,
  );

  assert.equal(downloaded.length, 2);
  assert.equal(downloaded[0].originalName, 'first.txt');
  assert.equal(downloaded[1].originalName, 'third.txt');
  assert.deepEqual(failed, ['broken.txt']);
});
