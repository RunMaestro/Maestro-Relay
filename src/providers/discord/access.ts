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
 *
 * Two commands that read on the surface sit on the admin side of that line:
 * `/session new` writes (it creates a Discord thread and registers a row in
 * the thread registry), and `/notes synopsis` runs `director-notes synopsis`,
 * which is an AI inference on the host and therefore costs money per call.
 */
const VIEWER_COMMANDS = new Set([
  'health',
  'agents:list',
  'agents:show',
  'session:list',
  'playbook:list',
  'playbook:show',
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
 *
 * That back-compat only covers the case where *neither* list is set. Admins
 * empty with viewers set is a configuration that could not exist before this
 * file, so it carries no obligation — and reading it as "open to everyone"
 * inverts the operator's obvious intent. `configError` rejects it at startup;
 * this fails closed too, so the boundary does not depend on that check having
 * run.
 */
export function isAuthorized(userId: string, tier: Tier, lists: AccessLists): boolean {
  if (lists.admins.length === 0) {
    if (lists.viewers.length === 0) return true;
    return tier === 'viewer' && lists.viewers.includes(userId);
  }
  if (lists.admins.includes(userId)) return true;
  return tier === 'viewer' && lists.viewers.includes(userId);
}

/**
 * A viewer list with no admin list is incoherent: the operator has said who
 * should be restricted without saying who should not be. Returns a message to
 * refuse startup with, or null when the combination is fine.
 */
export function configError(lists: AccessLists): string | null {
  if (lists.viewers.length > 0 && lists.admins.length === 0) {
    return (
      'DISCORD_VIEWER_USER_IDS is set but DISCORD_ALLOWED_USER_IDS is empty. That pairing has ' +
      'no coherent meaning: setting a viewer list says some users should be restricted, while ' +
      'an empty admin list says nobody is. Set DISCORD_ALLOWED_USER_IDS to the operators who ' +
      'should hold full access, or unset DISCORD_VIEWER_USER_IDS to leave the bot open.'
    );
  }
  return null;
}

/**
 * Non-fatal configuration notes to log at startup, or null when there is
 * nothing to say. Fatal combinations live in `configError`.
 */
export function configWarning(lists: AccessLists): string | null {
  const both = lists.viewers.filter((id) => lists.admins.includes(id));
  if (both.length > 0) {
    return `User(s) ${both.join(', ')} appear in both DISCORD_ALLOWED_USER_IDS and DISCORD_VIEWER_USER_IDS; admin wins.`;
  }
  return null;
}
