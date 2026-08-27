/**
 * Two-tier slash-command access control.
 *
 * `DISCORD_ALLOWED_USER_IDS` is a single all-or-nothing list: anyone on it can
 * run every command, including the ones that make an agent execute something.
 * That leaves an operator who wants to give a collaborator `/health` and
 * `/session list` with no option but to hand over `/auto-run start` too.
 *
 * This adds a second, weaker list. A viewer may run commands that only read.
 * An admin may run everything, exactly as before.
 *
 * The tier table below is deliberately a denylist-by-omission: a command that
 * is not classified is treated as ADMIN. A command added later is therefore
 * closed to viewers until someone classifies it on purpose, which is the safe
 * direction for the mistake to point.
 */

export type Tier = 'admin' | 'viewer';

/**
 * Commands a viewer may run, keyed `command` or `command:subcommand`.
 *
 * The line is *execution and outbound disclosure*: a viewer cannot make an
 * agent run anything, cannot change relay state, and cannot publish outward.
 * Reading is allowed.
 */
const VIEWER_COMMANDS = new Set([
  'health',
  'agents:list',
  'agents:show',
  'session:new',
  'session:list',
  'playbook:list',
  'playbook:show',
  'notes:synopsis',
  'notes:history',
]);

/**
 * The tier a command requires. Unknown commands and unknown subcommands
 * resolve to `admin` — see the note above about which way the mistake points.
 */
export function requiredTier(commandName: string, subcommand?: string | null): Tier {
  const key = subcommand ? `${commandName}:${subcommand}` : commandName;
  return VIEWER_COMMANDS.has(key) ? 'viewer' : 'admin';
}

export interface AccessLists {
  admins: string[];
  viewers: string[];
}

/**
 * Whether `userId` may run something requiring `tier`.
 *
 * An empty admin list means no restriction at all, which is the documented
 * behavior of `DISCORD_ALLOWED_USER_IDS` today and must not change: a
 * deployment that never set it stays open.
 */
export function isAuthorized(userId: string, tier: Tier, lists: AccessLists): boolean {
  if (lists.admins.length === 0) return true;
  if (lists.admins.includes(userId)) return true;
  return tier === 'viewer' && lists.viewers.includes(userId);
}

/**
 * A viewer list with no admin list does nothing — everyone is already an admin.
 * Returns a warning to log at startup, or null when the config is coherent.
 */
export function configWarning(lists: AccessLists): string | null {
  if (lists.viewers.length > 0 && lists.admins.length === 0) {
    return (
      'DISCORD_VIEWER_USER_IDS is set but DISCORD_ALLOWED_USER_IDS is empty, so every user ' +
      'is already an admin and the viewer list has no effect. Set DISCORD_ALLOWED_USER_IDS ' +
      'to the operators who should hold full access.'
    );
  }
  const both = lists.viewers.filter((id) => lists.admins.includes(id));
  if (both.length > 0) {
    return `User(s) ${both.join(', ')} appear in both DISCORD_ALLOWED_USER_IDS and DISCORD_VIEWER_USER_IDS; admin wins.`;
  }
  return null;
}
