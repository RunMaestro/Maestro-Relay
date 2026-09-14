#!/usr/bin/env node
/**
 * relay-doctor — health check and self-heal for a deployed Maestro Relay.
 *
 * Runs unattended on a Cue heartbeat. Each check knows how to repair the
 * failure it detects; anything it cannot repair is escalated to an agent with
 * the evidence already gathered, so nobody has to go log-diving by hand.
 *
 * Exit codes are the contract with the scheduler:
 *   0  healthy, nothing done
 *   1  a fault was found and repaired
 *   2  a fault was found that needs a human or an agent
 *
 * The design bias is passive detection. The relay already writes every
 * user-visible failure to errors.log, so watching that log is both cheaper and
 * more truthful than synthesising traffic. The one active probe (`--probe`)
 * costs a model call and is therefore rate-limited by `probeIntervalMinutes`.
 *
 * Usage:
 *   relay-doctor.mjs [--json] [--dry-run] [--probe] [--force-probe] [--reset] [--no-agent]
 */

import { execFile, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// --- Configuration -------------------------------------------------------

const HOME = homedir();

const CONFIG = {
  /** Where the relay actually runs from (what install.sh deploys). */
  installDir: process.env.MAESTRO_RELAY_HOME || join(HOME, '.local/share/maestro-relay'),
  /** The git checkout we build patched releases from. */
  sourceDir: process.env.MAESTRO_RELAY_SRC || join(HOME, 'Projects/Maestro-Relay'),
  /**
   * The branch the running relay is supposed to be built from. Every feature
   * we write is written to be run, so anything merged here and absent from the
   * install dir is a fault, not a difference of opinion.
   */
  deployBranch: process.env.MAESTRO_RELAY_DEPLOY_BRANCH || 'kensho/deployed',
  apiPort: Number(process.env.RELAY_API_PORT || 3457),
  launchdLabel: 'sh.maestro.relay',
  /** Agent that receives escalations. */
  escalateAgentId: process.env.RELAY_DOCTOR_AGENT || '4ff9478e-17be-4b43-b92a-5d4e7dd28277',
  /** Minutes between active end-to-end probes; they cost a real model call. */
  probeIntervalMinutes: Number(process.env.RELAY_DOCTOR_PROBE_MINUTES || 180),
  /** Minutes an escalated signature stays silent before it may escalate again. */
  escalateCooldownMinutes: Number(process.env.RELAY_DOCTOR_COOLDOWN_MINUTES || 45),
  /** Repairs attempted for one signature before the doctor stops trying. */
  maxRepairAttempts: Number(process.env.RELAY_DOCTOR_MAX_REPAIRS || 3),
  /**
   * What the doctor probes to tell a network outage from a relay fault. Any
   * HTTP answer counts as reachable. Only a failed connection counts as down.
   */
  upstreamProbeUrl: process.env.RELAY_DOCTOR_UPSTREAM_URL || 'https://discord.com/api/v10/gateway',
  /** Minutes an upstream outage lasts before the desktop is told, once. */
  upstreamNotifyMinutes: Number(process.env.RELAY_DOCTOR_UPSTREAM_NOTIFY_MINUTES || 60),
};

const STATE_PATH =
  process.env.RELAY_DOCTOR_STATE || join(HOME, '.local/state/maestro-relay/doctor-state.json');
const REPORT_DIR =
  process.env.RELAY_DOCTOR_REPORTS || join(HOME, '.local/state/maestro-relay/reports');
const AUDIT_LOG =
  process.env.RELAY_DOCTOR_LOG || join(HOME, '.local/state/maestro-relay/doctor.log');

// Restarts go through launchctl rather than bin/maestro-relay-ctl.sh: the ctl
// script lives in the source checkout, which a deployed relay need not have,
// and its unload/load cycle is slower than a kickstart.
const RELAY_ERROR_LOG = join(CONFIG.installDir, 'logs/errors.log');
const PLIST_PATH =
  process.env.RELAY_PLIST || join(HOME, `Library/LaunchAgents/${'sh.maestro.relay'}.plist`);

/**
 * Known failure signatures, most specific first.
 *
 * `match` is tested against a `queue:*` error line from the relay's own log.
 * `repair` names a repair action defined in REPAIRS; null means the doctor has
 * no safe automatic response and should escalate with the evidence instead.
 */
const SIGNATURES = [
  {
    id: 'cli-stdout-pollution',
    match: /(Unexpected token|Expected ',' or ']'|Unexpected non-whitespace|is not valid JSON)/i,
    // maestro-cli logs some subsystems (WakaTime) through console.info, which
    // Node writes to stdout ahead of the JSON payload. src/core/maestro.ts
    // tolerates this via parseCliJson; seeing it again means the deployed build
    // predates that patch, so redeploying from source is the fix.
    repair: 'redeploy-from-source',
    summary: 'maestro-cli stdout has non-JSON preamble; deployed build is missing the parseCliJson guard',
  },
  {
    id: 'incomplete-deploy',
    // Not matched against a log line — raised directly by checkPatchDrift when
    // the running dist is missing modules the deploy branch defines. The build
    // came from the wrong branch, so rebuilding from source is the fix.
    match: /^(?!)/,
    repair: 'redeploy-from-source',
    summary: 'deployed build is missing modules present on the deploy branch',
  },
  {
    id: 'cli-missing',
    match: /spawn error:.*ENOENT|maestro-cli.*not found/i,
    repair: null,
    summary: 'maestro-cli is not on the relay service PATH',
  },
  {
    id: 'agent-busy',
    match: /is busy|AGENT_BUSY/i,
    repair: null,
    summary: 'target agent was busy — usually self-resolving, not a relay fault',
  },
  {
    id: 'agent-not-found',
    match: /AGENT_NOT_FOUND|Agent not found/i,
    repair: null,
    summary: 'the mapped agent id no longer exists in Maestro',
  },
  {
    id: 'cli-timeout',
    match: /process killed \(timeout\?\)|ETIMEDOUT/i,
    repair: null,
    summary: 'maestro-cli exceeded its timeout',
  },
  {
    id: 'upstream-unreachable',
    // Read by checkService against the relay's provider startup failure, and by
    // checkErrorLog against queue lines like every other entry. The host could
    // not reach the platform, so the network is at fault and a restart cannot
    // help. checkService acts on it only when its own probe also fails.
    match: /ConnectTimeoutError|Connect Timeout Error|Opening handshake has timed out|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/i,
    repair: null,
    summary: 'this host cannot reach the chat platform; the network is down, not the relay',
  },
];

// --- State ---------------------------------------------------------------

const EMPTY_STATE = {
  lastRunIso: null,
  /** Byte offset consumed so far in the relay error log. */
  logOffset: 0,
  /** Inode of the log the offset belongs to, so rotation resets it. */
  logInode: null,
  lastProbeIso: null,
  /** When the doctor first saw the platform unreachable. Null while it is reachable. */
  upstreamOutageSinceIso: null,
  /** When the desktop was told about the current outage, so it is told once. */
  upstreamNotifiedIso: null,
  /** signatureId → { lastEscalatedIso, repairAttempts } */
  signatures: {},
};

function loadState() {
  try {
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Small helpers -------------------------------------------------------

const findings = [];

function record(level, id, detail, extra = {}) {
  findings.push({ level, id, detail, ...extra });
}

async function sh(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 60_000, ...opts });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      message: err.message,
    };
  }
}

