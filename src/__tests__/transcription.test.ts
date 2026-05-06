import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VOICE_ATTACHMENT_BYTES, transcribeVoiceAttachment } from '../core/transcription';
import { isVoiceMessage } from '../providers/discord/voice';

test('isVoiceMessage returns true only when MessageFlags.IsVoiceMessage is set', () => {
  // MessageFlags.IsVoiceMessage = 8192
  const voice = { flags: { has: (bit: number) => bit === 8192 } };
  const regular = { flags: { has: () => false } };
  const noFlags = {};

  assert.equal(isVoiceMessage(voice as any), true);
  assert.equal(isVoiceMessage(regular as any), false);
  assert.equal(isVoiceMessage(noFlags as any), false);
});

test('transcribeVoiceAttachment rejects oversized attachments without touching disk or network', async () => {
  const oversized = {
    size: MAX_VOICE_ATTACHMENT_BYTES + 1,
    url: 'https://cdn.discord.com/should-not-be-fetched.ogg',
    name: 'huge.ogg',
  };

  await assert.rejects(
    () => transcribeVoiceAttachment(oversized as any),
    /exceeds limit/,
    'should reject before any fetch/mkdir',
  );
});
