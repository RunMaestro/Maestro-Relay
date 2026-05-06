import { promises as fs } from 'fs';
import path from 'path';
import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import { channelDb } from '../channelsDb';
import { maestro } from '../../../core/maestro';

export const data = new SlashCommandBuilder()
  .setName('auto-run')
  .setDescription("Launch one of this agent's Auto Run documents")
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription("Configure and launch an Auto Run for this channel's agent")
      .addStringOption((opt) =>
        opt
          .setName('doc')
          .setDescription('Auto Run document (filename or path)')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt.setName('prompt').setDescription('Override the default prompt').setRequired(false),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('max_loops')
          .setDescription('Loop the run up to N times')
          .setMinValue(1)
          .setMaxValue(50)
          .setRequired(false),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('reset_on_completion')
          .setDescription('Reset all task checkboxes when the run finishes')
          .setRequired(false),
      ),
  );

async function getAgentFolder(agentId: string): Promise<string | null> {
  try {
    const agent = await maestro.showAgent(agentId);
    const folder = agent.autoRunFolderPath;
    return typeof folder === 'string' ? folder : null;
  } catch {
    return null;
  }
}

/**
 * Resolve `doc` (a user-supplied filename, relative path, or absolute path)
 * to a normalized path strictly contained within `folder`. Returns null when
 * the resolved path escapes the folder (e.g. `..` traversal or an absolute
 * path pointing elsewhere) — callers must reject in that case.
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

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'doc') return interaction.respond([]);

  const channelInfo = channelDb.get(interaction.channelId);
  if (!channelInfo) return interaction.respond([]);

  const folder = await getAgentFolder(channelInfo.agent_id);
  if (!folder) return interaction.respond([]);

  let entries: string[];
  try {
    const dirents = await fs.readdir(folder, { withFileTypes: true, recursive: true });
    entries = dirents
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
      .map((d) => {
        const abs = path.join(d.parentPath, d.name);
        return path.relative(folder, abs).split(path.sep).join('/');
      });
  } catch {
    return interaction.respond([]);
  }

  const value = focused.value.toLowerCase();
  await interaction.respond(
    entries
      .filter((n) => n.toLowerCase().includes(value))
      .slice(0, 25)
      .map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })),
  );
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub !== 'start') return;

  const channelInfo = channelDb.get(interaction.channelId);
  if (!channelInfo) {
    await interaction.reply({
      content: '❌ This channel is not connected to an agent. Use `/agents new` first.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const doc = interaction.options.getString('doc', true);
  const prompt = interaction.options.getString('prompt') ?? undefined;
  const maxLoops = interaction.options.getInteger('max_loops') ?? undefined;
  const resetOnCompletion =
    interaction.options.getBoolean('reset_on_completion') ?? undefined;

  // Enforce containment within the agent's Auto Run folder. Reject absolute
  // paths pointing elsewhere and `..` traversal that escapes.
  const folder = await getAgentFolder(channelInfo.agent_id);
  if (!folder) {
    await interaction.editReply(
      "❌ Could not determine this agent's Auto Run folder. Open the agent in Maestro and configure one, then try again.",
    );
    return;
  }
  const docPath = resolveContainedDocPath(folder, doc);
  if (!docPath) {
    await interaction.editReply(
      "❌ Document must live inside this agent's Auto Run folder. Use a filename or relative subpath (no `..` traversal or absolute paths outside the folder).",
    );
    return;
  }

  try {
    await maestro.startAutoRun({
      agentId: channelInfo.agent_id,
      docs: [docPath],
      prompt,
      maxLoops,
      resetOnCompletion,
    });
  } catch (err) {
    await interaction.editReply(
      `❌ Auto Run failed to launch: ${(err as Error).message.slice(0, 1500)}`,
    );
    return;
  }

  const lines: string[] = [
    `▶️ Launched Auto Run for **${channelInfo.agent_name}** with \`${path.basename(docPath)}\`.`,
  ];
  if (maxLoops != null) lines.push(`Looping up to ${maxLoops} times.`);
  if (prompt) lines.push('Custom prompt set.');
  if (resetOnCompletion) lines.push('Tasks will reset on completion.');
  lines.push('Watch the agent channel for progress.');

  await interaction.editReply(lines.join('\n'));
}
