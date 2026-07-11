/**
 * CLI: bundle the relay plugin and write the sandbox-safe `plugin/entry.js`.
 * Fails (non-zero exit) if the bundle contains anything the sandbox forbids.
 *
 * Run via `npm run build:plugin`.
 */

import { buildPluginEntry } from '../plugin/build';

async function main(): Promise<void> {
  const { bytes, outPath } = await buildPluginEntry();
  console.log(`Wrote ${outPath} (${bytes} bytes) — sandbox-safe.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
