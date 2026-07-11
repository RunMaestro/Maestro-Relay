/**
 * CLI: bundle the relay plugin and write the sandbox-safe `plugin/entry.js`.
 * Fails (non-zero exit) if the bundle contains anything the sandbox forbids.
 *
 * Run via `npm run build:plugin`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bundlePlugin, findSandboxViolations, PLUGIN_ENTRY_OUTPUT } from '../plugin/build';

async function main(): Promise<void> {
  const { code } = await bundlePlugin();
  const violations = findSandboxViolations(code);
  if (violations.length > 0) {
    console.error('Sandbox-safety violations in bundled plugin/entry.js:');
    for (const violation of violations) {
      console.error(`  - ${violation.token}: …${violation.snippet}…`);
    }
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(PLUGIN_ENTRY_OUTPUT), { recursive: true });
  fs.writeFileSync(PLUGIN_ENTRY_OUTPUT, code, 'utf8');
  console.log(`Wrote ${PLUGIN_ENTRY_OUTPUT} (${code.length} bytes) — sandbox-safe.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
