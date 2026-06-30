import path from 'path';
import { maestro } from '../../../core/maestro';
import type { TelegramCommandContext } from './types';

export const command = 'auto-run';
export const description = "Launch one of this agent's Auto Run documents";

/**
 * Resolve `doc` (a user-supplied filename, relative path, or absolute path)
 * to a normalized path strictly contained within `folder`. Returns null when
 * the resolved path escapes the folder.
 */
export function resolveContainedDocPath(folder: string, doc: string): string | null {
  const folderResolved = path.resolve(folder);
  const candidate = path.isAbsolute(doc) ? doc : path.join(folderResolved, doc);
  const resolved = path.resolve(candidate);
  if (resolved === folderResolved) return null;
  const prefix = folderResolved.endsWith(path.sep) ? folderResolved : folderResolved + path.sep;
  if (!resolved.startsWith(prefix)) return null;
  return resolved;
}

async function getAgentFolder(agentId: string): Promise<string | null> {
  try {
    const agent = await maestro.showAgent(agentId);
    return typeof agent.autoRunFolderPath === 'string' ? agent.autoRunFolderPath : null;
  } catch {
    return null;
  }
}

export async function execute(ctx: TelegramCommandContext): Promise<void> {
  const sub = ctx.args[0];
  if (sub !== 'start') {
    await ctx.reply(
      'Usage: /auto-run start <doc-path>\n' +
        'doc-path is a filename or relative path inside the bound agent\'s Auto Run folder.',
    );
    return;
  }

  const doc = ctx.args[1];
  if (!doc) {
    await ctx.reply('Missing document. Usage: /auto-run start <doc-path>');
    return;
  }

  const folder = await getAgentFolder(ctx.boundAgentId);
  if (!folder) {
    await ctx.reply(
      "❌ Could not determine this agent's Auto Run folder. " +
        'Open the agent in Maestro and configure one, then try again.',
    );
    return;
  }

  const docPath = resolveContainedDocPath(folder, doc);
  if (!docPath) {
    await ctx.reply(
      "❌ Document must live inside this agent's Auto Run folder. " +
        'Use a filename or relative subpath (no `..` traversal or absolute paths outside the folder).',
    );
    return;
  }

  try {
    await maestro.startAutoRun({
      agentId: ctx.boundAgentId,
      docs: [docPath],
    });
  } catch (err) {
    await ctx.reply(
      `❌ Auto Run failed to launch: ${(err as Error).message.slice(0, 1500)}`,
    );
    return;
  }

  await ctx.reply(
    `▶️ Launched Auto Run for ${ctx.boundAgentName} with ${path.basename(docPath)}.\n` +
      'Watch this chat for progress.',
  );
}
