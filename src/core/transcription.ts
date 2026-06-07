import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { constants } from 'fs';
import { mkdir, readFile, rm, writeFile, access } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { config } from './config';
import { logger } from './logger';
import type { IncomingAttachment } from './types';

/**
 * Voice transcription pipeline. Provider-agnostic: accepts a generic
 * IncomingAttachment, downloads it, transcodes via ffmpeg, transcribes
 * via whisper-cli. Each provider decides which messages/attachments to
 * route through this.
 */

export const MAX_VOICE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const execFileAsync = promisify(execFile);

let transcriberAvailable = false;
let resolvedFfmpegPath: string | null = null;
let resolvedWhisperCliPath: string | null = null;

async function resolveExecutable(configPath: string, executableName: string): Promise<string> {
  const isAbsolutePath = path.isAbsolute(configPath);

  if (isAbsolutePath) {
    await access(configPath, constants.X_OK);
    return configPath;
  }

  try {
    await execFileAsync(configPath, ['--help'], { timeout: 5000 });
    return configPath;
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'ENOENT' || e.code === 'EACCES') {
      throw new Error(`Could not resolve ${executableName} in PATH or as executable`, {
        cause: err,
      });
    }
    return configPath;
  }
}

export function getResolvedFfmpegPath(): string {
  return resolvedFfmpegPath || config.ffmpegPath;
}

export function getResolvedWhisperCliPath(): string {
  return resolvedWhisperCliPath || config.whisperCliPath;
}

export function isTranscriberAvailable(): boolean {
  return transcriberAvailable;
}

export async function checkTranscriptionDependencies(): Promise<void> {
  const missing: string[] = [];

  try {
    resolvedFfmpegPath = await resolveExecutable(config.ffmpegPath, 'ffmpeg');
  } catch {
    missing.push(`ffmpeg (${config.ffmpegPath})`);
  }

  try {
    resolvedWhisperCliPath = await resolveExecutable(config.whisperCliPath, 'whisper-cli');
  } catch {
    missing.push(`whisper-cli (${config.whisperCliPath})`);
  }

  try {
    await access(config.whisperModelPath);
  } catch {
    missing.push(`whisper model (${config.whisperModelPath})`);
  }

  if (missing.length > 0) {
    logger.warn(
      'transcription/deps',
      `Transcription disabled: missing dependencies: ${missing.join(', ')}. ` +
        'Voice message transcription will be unavailable. See README for setup instructions.',
    );
    transcriberAvailable = false;
  } else {
    logger.info('transcription/deps', 'Voice transcription enabled.');
    transcriberAvailable = true;
  }
}

async function runCommand(executable: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(executable, args, { timeout: 300000, killSignal: 'SIGKILL' });
  } catch (err: unknown) {
    const e = err as {
      message?: string;
      stderr?: string;
      stdout?: string;
      code?: number | string;
    };
    const detail = [e.code ? `exit code: ${e.code}` : '', e.stderr?.trim(), e.stdout?.trim()]
      .filter(Boolean)
      .join(' | ');
    throw new Error(`${e.message ?? 'Command failed'}${detail ? ` (${detail})` : ''}`, {
      cause: err,
    });
  }
}

/**
 * Transcribe a voice attachment using ffmpeg + whisper-cli. Operates on a
 * generic IncomingAttachment so each provider can decide how to extract its
 * voice payload.
 */
export async function transcribeVoiceAttachment(attachment: IncomingAttachment): Promise<string> {
  if (typeof attachment.size === 'number' && attachment.size > MAX_VOICE_ATTACHMENT_BYTES) {
    throw new Error(
      `Voice attachment is ${attachment.size} bytes, exceeds limit of ${MAX_VOICE_ATTACHMENT_BYTES} bytes.`,
    );
  }

  const tempDir = path.join(os.tmpdir(), `maestro-relay-voice-${randomUUID()}`);
  const inputPath = path.join(tempDir, 'input.ogg');
  const wavPath = path.join(tempDir, 'input.wav');
  const outputBase = path.join(tempDir, 'transcript');
  const outputTxtPath = `${outputBase}.txt`;

  await mkdir(tempDir, { recursive: true });
  try {
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`Failed to download voice attachment: HTTP ${response.status}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    await writeFile(inputPath, audioBuffer);

    await runCommand(getResolvedFfmpegPath(), [
      '-y',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-sample_fmt',
      's16',
      wavPath,
    ]);

    await runCommand(getResolvedWhisperCliPath(), [
      '-m',
      config.whisperModelPath,
      '-l',
      config.whisperLanguage,
      '-f',
      wavPath,
      '-otxt',
      '-of',
      outputBase,
    ]);

    const transcription = (await readFile(outputTxtPath, 'utf8')).trim();
    if (!transcription) {
      throw new Error(
        'Whisper returned an empty transcription (the audio may be silent or speech was not detected).',
      );
    }
    return transcription;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch((err) => {
      logger.error(
        'transcription',
        `Failed to clean up temp transcription files at "${tempDir}": ${err.message || err}`,
      );
    });
  }
}

/** Common heuristic: voice messages are .ogg / audio/ogg. */
export function isVoiceContentType(contentType: string | undefined, name: string): boolean {
  const ct = contentType?.toLowerCase() ?? '';
  return ct === 'audio/ogg' || name.toLowerCase().endsWith('.ogg');
}
