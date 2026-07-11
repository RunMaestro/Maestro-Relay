/**
 * Build tooling (runs in Node, NOT in the sandbox) that bundles the relay plugin
 * sources into the single sandbox-safe CommonJS file the Maestro host loads as
 * `plugin/entry.js`.
 *
 * The sandbox exposes only `maestro`, `module`, `exports`, `console`,
 * `setTimeout`, `clearTimeout`, `Promise` and the JS intrinsics — there is no
 * `require`, `process`, `Buffer`, `setInterval`, or dynamic `import()`. esbuild
 * inlines every import, so a clean bundle of self-contained sources contains none
 * of those. {@link findSandboxViolations} statically verifies that invariant so a
 * regression (an accidental Node-builtin import) fails the build instead of the
 * plugin silently crashing on load.
 */

import * as path from 'node:path';
import { build } from 'esbuild';

/** Absolute path to the plugin entry source. Resolved from the repo root, which
 * is the working directory for both `npm run build:plugin` and `npm test`. */
export const PLUGIN_ENTRY_SOURCE = path.resolve(process.cwd(), 'src/plugin/entry.ts');

/** Absolute path where the bundled, sandbox-safe entry is written. */
export const PLUGIN_ENTRY_OUTPUT = path.resolve(process.cwd(), 'plugin/entry.js');

export interface PluginBundle {
  code: string;
}

export interface SandboxViolation {
  token: string;
  snippet: string;
}

/** Tokens whose presence in the bundle would break in the sandbox. */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ token: string; pattern: RegExp }> = [
  { token: 'require(', pattern: /\brequire\s*\(/ },
  { token: '__require', pattern: /\b__require\b/ },
  { token: 'process.', pattern: /\bprocess\s*\./ },
  { token: 'Buffer', pattern: /\bBuffer\b/ },
  { token: 'setInterval', pattern: /\bsetInterval\b/ },
  { token: 'import(', pattern: /\bimport\s*\(/ },
  { token: 'import.meta', pattern: /\bimport\s*\.\s*meta\b/ },
];

/** Return every sandbox-safety violation found in `code` (empty when clean). */
export function findSandboxViolations(code: string): SandboxViolation[] {
  const violations: SandboxViolation[] = [];
  for (const { token, pattern } of FORBIDDEN_PATTERNS) {
    const match = pattern.exec(code);
    if (match) {
      const start = Math.max(0, match.index - 30);
      violations.push({ token, snippet: code.slice(start, match.index + 40).replace(/\n/g, ' ') });
    }
  }
  return violations;
}

/** Bundle the plugin to an in-memory CommonJS string (does not write to disk). */
export async function bundlePlugin(): Promise<PluginBundle> {
  const result = await build({
    entryPoints: [PLUGIN_ENTRY_SOURCE],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error('esbuild produced no output for the plugin bundle');
  return { code: output.text };
}
