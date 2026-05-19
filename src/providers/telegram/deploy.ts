import { Bot } from 'grammy';
import { telegramConfig } from './config';
import { COMMANDS } from './commands';

async function main() {
  const bot = new Bot(telegramConfig.token);
  const list = Object.entries(COMMANDS).map(([command, { description }]) => ({
    command,
    description,
  }));
  console.log(`Registering ${list.length} Telegram commands…`);
  await bot.api.setMyCommands(list);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
