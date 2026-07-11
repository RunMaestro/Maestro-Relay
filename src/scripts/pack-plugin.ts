/**
 * CLI: package the relay plugin into a signed, installable Maestro `.tgz`.
 *
 * This is the pre-install packaging step the architecture doc mandates. It runs
 * in Node (build tooling, NOT the sandbox) and drives Maestro's OWN plugin CLI
 * (`maestro-cli plugin sign|validate|pack`) so what we sign and pack is exactly
 * what the desktop app verifies at install time — no re-implementation to drift.
 *
 * Pipeline:
 *   1. Rebuild `plugin/entry.js` (sandbox-verified) unless `--no-build`.
 *   2. Stage a copy of `plugin/` into a build dir (the committed source stays
 *      pristine — no signature.json, no operator agent ids leak into the repo).
 *   3. Optionally inject an `agents:dispatch` allowlist naming `--agents <ids>`.
 *   4. Sign the staged copy (`--key <pem>`, or `--gen-key --key-out <pem>`).
 *   5. Validate the staged copy with the signer key trusted (must be `trusted`).
 *   6. Pack the staged copy into a distributable `.tgz`.
 *
 * Run via `npm run pack:plugin -- [options]`.
 *
 * Options:
 *   --agents <a,b>      Comma-separated EXACT agent ids for the dispatch allowlist.
 *   --key <path>        ed25519 private key (PEM or base64 PKCS8) to sign with.
 *   --gen-key           Mint a fresh keypair (requires --key-out); prints pubkey.
 *   --key-out <path>    Where --gen-key writes the private key.
 *   --out <path>        Output archive path (default plugin-dist/<id>-<version>.tgz).
 *   --stage <path>      Staging dir (default plugin-dist/stage).
 *   --maestro-cli <p>   Path to maestro-cli.js (else $MAESTRO_CLI, else the
 *                       default install path).
 *   --no-build          Skip the entry.js rebuild (use the existing bundle).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildPluginEntry } from '../plugin/build';
import { injectAgentsDispatch, parseAgentIds } from '../plugin/packaging';

/** Files copied from the source plugin dir into the staging dir. */
const PLUGIN_FILES = ['plugin.json', 'entry.js', 'panel.html', 'README.md'] as const;

/** Default location Maestro's Linux app resources ship maestro-cli.js. */
const DEFAULT_MAESTRO_CLI = '/opt/Maestro/resources/maestro-cli.js';

interface PackArgs {
  agents?: string;
  key?: string;
  genKey: boolean;
  keyOut?: string;
  out?: string;
  stage?: string;
  maestroCli?: string;
  build: boolean;
}

/** Parse argv into typed options (throws on an unknown flag). */
function parseArgs(argv: string[]): PackArgs {
  const args: PackArgs = { genKey: false, build: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} requires a value`);
      return v;
    };
    switch (flag) {
      case '--agents':
        args.agents = value();
        break;
      case '--key':
        args.key = value();
        break;
      case '--gen-key':
        args.genKey = true;
        break;
      case '--key-out':
        args.keyOut = value();
        break;
      case '--out':
        args.out = value();
        break;
      case '--stage':
        args.stage = value();
        break;
      case '--maestro-cli':
        args.maestroCli = value();
        break;
      case '--no-build':
        args.build = false;
        break;
      default:
        throw new Error(`unknown option: ${flag}`);
    }
  }
  return args;
}

/** Resolve the maestro-cli entrypoint (flag > env > default install path). */
function resolveMaestroCli(explicit: string | undefined): string {
  const candidate = explicit ?? process.env.MAESTRO_CLI ?? DEFAULT_MAESTRO_CLI;
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `maestro-cli not found at "${candidate}". Pass --maestro-cli <path> or set MAESTRO_CLI ` +
        `to your Maestro install's maestro-cli.js (packaging a Maestro plugin needs the host CLI).`,
    );
  }
  return candidate;
}

/** Read a string field off a CLI JSON result (returns undefined when absent). */
function readString(result: Record<string, unknown>, key: string): string | undefined {
  const value = result[key];
  return typeof value === 'string' ? value : undefined;
}

/** Extract stdout from an execFileSync error without an inline cast. */
function execErrorStdout(error: unknown): string {
  if (error && typeof error === 'object' && 'stdout' in error) {
    const out = error.stdout;
    if (typeof out === 'string') return out;
  }
  return '';
}

/**
 * Run a `maestro-cli plugin <...>` subcommand with `--json` and return the parsed
 * result. Maestro prints its JSON to stdout on both success and failure (failure
 * exits non-zero), so we parse stdout in either path and throw on `success:false`.
 */
