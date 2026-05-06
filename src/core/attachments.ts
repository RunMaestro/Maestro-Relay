import { mkdir, rm, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import type { IncomingAttachment } from './types';

export interface DownloadedFile {
  originalName: string;
  savedPath: string;
}

export interface DownloadResult {
  downloaded: DownloadedFile[];
  failed: string[];
}

export const MAX_FILE_SIZE = 25 * 1024 * 1024;
/** Default subdirectory under the agent cwd. Providers may pass their own. */
export const DEFAULT_FILES_SUBDIR = '.maestro/discord-files';

/**
 * Download a list of attachments to the agent's working directory.
 * Provider-agnostic: each attachment is fetched by URL.
 */
export async function downloadAttachments(
  attachments: IncomingAttachment[],
  agentCwd: string,
  subdir: string = DEFAULT_FILES_SUBDIR,
): Promise<DownloadResult> {
  const targetDir = path.join(agentCwd, subdir);
  try {
    await mkdir(targetDir, { recursive: true });
  } catch (err) {
    console.warn(`[attachments] Failed to create directory "${targetDir}":`, err);
    return { downloaded: [], failed: attachments.map((a) => a.name) };
  }

  const downloaded: DownloadedFile[] = [];
  const failed: string[] = [];

  for (const attachment of attachments) {
    if (attachment.size > MAX_FILE_SIZE) {
      console.warn(
        `[attachments] Skipping "${attachment.name}" (${attachment.size} bytes) — exceeds ${MAX_FILE_SIZE} byte limit`,
      );
      failed.push(attachment.name);
      continue;
    }

    const safeName = path.basename(attachment.name);
    const filename = `${randomUUID()}-${safeName}`;
    const savedPath = path.join(targetDir, filename);

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.warn(
          `[attachments] Failed to download "${attachment.name}": HTTP ${response.status}`,
        );
        failed.push(attachment.name);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(savedPath, buffer);
      downloaded.push({ originalName: attachment.name, savedPath });
    } catch (err) {
      console.warn(`[attachments] Error downloading "${attachment.name}":`, err);
      failed.push(attachment.name);
    }
  }

  return { downloaded, failed };
}

/** Remove a downloaded-files directory for an agent. Best-effort. */
export async function cleanupAgentFiles(
  agentCwd: string,
  subdir: string = DEFAULT_FILES_SUBDIR,
): Promise<void> {
  const dir = path.join(agentCwd, subdir);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

export function formatAttachmentRefs(files: DownloadedFile[]): string {
  if (files.length === 0) return '';
  return files.map((f) => `[Attached: ${f.savedPath}]`).join('\n');
}
