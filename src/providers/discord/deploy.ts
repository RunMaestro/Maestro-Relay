import { REST, Routes } from 'discord.js';
import { discordConfig } from './config';
import * as health from './commands/health';
import * as agents from './commands/agents';
import * as session from './commands/session';
import * as playbook from './commands/playbook';
import * as gist from './commands/gist';
import * as notes from './commands/notes';
import * as autoRun from './commands/auto-run';

const commands = [
  health.data.toJSON(),
  agents.data.toJSON(),
  session.data.toJSON(),
  playbook.data.toJSON(),
  gist.data.toJSON(),
  notes.data.toJSON(),
  autoRun.data.toJSON(),
];

const rest = new REST().setToken(discordConfig.token);

(async () => {
  console.log('Deploying slash commands...');
  await rest.put(
    Routes.applicationGuildCommands(discordConfig.clientId, discordConfig.guildId),
    { body: commands },
  );
  console.log('Done.');
})();
