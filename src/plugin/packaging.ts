/**
 * Pure packaging helpers (run in Node, NOT in the sandbox) shared by the
 * `pack:plugin` build script.
 *
 * The distributable `plugin/plugin.json` deliberately OMITS the `agents:dispatch`
 * permission: its scope kind is `allowlist`, so Maestro rejects an unscoped
 * request as a wildcard and only accepts a comma-separated list of the operator's
 * EXACT agent ids (verified against the host's `parsePermissions`). Those ids are
 * install-specific and any manifest edit invalidates the signature, so injecting
 * them is a pre-install packaging step performed on a staged copy — never on the
 * committed source manifest. These helpers do the id validation and injection.
 */

/** The dispatch permission shape Maestro's manifest validator accepts. */
export interface DispatchPermission {
  capability: 'agents:dispatch';
  scope: string;
  reason: string;
}

/** Human-readable reason baked into the injected permission. */
export const DISPATCH_REASON = 'Route chat messages to the bound Maestro agents.';

/**
 * Parse a comma-separated `--agents` value into validated, exact agent ids.
 * Mirrors the host's allowlist rule: each member must be non-empty and contain
 * no whitespace or `*` wildcard (Maestro rejects those as forbidden characters).
 * Throws on empty input or any malformed id.
 */
export function parseAgentIds(raw: string): string[] {
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error('no agent ids provided (expected a comma-separated list of exact ids)');
  }
  for (const id of ids) {
    if (/[\s*]/.test(id)) {
      throw new Error(
        `agent id "${id}" contains forbidden characters — allowlist members must be exact ids (no wildcards or whitespace)`,
      );
    }
  }
  return ids;
}

/** Build the `agents:dispatch` permission for the given validated ids. */
export function buildDispatchPermission(ids: string[]): DispatchPermission {
  return {
    capability: 'agents:dispatch',
    scope: ids.join(','),
    reason: DISPATCH_REASON,
  };
}

/** Is this value a permission entry whose capability is `agents:dispatch`? */
function isDispatchPermission(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'capability' in value &&
    value.capability === 'agents:dispatch'
  );
}

/**
 * Return a deep clone of `manifest` with an `agents:dispatch` permission naming
 * `ids`. Any pre-existing `agents:dispatch` entry is replaced (idempotent), so
 * re-running the packer with different ids never accumulates duplicates.
 */
export function injectAgentsDispatch(
  manifest: Record<string, unknown>,
  ids: string[],
): Record<string, unknown> {
  const clone: Record<string, unknown> = JSON.parse(JSON.stringify(manifest));
  const raw = clone.permissions;
  const existing: unknown[] = Array.isArray(raw) ? raw : [];
  clone.permissions = [...existing.filter((p) => !isDispatchPermission(p)), buildDispatchPermission(ids)];
  return clone;
}
