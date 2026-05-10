import * as health from './health';
import * as agents from './agents';
import * as session from './session';
import * as gist from './gist';
import * as playbook from './playbook';
import * as notes from './notes';
import * as autoRun from './auto-run';
import type { TelegramCommandContext, TelegramCommandModule } from './types';

type CommandEntry = {
  description: string;
  execute: (ctx: TelegramCommandContext) => Promise<void>;
};

const modules: TelegramCommandModule[] = [
  health,
  agents,
  session,
  gist,
  playbook,
  notes,
  autoRun,
];

export const COMMANDS: Record<string, CommandEntry> = Object.fromEntries(
  modules.map((m) => [m.command, { description: m.description, execute: m.execute }]),
);

export type DispatchCommandContext = Omit<
  TelegramCommandContext,
  'args' | 'rawText' | 'reply'
> & {
  reply: TelegramCommandContext['reply'];
};

const COMMAND_PATTERN = /^\/(\S+)\s*([\s\S]*)$/;

export async function dispatchCommand(
  rawText: string,
  ctx: DispatchCommandContext,
): Promise<boolean> {
  const trimmed = rawText.trimStart();
  const match = trimmed.match(COMMAND_PATTERN);
  if (!match) return false;

  const [, head, rest] = match;
  const command = head.split('@', 1)[0].toLowerCase();

  const entry = COMMANDS[command];
  if (!entry) return false;

  const args = rest.length ? rest.split(/\s+/).filter(Boolean) : [];

  const fullCtx: TelegramCommandContext = {
    ...ctx,
    args,
    rawText,
  };
  await entry.execute(fullCtx);
  return true;
}