function runPluginCli(cli: string, subArgs: string[]): Record<string, unknown> {
  const argv = [cli, 'plugin', ...subArgs, '--json'];
  let stdout: string;
  try {
    stdout = execFileSync('node', argv, { encoding: 'utf8' });
  } catch (error) {
    stdout = execErrorStdout(error);
    if (!stdout) throw error;
  }
  const line = stdout.trim().split('\n').filter((l) => l.trim()).pop() ?? '';
  const parsed: Record<string, unknown> = JSON.parse(line);
  if (parsed.success === false) {
    const detail = readString(parsed, 'error') ?? JSON.stringify(parsed);
    throw new Error(`maestro-cli plugin ${subArgs[0]} failed: ${detail}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.key && !args.genKey) {
    throw new Error(
      'a signing key is required — pass --key <path>, or --gen-key --key-out <path> to mint one. ' +
        "The plugin holds trusted-only capabilities (net:connect), so an unsigned package won't run.",
    );
  }
  if (args.genKey && !args.keyOut) {
    throw new Error('--gen-key requires --key-out <path> to write the generated private key');
  }

  const repoRoot = process.cwd();
  const cli = resolveMaestroCli(args.maestroCli);
  const sourceDir = path.join(repoRoot, 'plugin');
  const distDir = path.join(repoRoot, 'plugin-dist');
  const stageDir = path.resolve(args.stage ?? path.join(distDir, 'stage'));

  // 1. Rebuild the sandbox-safe bundle.
  if (args.build) {
    const { bytes, outPath } = await buildPluginEntry();
    console.log(`[1/6] Built ${path.relative(repoRoot, outPath)} (${bytes} bytes) — sandbox-safe.`);
  } else {
    console.log('[1/6] Skipped entry.js rebuild (--no-build).');
  }

  // 2. Stage a pristine copy of the source plugin dir.
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const file of PLUGIN_FILES) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(stageDir, file));
  }
  console.log(`[2/6] Staged ${PLUGIN_FILES.length} files -> ${path.relative(repoRoot, stageDir)}`);

  // 3. Inject the agents:dispatch allowlist (operator-specific) when requested.
  const stagedManifest = path.join(stageDir, 'plugin.json');
  if (args.agents !== undefined) {
    const ids = parseAgentIds(args.agents);
    const manifest: Record<string, unknown> = JSON.parse(fs.readFileSync(stagedManifest, 'utf8'));
    const injected = injectAgentsDispatch(manifest, ids);
    fs.writeFileSync(stagedManifest, JSON.stringify(injected, null, 2) + '\n', 'utf8');
    console.log(`[3/6] Injected agents:dispatch allowlist: ${ids.join(', ')}`);
  } else {
    console.log(
      '[3/6] No --agents given: base package omits agents:dispatch (message routing stays off ' +
        'until you re-pack with --agents <ids>).',
    );
  }

  // 4. Sign the staged copy with the host CLI. The key existence is guaranteed by
  //    the guards above; narrow with `if` so no unchecked cast is needed.
  const signArgs = ['sign', stageDir];
  let generatedKeyOut: string | undefined;
  if (args.genKey && args.keyOut) {
    generatedKeyOut = path.resolve(args.keyOut);
    signArgs.push('--gen-key', '--key-out', generatedKeyOut);
  } else if (args.key) {
    signArgs.push('--key', path.resolve(args.key));
  }
  const signResult = runPluginCli(cli, signArgs);
  const publicKey = readString(signResult, 'publicKey') ?? '';
  console.log(`[4/6] Signed staged copy. Public key (add to Maestro's trusted set):\n       ${publicKey}`);
  if (generatedKeyOut) {
    console.log(`       Private key written to ${generatedKeyOut} — keep it secret.`);
  }

  // 5. Validate with the signer key trusted; abort unless the host resolves it trusted.
  const validateResult = runPluginCli(cli, ['validate', stageDir, '--trusted-key', publicKey]);
  const signature = validateResult.signature;
  const status =
    signature && typeof signature === 'object' && 'status' in signature ? signature.status : undefined;
  if (validateResult.valid !== true || status !== 'trusted') {
    throw new Error(
      `staged plugin failed the trusted-signature check (valid=${String(validateResult.valid)}, ` +
        `signature=${String(status)})`,
    );
  }
  console.log('[5/6] Validated staged copy: manifest OK, signature trusted.');

  // 6. Pack into the distributable archive.
  const manifest: Record<string, unknown> = JSON.parse(fs.readFileSync(stagedManifest, 'utf8'));
  const id = readString(manifest, 'id') ?? 'plugin';
  const version = readString(manifest, 'version') ?? '0.0.0';
  const outPath = path.resolve(args.out ?? path.join(distDir, `${id}-${version}.tgz`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const packResult = runPluginCli(cli, ['pack', stageDir, '--out', outPath]);
  const files = packResult.files;
  const bytes = packResult.bytes;
  console.log(
    `[6/6] Packed ${String(files)} file(s), ${String(bytes)} bytes -> ${path.relative(repoRoot, outPath)}`,
  );
  console.log(
    '\nInstall it from Maestro Settings -> Plugins, enable it, approve the requested capabilities' +
      (args.agents !== undefined ? ' (incl. the agents:dispatch allowlist)' : '') +
      ', and enter the bot tokens in the config panel.',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
