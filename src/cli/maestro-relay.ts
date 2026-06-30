#!/usr/bin/env node
import { runNotify, notifyUsage } from './verbs/notify';
import { runSend, sendUsage } from './verbs/send';
import { runStatus, statusUsage } from './verbs/status';

const ROOT_USAGE = `Usage: maestro-relay <verb> [options]

Verbs:
  send      Send a message to an agent's bridge channel
  notify    Post a styled toast/flash notification to an agent's channel
  status    Post the agent's current status (cwd, usage, tokens) to its channel

Run 'maestro-relay <verb> --help' for verb-specific options.`;

function printRootHelp(): void {
  console.log(ROOT_USAGE);
  console.log('\n--- send ---\n' + sendUsage);
  console.log('\n--- notify ---\n' + notifyUsage);
  console.log('\n--- status ---\n' + statusUsage);
}

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);

  if (!verb || verb === '--help' || verb === '-h') {
    printRootHelp();
    process.exit(verb ? 0 : 1);
  }

  switch (verb) {
    case 'send':
      await runSend(rest);
      return;
    case 'notify':
      await runNotify(rest);
      return;
    case 'status':
      await runStatus(rest);
      return;
    default:
      console.error(`Unknown verb: ${verb}\n`);
      console.error(ROOT_USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
