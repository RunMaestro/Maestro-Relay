import test from 'node:test';
import assert from 'node:assert/strict';
import {
  translateActivity,
  mapAttachments,
} from '../providers/teams/messageCreate';

/**
 * Pure-helper unit tests for the Teams inbound translation layer. These exercise
 * `translateActivity` / `mapAttachments` against hand-built activity objects and
 * never touch the `botbuilder` runtime (no platform turn context required).
 */

test('translateActivity maps a Teams activity to an IncomingMessage', () => {
  const activity = {
    id: 'msg-1',
    text: 'raw text',
    from: { id: 'user-id', name: 'Ada', aadObjectId: 'aad-1' },
    conversation: { id: 'conv-1', tenantId: 'tenant-1' },
  };

  const msg = translateActivity(activity, 'cleaned content');

  assert.equal(msg.provider, 'teams');
  assert.equal(msg.messageId, 'msg-1');
  assert.equal(msg.channelId, 'conv-1');
  assert.equal(msg.authorId, 'aad-1');
  assert.equal(msg.authorName, 'Ada');
  assert.equal(msg.content, 'cleaned content');
  assert.equal(msg.isThread, false);
  assert.deepEqual(msg.attachments, []);
  assert.equal(msg.raw, activity);
});

test('translateActivity falls back to conversation.id when activity.id is absent', () => {
  const activity = {
    from: { id: 'user-id', name: 'Ada' },
    conversation: { id: 'conv-2' },
  };

  const msg = translateActivity(activity, 'hi');

  assert.equal(msg.messageId, 'conv-2');
  assert.equal(msg.channelId, 'conv-2');
});

test('translateActivity prefers from.aadObjectId for authorId, falling back to from.id', () => {
  const withAad = translateActivity(
    {
      from: { id: 'user-id', name: 'Ada', aadObjectId: 'aad-9' },
      conversation: { id: 'c' },
    },
    'x',
  );
  assert.equal(withAad.authorId, 'aad-9');

  const withoutAad = translateActivity(
    {
      from: { id: 'user-id', name: 'Ada' },
      conversation: { id: 'c' },
    },
    'x',
  );
  assert.equal(withoutAad.authorId, 'user-id');
});

test('translateActivity uses authorId as authorName when from.name is absent', () => {
  const msg = translateActivity(
    {
      from: { id: 'user-id', aadObjectId: 'aad-7' },
      conversation: { id: 'c' },
    },
    'x',
  );
  assert.equal(msg.authorName, 'aad-7');
});

test('mapAttachments drops entries without a contentUrl and maps valid ones', () => {
  const out = mapAttachments([
    { name: 'no-url.txt', contentType: 'text/plain' },
    {
      contentUrl: 'https://example.com/file.pdf',
      name: 'file.pdf',
      contentType: 'application/pdf',
    },
  ]);

  assert.deepEqual(out, [
    {
      url: 'https://example.com/file.pdf',
      name: 'file.pdf',
      size: 0,
      contentType: 'application/pdf',
    },
  ]);
});

test('mapAttachments prefers content.downloadUrl over contentUrl for uploaded files', () => {
  const out = mapAttachments([
    {
      contentType: 'application/vnd.microsoft.teams.file.download.info',
      name: 'report.pdf',
      contentUrl: 'https://sharepoint.example.com/page', // the SharePoint page, NOT the bytes
      content: { downloadUrl: 'https://download.example.com/report.pdf' },
    },
  ]);

  assert.deepEqual(out, [
    {
      url: 'https://download.example.com/report.pdf',
      name: 'report.pdf',
      size: 0,
      contentType: 'application/vnd.microsoft.teams.file.download.info',
    },
  ]);
});

test('mapAttachments returns [] for undefined and defaults a missing name to ""', () => {
  assert.deepEqual(mapAttachments(undefined), []);

  const out = mapAttachments([{ contentUrl: 'https://example.com/x' }]);
  assert.deepEqual(out, [
    { url: 'https://example.com/x', name: '', size: 0, contentType: undefined },
  ]);
});

test('translateActivity carries mapped attachments through', () => {
  const msg = translateActivity(
    {
      id: 'm',
      from: { id: 'u', name: 'Ada' },
      conversation: { id: 'c' },
      attachments: [
        { contentUrl: 'https://example.com/a', name: 'a', contentType: 'image/png' },
        { name: 'dropped' },
      ],
    },
    'x',
  );

  assert.deepEqual(msg.attachments, [
    { url: 'https://example.com/a', name: 'a', size: 0, contentType: 'image/png' },
  ]);
});
