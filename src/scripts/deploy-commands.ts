import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';

const PROVIDER_DEPLOY_SCRIPTS: Record<string, string> = {
  discord: path.resolve(__dirname, '..', 'providers', 'discord', 'deploy.js'),
  telegram: path.resolve(__dirname, '..', 'providers', 'telegram', 'deploy.js'),
  teams: path.resolve(__dirname, '..', 'providers', 'teams', 'deploy.js'),
};

const KNOWN_PROVIDERS = new Set(['discord', 'slack', 'telegram', 'teams']);

function parseEnabledProviders(): string[] {
  const raw = process.env.ENABLED_PROVIDERS;
  if (!raw) return ['discord'];
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown = names.filter((n) => !KNOWN_PROVIDERS.has(n));
  if (unknown.length > 0) {
    console.error(
      `[deploy-commands] Unknown provider name(s) in ENABLED_PROVIDERS: ${unknown.join(', ')}. ` +
        `Allowed: ${[...KNOWN_PROVIDERS].join(', ')}.`,
    );
    process.exit(1);
  }
  return names;
}

function runDeploy(provider: string, scriptPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', (err) => {
      console.error(`[deploy-commands] Failed to spawn ${provider} deploy:`, err);
      resolve(false);
    });
  });
}

type Outcome = 'ok' | 'failed' | 'skipped';

async function main() {
  const enabled = parseEnabledProviders();
  if (enabled.length === 0) {
    console.error('[deploy-commands] ENABLED_PROVIDERS is empty — nothing to deploy.');
    process.exitCode = 1;
    return;
  }

  console.log(`[deploy-commands] Enabled providers: ${enabled.join(', ')}`);
  const results: Array<{ provider: string; status: Outcome }> = [];

  for (const provider of enabled) {
    const script = PROVIDER_DEPLOY_SCRIPTS[provider];
    if (!script) {
      console.log(
        `[deploy-commands] Provider "${provider}" has no deploy script — skipping.`,
      );
      results.push({ provider, status: 'skipped' });
      continue;
    }
    console.log(`\n[deploy-commands] Running ${provider} deploy (${script})...`);
    const ok = await runDeploy(provider, script);
    results.push({ provider, status: ok ? 'ok' : 'failed' });
  }

  console.log('\n[deploy-commands] Summary:');
  for (const r of results) {
    console.log(`  ${r.provider}: ${r.status}`);
  }

  if (results.some((r) => r.status === 'failed')) {
    process.exitCode = 1;
  }
}

main();