/** Fetch with a hard deadline; never throws. */
async function probeUrl(url, timeoutMs = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON; caller decides what that means */
    }
    return { ok: true, status: res.status, json, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function minutesSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - Date.parse(iso)) / 60_000;
}

/**
 * Wait until the relay reports no messages in flight.
 *
 * Returns the number still in flight — 0 means it is safe to restart. An
 * unreachable relay returns 0 as well, since there is nothing to protect.
 */
async function waitForIdle(timeoutMs = 180_000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await probeUrl(`http://127.0.0.1:${CONFIG.apiPort}/api/health`);
    const busy = r.ok && r.json ? (r.json.inFlight ?? 0) : 0;
    if (busy === 0) return 0;
    if (Date.now() >= deadline) return busy;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

/** True once /api/health reports every provider ready. */
async function isHealthy() {
  const r = await probeUrl(`http://127.0.0.1:${CONFIG.apiPort}/api/health`);
  if (!r.ok || r.status !== 200 || r.json?.success !== true) return false;
  return Object.values(r.json.providers || {}).every(Boolean);
}

/**
 * Poll until the relay reports healthy or the deadline passes.
 *
 * A cold `bootstrap` is much slower than a warm `kickstart` — the Discord
 * gateway handshake alone can outlast a fixed sleep — so readiness is polled
 * rather than assumed after a fixed wait.
 */
async function waitForHealthy(timeoutMs = 45_000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isHealthy()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

// --- Repairs -------------------------------------------------------------

const REPAIRS = {
  /** Bounce the service. Fixes a dead, wedged, or disconnected relay. */
  async restart({ dryRun, force }) {
    if (dryRun) return { ok: true, note: 'dry-run: would restart the relay service' };

    // Never cut off a reply in progress. Discord does not redeliver, so a
    // restart mid-turn is how a live question goes unanswered. Wait for the
    // relay to go idle; a genuinely dead relay reports nothing and falls
    // straight through.
    if (!force) {
      const busy = await waitForIdle();
      if (busy > 0) {
        return { ok: false, note: `relay still answering ${busy} message(s); deferring restart` };
      }
    }

    const domain = `gui/${process.getuid()}`;
    let note = 'restarted via launchctl kickstart';

    let r = await sh('launchctl', ['kickstart', '-k', `${domain}/${CONFIG.launchdLabel}`]);
    if (!r.ok) {
      // A crash-loop bootout or a failed login leaves the job fully unloaded,
      // and kickstart cannot revive a job launchd does not know about. Load it
      // from the plist first, then start it.
      if (!existsSync(PLIST_PATH)) {
        return { ok: false, note: `kickstart failed and no plist at ${PLIST_PATH}: ${r.stderr.trim() || r.message}` };
      }
      const boot = await sh('launchctl', ['bootstrap', domain, PLIST_PATH]);
      if (!boot.ok && !/already (bootstrapped|loaded)/i.test(boot.stderr)) {
        return { ok: false, note: `bootstrap failed: ${boot.stderr.trim() || boot.message}` };
      }
      r = await sh('launchctl', ['kickstart', '-k', `${domain}/${CONFIG.launchdLabel}`]);
      if (!r.ok) return { ok: false, note: `kickstart after bootstrap failed: ${r.stderr.trim() || r.message}` };
      note = 'service was unloaded; bootstrapped from plist and started';
    }

    // launchd returns as soon as it has respawned, well before the provider
    // gateway has reconnected. Wait for actual readiness, not for the clock.
    const ready = await waitForHealthy();
    return ready
      ? { ok: true, note }
      : { ok: false, note: `${note}, but the relay did not become healthy within 45s` };
  },

  /**
   * Rebuild from the source checkout and push the result over the deployed
   * dist. This is what recovers a locally-patched relay after `ctl update`
   * reinstalls an upstream release and silently drops our fixes.
   */
  async 'redeploy-from-source'({ dryRun }) {
    if (!existsSync(join(CONFIG.sourceDir, 'package.json'))) {
      return { ok: false, note: `no source checkout at ${CONFIG.sourceDir}` };
    }
    if (dryRun) return { ok: true, note: 'dry-run: would rebuild source and redeploy dist' };

    const build = await sh('npm', ['run', 'build'], { cwd: CONFIG.sourceDir, timeout: 300_000 });
    if (!build.ok) return { ok: false, note: `build failed: ${build.stderr.slice(-500)}` };

    // `npm test` rebuilds before running; call the runner directly against the
    // build we just made. The glob is expanded by the shell, matching the form
    // package.json uses — a bare directory argument is not supported.
    const test = await sh('sh', ['-c', 'node --test dist/__tests__/*.test.js'], {
      cwd: CONFIG.sourceDir,
      timeout: 300_000,
    });
    if (!test.ok) {
      // Never ship a build whose own tests fail, even to fix an outage.
      const tail = (test.stdout || test.stderr).slice(-400);
      return { ok: false, note: `tests failed, refusing to deploy: ${tail}` };
    }

    const sync = await sh('rsync', [
      '-a',
      '--delete',
      `${join(CONFIG.sourceDir, 'dist')}/`,
      `${join(CONFIG.installDir, 'dist')}/`,
    ]);
    if (!sync.ok) return { ok: false, note: `rsync failed: ${sync.message}` };

    const restart = await REPAIRS.restart({ dryRun });
    if (!restart.ok) return restart;
    return { ok: true, note: 'rebuilt from source, tests passed, redeployed, restarted' };
  },
};

// --- Checks --------------------------------------------------------------

/** True while the relay API answers, whether or not its providers are connected. */
async function isServing() {
  const r = await probeUrl(`http://127.0.0.1:${CONFIG.apiPort}/api/health`);
  return r.ok && r.json !== null && typeof r.json.providers === 'object';
}

/** The newest provider startup failure in the relay's error log, or null. */
function lastStartupFailure() {
  if (!existsSync(RELAY_ERROR_LOG)) return null;
  const lines = readFileSync(RELAY_ERROR_LOG, 'utf8')
    .split('\n')
    .filter((l) => l.includes('[bridge/startup]') && l.includes('failed to start'));
  return lines.at(-1) ?? null;
}

/**
 * Can this host reach the chat platform at all?
 *
 * Returns null when it can. Otherwise returns a description of the outage and
 * how long it has lasted. The probe is the evidence. The relay's own startup
 * failure is named beside it when it carries the upstream-unreachable
 * signature, so the report shows both sides agreeing.
 */
async function checkUpstream(state) {
  const probe = await probeUrl(CONFIG.upstreamProbeUrl, 10_000);
  if (probe.ok) {
    state.upstreamOutageSinceIso = null;
    state.upstreamNotifiedIso = null;
    return null;
  }
  if (!state.upstreamOutageSinceIso) state.upstreamOutageSinceIso = new Date().toISOString();
  const minutes = Math.round(minutesSince(state.upstreamOutageSinceIso));
  const sig = SIGNATURES.find((s) => s.id === 'upstream-unreachable');
  const last = lastStartupFailure();
  const agrees = last && sig.match.test(last) ? '; the relay log shows the same failure' : '';
  return `${CONFIG.upstreamProbeUrl} is unreachable from this host (${probe.error}) for ${minutes}m${agrees}`;
}

/** Record an upstream outage, and tell the desktop once when it lasts. */
function noteUpstreamOutage(state, detail, { dryRun }) {
  record('warn', 'upstream-unreachable', detail);
  const lasting = minutesSince(state.upstreamOutageSinceIso) >= CONFIG.upstreamNotifyMinutes;
  if (lasting && !state.upstreamNotifiedIso && !dryRun) {
    state.upstreamNotifiedIso = new Date().toISOString();
    notifyDesktop('Maestro Relay cannot reach its chat platform', detail);
  }
}

/**
 * C1/C2/C3: is the service up, serving, and attached to its provider?
 *
 * A restart repairs the relay. It cannot repair the network between this host
 * and the platform. On 2026-09-14 discord.com timed out for ten hours. Every
 * heartbeat restarted the relay, every restart failed its 45s readiness wait,
 * and an agent was paged for an outage nobody here could fix. So the doctor
 * probes the platform before it blames the relay.
 */
async function checkService({ dryRun }, state) {
  const health = await probeUrl(`http://127.0.0.1:${CONFIG.apiPort}/api/health`);

  // The relay answers 503 while a provider is still connecting. A body with a
  // providers map therefore means the process is serving, whatever the status.
  const serving = health.ok && health.json !== null && typeof health.json.providers === 'object';
  if (serving) {
    const providers = health.json.providers || {};
    const down = Object.entries(providers)
      .filter(([, ready]) => !ready)
      .map(([name]) => name);
    if (health.status === 200 && health.json.success === true && down.length === 0) {
      state.upstreamOutageSinceIso = null;
      state.upstreamNotifiedIso = null;
      record('ok', 'service', `up ${Math.round(health.json.uptime)}s, providers ready`, {
        uptimeSeconds: health.json.uptime,
        providers,
      });
      return { healthy: true };
    }
    record('fault', 'provider-down', `provider(s) not ready: ${down.join(', ') || 'none reported'}`);
  } else {
    const why = health.ok ? `HTTP ${health.status}` : health.error;
    record('fault', 'service-down', `relay API unreachable on :${CONFIG.apiPort} (${why})`);
  }

  const outage = await checkUpstream(state);

  // A serving relay retries its own provider start. A restart would only throw
  // that progress away and start the connection wait again.
  if (serving && outage) {
    noteUpstreamOutage(state, `${outage}. The relay is serving and retrying by itself, so it was not restarted.`, {
      dryRun,
    });
    return { healthy: false, repaired: false };
  }

  // The relay is already unreachable or degraded here, so there is no live
  // reply to protect and waiting for idle would just stall the recovery.
  const repair = await REPAIRS.restart({ dryRun, force: true });
  if (!repair.ok) {
    // The dead process came back and serves, but cannot connect. The relay is
    // repaired. The network is the part still broken, and no restart fixes it.
    if (outage && (await isServing())) {
      record('repaired', 'service', `${repair.note.split(',')[0]}; API serving again`);
      noteUpstreamOutage(state, `${outage}. The relay is serving and retrying by itself.`, { dryRun });
      return { healthy: false, repaired: true };
    }
    record('escalate', 'service-restart-failed', repair.note);
    return { healthy: false, repaired: false };
  }

  if (await waitForHealthy(15_000)) {
    record('repaired', 'service', `${repair.note}; API healthy again`);
    return { healthy: true, repaired: true };
  }
  record('escalate', 'service-down', `restart did not restore the relay (${repair.note})`);
  return { healthy: false, repaired: false };
}

/**
 * C4: has the deployed dist drifted from what the source checkout builds?
 *
 * `maestro-relay-ctl update` reinstalls an upstream release over the install
 * dir, which throws away locally-applied fixes. Comparing mtimes catches that
 * without the cost of a full rebuild on every heartbeat.
 *
 * The presence check alone is not enough, and that gap cost real time. Ambient
 * mode shipped, its migration ran, its per-channel flag was switched on — and
 * the running build had been compiled from a different branch, so none of the
 * code was in the process. Every check passed, because each one asked whether
 * the patches it knew about were *present*. None asked whether anything was
 * *missing*. So the file-completeness check below is the one that matters:
 * every module on the deploy branch must exist in the running dist.
 */
/**
 * A configured feature that silently does nothing is worse than an absent one.
 *
 * Outbound attachments are the case that proved it. The extraction code shipped
 * and worked, but `OUTBOUND_ATTACH_ROOT` was never set, so every `[[attach:]]`
 * marker was stripped and every image was dropped. The message still arrived,
 * minus its chart, and nothing on either side reported the difference. The
 * sender believed a chart had been delivered for as long as nobody checked.
 *
 * So the doctor asserts the pairing directly: if the running build can carry
 * files, the root must be configured, and it must exist.
 */
function checkOutboundAttachments() {
  const deployed = join(CONFIG.installDir, 'dist/core/outboundAttachments.js');
  if (!existsSync(deployed)) {
    record('ok', 'outbound-attachments', 'not in this build; nothing to configure');
    return;
  }

  // The relay reads the value from its own env file, so read it the same way
  // rather than from this process's environment, which may differ.
  const envFile = join(HOME, '.config/maestro-relay/.env');
  let root = process.env.OUTBOUND_ATTACH_ROOT || '';
  if (!root && existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const [k, ...rest] = t.split('=');
      if (k.trim() === 'OUTBOUND_ATTACH_ROOT') {
        root = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  if (!root) {
    record(
      'warn',
      'outbound-attachments',
      'the build can carry files but OUTBOUND_ATTACH_ROOT is unset, so every ' +
        '[[attach:]] marker is stripped and its image is dropped without an error. ' +
        'Add the line to ~/.config/maestro-relay/.env and restart.',
    );
    return;
  }
  if (!existsSync(root)) {
    record('fault', 'outbound-attachments', `attachment root does not exist: ${root}`);
    return;
  }
  record('ok', 'outbound-attachments', `root configured: ${root}`);
}

function checkPatchDrift() {
  const deployed = join(CONFIG.installDir, 'dist/core/maestro.js');
  const source = join(CONFIG.sourceDir, 'src/core/maestro.ts');
  if (!existsSync(deployed) || !existsSync(source)) {
    record('ok', 'patch-drift', 'skipped: source or deployed tree not present');
    return { healthy: true };
  }

  // Every local fix so far lives in maestro.ts; assert the guard is present in
  // the running build rather than trusting timestamps alone.
  const js = readFileSync(deployed, 'utf8');
  if (!js.includes('parseCliJson')) {
    record('fault', 'patch-drift', 'deployed build is missing the parseCliJson stdout guard');
    return { healthy: false, signature: 'cli-stdout-pollution' };
  }

  const missing = missingFromDeployedDist();
  if (missing === null) {
    record('ok', 'patch-drift', 'skipped: deploy branch not readable');
    return { healthy: true };
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ');
    const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
    record(
      'fault',
      'patch-drift',
      `deployed build is missing ${missing.length} module(s) from ${CONFIG.deployBranch}: ${shown}${more}`,
    );
    return { healthy: false, signature: 'incomplete-deploy' };
  }

  if (statSync(source).mtimeMs > statSync(deployed).mtimeMs) {
    record('warn', 'patch-drift', 'source maestro.ts is newer than the deployed build');
  } else {
    record('ok', 'patch-drift', `deployed build matches ${CONFIG.deployBranch}`);
  }
  return { healthy: true };
}

/**
 * Modules the deploy branch defines that the running dist does not contain.
 *
 * Compares file lists, not content — a build from the wrong branch is missing
 * whole modules, which is cheap to see and unambiguous. Content drift within a
 * file is the mtime check's job. Returns null when the branch cannot be read,
 * so a missing checkout reads as "unknown" rather than "everything is fine".
 */
function missingFromDeployedDist() {
  let listing;
  try {
    listing = execFileSync('git', ['ls-tree', '-r', '--name-only', CONFIG.deployBranch], {
      cwd: CONFIG.sourceDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }

  return listing
    .split('\n')
    .filter((f) => f.startsWith('src/') && f.endsWith('.ts') && !f.includes('__tests__'))
    .map((f) => f.replace(/^src\//, '').replace(/\.ts$/, '.js'))
    .filter((f) => !existsSync(join(CONFIG.installDir, 'dist', f)));
}

/**
 * C5: classify anything the relay logged since the last run.
 *
 * Reads only the bytes appended since the previous offset, so a heartbeat is
 * cheap no matter how large the log grows.
 */
function checkErrorLog(state) {
  if (!existsSync(RELAY_ERROR_LOG)) {
    // Mark the watcher as initialised even with no file, so that a log created
    // later is treated as entirely new and gets classified in full rather than
    // silently adopted as a baseline.
    state.logInode = 0;
    state.logOffset = 0;
    record('ok', 'error-log', 'no error log yet');
    return { healthy: true, faults: [] };
  }

  const st = statSync(RELAY_ERROR_LOG);

  if (state.logInode === null) {
    // First run: adopt the current end of the log as the baseline. The doctor
    // is a forward-looking watchdog, and replaying history would repair faults
    // that were already fixed by hand.
    state.logOffset = st.size;
    state.logInode = st.ino;
    record('ok', 'error-log', `baseline set at ${st.size} bytes; watching from here`);
    return { healthy: true, faults: [] };
  }

  let offset = state.logOffset;
  if (state.logInode !== st.ino || offset > st.size) {
    // Rotated or truncated — only classify what is there now.
    offset = 0;
  }
  const fresh = readFileSync(RELAY_ERROR_LOG, 'utf8').slice(offset);
  state.logOffset = st.size;
  state.logInode = st.ino;

  const lines = fresh
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('queue:send-error') || l.includes('queue:agent-failure'));

  if (lines.length === 0) {
    record('ok', 'error-log', 'no new user-visible failures');
    return { healthy: true, faults: [] };
  }

  const byId = new Map();
  for (const line of lines) {
    const sig = SIGNATURES.find((s) => s.match.test(line));
    const id = sig?.id ?? 'unknown';
    if (!byId.has(id)) byId.set(id, { signature: sig, count: 0, sample: line });
    byId.get(id).count += 1;
  }

  const faults = [];
  for (const [id, info] of byId) {
    const summary = info.signature?.summary ?? 'unrecognised failure signature';
    record('fault', `log:${id}`, `${info.count} failure(s): ${summary}`, { sample: info.sample });
    faults.push({ id, repair: info.signature?.repair ?? null, count: info.count, sample: info.sample });
  }
  return { healthy: false, faults };
}

/**
 * C6: active end-to-end probe. Spends a real model call, so it is rate-limited.
 *
 * This is the only check that exercises the whole inbound path the way a
 * Discord message does: spawn maestro-cli, capture stdout, parse the JSON.
 */
async function checkProbe(state, { force, dryRun }) {
  const due = force || minutesSince(state.lastProbeIso) >= CONFIG.probeIntervalMinutes;
  if (!due) {
    record('ok', 'probe', `skipped, next in ${Math.ceil(CONFIG.probeIntervalMinutes - minutesSince(state.lastProbeIso))}m`);
    return { healthy: true };
  }
  if (dryRun) {
    record('ok', 'probe', 'dry-run: would run an end-to-end send probe');
    return { healthy: true };
  }

  state.lastProbeIso = new Date().toISOString();
  const r = await sh(
    'maestro-cli',
    ['send', '--no-system-prompt', CONFIG.escalateAgentId, '--', 'Reply with exactly: PONG'],
    { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
  );

  const raw = r.stdout.trim();
  if (!raw) {
    record('escalate', 'probe', `probe produced no stdout (${r.message ?? 'exit non-zero'})`);
    return { healthy: false };
  }

  // Mirror parseCliJson: tolerate log preamble, then assert the payload is
  // reachable. If it is not, the deployed relay would have failed identically.
  let payload = null;
  let preambleLines = 0;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    try {
      payload = JSON.parse(lines.slice(i).join('\n'));
      preambleLines = i;
      break;
    } catch {
      /* keep scanning */
    }
  }

  if (!payload) {
    record('escalate', 'probe', 'maestro-cli stdout contained no parseable JSON payload', {
      sample: raw.slice(0, 400),
    });
    return { healthy: false };
  }
  if (preambleLines > 0) {
    record(
      'warn',
      'probe',
      `maestro-cli emitted ${preambleLines} non-JSON stdout line(s) before the payload; parseCliJson absorbed it`,
      { sample: lines[0].slice(0, 200) },
    );
  }
  if (payload.success !== true) {
    record('escalate', 'probe', `agent send failed: ${payload.error ?? 'unknown'}`);
    return { healthy: false };
  }
  record('ok', 'probe', `end-to-end send round-trip succeeded (${preambleLines} preamble line(s))`);
  return { healthy: true };
}

// --- Escalation ----------------------------------------------------------

function writeReport(payload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(REPORT_DIR, `doctor-${stamp}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

/**
 * Append a line to the doctor's own log.
 *
 * The doctor is deliberately silent in Discord. That channel is a conversation
 * between people, and infrastructure chatter in it is noise for every human
 * reading. Operational output belongs here and in the JSON reports; the humans
 * find out because the relay works, not because it narrates.
 */
function auditLog(line) {
  try {
    mkdirSync(dirname(AUDIT_LOG), { recursive: true });
    appendFileSync(AUDIT_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* the audit log is advisory */
  }
}

/**
 * Hand an unrepaired fault to an agent to investigate.
 *
 * Detached and unawaited on purpose: the investigation can take minutes and the
 * doctor must not hold a Cue slot open for it. The escalation cooldown in
 * main() is what keeps this from spawning an agent on every heartbeat, and the
 * report file gives the agent the evidence without it re-deriving anything.
 */
function escalateToAgent(report, reportPath) {
  const summary = report.findings
    .filter((f) => f.level === 'escalate' || f.level === 'fault')
    .map((f) => `- ${f.id}: ${f.detail}${f.sample ? `\n  sample: ${f.sample}` : ''}`)
    .join('\n');

  const prompt = [
    'AUTONOMOUS ALERT from relay-doctor. The Maestro Relay has a fault it could not repair by itself.',
    '',
    'Findings:',
    summary,
    '',
    `Full report: ${reportPath}`,
    `Relay source: ${CONFIG.sourceDir}`,
    `Relay install: ${CONFIG.installDir}`,
    `Relay error log: ${RELAY_ERROR_LOG}`,
    '',
    'Diagnose the root cause and fix it. If the fix belongs in the relay source, patch it,',
    'add a regression test, run the suite, and redeploy with scripts/relay-doctor.mjs conventions.',
    'If the failure has a recognisable signature, add it to the SIGNATURES table in',
    'scripts/relay-doctor.mjs so the doctor repairs it unattended next time.',
    'Report what you changed in Discord when done. Do not ask for permission first.',
  ].join('\n');

  try {
    const child = execFile(
      'maestro-cli',
      ['send', CONFIG.escalateAgentId, '--', prompt],
      { timeout: 0 },
      () => {},
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Desktop notification — the path that still works when the relay is down. */
function notifyDesktop(title, message) {
  try {
    execFileSync('osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ]);
  } catch {
    /* notifications are advisory */
  }
}

// --- Main ----------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    forceProbe: argv.includes('--force-probe'),
    probe: argv.includes('--probe') || argv.includes('--force-probe'),
    reset: argv.includes('--reset'),
    /** Notify only; never spawn an agent to investigate. */
    noAgent: argv.includes('--no-agent'),
  };

  const state = opts.reset ? { ...EMPTY_STATE } : loadState();
  state.lastRunIso = new Date().toISOString();

  const service = await checkService(opts, state);

  // Every downstream check reads state the relay only produces while running.
  let logResult = { faults: [] };
  let drift = { healthy: true };
  if (service.healthy) {
    drift = checkPatchDrift();
    checkOutboundAttachments();
    logResult = checkErrorLog(state);
    if (opts.probe) await checkProbe(state, { force: opts.forceProbe, dryRun: opts.dryRun });
  } else {
    record('warn', 'checks-skipped', 'relay is down; skipped log, drift and probe checks');
  }

  // Collect every fault that names a repair, deduplicated by signature.
  const repairable = new Map();
  if (!drift.healthy && drift.signature) {
    const sig = SIGNATURES.find((s) => s.id === drift.signature);
    if (sig?.repair) repairable.set(sig.id, sig.repair);
  }
  for (const f of logResult.faults) {
    if (f.repair) repairable.set(f.id, f.repair);
  }

  for (const [sigId, repairName] of repairable) {
    const seen = state.signatures[sigId] || { repairAttempts: 0, lastEscalatedIso: null };
    if (seen.repairAttempts >= CONFIG.maxRepairAttempts) {
      record('escalate', `repair:${sigId}`, `repair "${repairName}" already failed ${seen.repairAttempts}x; not retrying`);
      state.signatures[sigId] = seen;
      continue;
    }
    const result = await REPAIRS[repairName](opts);
    seen.repairAttempts = result.ok ? 0 : seen.repairAttempts + 1;
    state.signatures[sigId] = seen;
    record(result.ok ? 'repaired' : 'escalate', `repair:${sigId}`, result.note);
  }

  // Anything with no automatic repair becomes an escalation, subject to cooldown.
  const unknown = logResult.faults.filter((f) => !f.repair);
  for (const f of unknown) {
    record('escalate', `unhandled:${f.id}`, `no automatic repair for this signature (${f.count} occurrence(s))`, {
      sample: f.sample,
    });
  }

  const escalations = findings.filter((f) => f.level === 'escalate');
  const repairs = findings.filter((f) => f.level === 'repaired');

  let exitCode = 0;
  if (escalations.length > 0) exitCode = 2;
  else if (repairs.length > 0) exitCode = 1;

  const report = {
    timestamp: state.lastRunIso,
    exitCode,
    // Exit 0 with a fault on record is an upstream outage: nothing here can
    // repair it, so nobody is paged, but the report must not call it healthy.
    status:
      exitCode === 0
        ? findings.some((f) => f.level === 'fault')
          ? 'degraded'
          : 'healthy'
        : exitCode === 1
          ? 'repaired'
          : 'needs-attention',
    findings,
  };

  if (exitCode === 2) {
    // Cooldown is keyed on the set of escalated ids so a persistent fault does
    // not page repeatedly, but a genuinely new fault is never suppressed.
    const key = escalations.map((e) => e.id).sort().join('|');
    const seen = state.signatures[`escalation:${key}`] || {};
    if (minutesSince(seen.lastEscalatedIso) >= CONFIG.escalateCooldownMinutes) {
      state.signatures[`escalation:${key}`] = { lastEscalatedIso: state.lastRunIso };
      const summary = escalations.map((e) => `• ${e.id}: ${e.detail}`).join('\n');
      if (opts.dryRun) {
        report.wouldNotify = summary;
      } else {
        const path = writeReport(report);
        report.reportPath = path;
        notifyDesktop('Maestro Relay needs attention', escalations[0].detail);
        const dispatched = opts.noAgent ? false : escalateToAgent(report, path);
        report.agentDispatched = dispatched;
        auditLog(
          `NEEDS-ATTENTION ${summary.replace(/\n/g, ' | ')} ` +
            `(agent ${dispatched ? 'dispatched' : 'not dispatched'}, report ${path})`,
        );
      }
    } else {
      report.suppressed = `within ${CONFIG.escalateCooldownMinutes}m escalation cooldown`;
    }
  } else if (exitCode === 1) {
    // A successful self-repair is the system working as designed. It gets a log
    // line, not an announcement.
    const summary = repairs.map((r) => `${r.id}: ${r.detail}`).join(' | ');
    if (!opts.dryRun) auditLog(`SELF-REPAIRED ${summary}`);
  }

  if (!opts.dryRun) saveState(state);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const glyph = { ok: '✓', warn: '!', fault: '✗', repaired: '🔧', escalate: '🚨' };
    console.log(`relay-doctor ${report.status} @ ${report.timestamp}`);
    for (const f of findings) console.log(`  ${glyph[f.level] || '?'} ${f.id}: ${f.detail}`);
    if (report.reportPath) console.log(`  report: ${report.reportPath}`);
    if (report.suppressed) console.log(`  (${report.suppressed})`);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`relay-doctor crashed: ${err.stack || err.message}`);
  notifyDesktop('relay-doctor crashed', err.message);
  process.exit(2);
});
