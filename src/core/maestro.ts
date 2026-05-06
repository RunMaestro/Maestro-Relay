import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// --- Types ---

export interface MaestroAgent {
  id: string;
  name: string;
  toolType: string;
  cwd: string;
  [key: string]: unknown;
}

export interface MaestroSession {
  sessionId: string;
  sessionName: string;
  modifiedAt: string;
  firstMessage: string;
  messageCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationSeconds: number;
  starred: boolean;
}

export interface SendResult {
  agentId: string;
  agentName: string;
  sessionId: string;
  response: string | null;
  success: boolean;
  error?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    totalCostUsd: number;
    contextWindow: number;
    contextUsagePercent: number;
  };
}

export interface MaestroPlaybook {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  taskCount: number;
  agentId?: string;
  agentName?: string;
  [key: string]: unknown;
}

export interface MaestroAgentDetail extends MaestroAgent {
  projectRoot?: string;
  groupName?: string;
  autoRunFolderPath?: string;
  stats?: {
    historyEntries?: number;
    successCount?: number;
    failureCount?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalCost?: number;
    totalElapsedMs?: number;
  };
  recentHistory?: Array<{
    id: string;
    type: string;
    timestamp: number;
    summary: string;
    success?: boolean;
    elapsedTimeMs?: number;
  }>;
}

export interface GistResult {
  url: string;
  id: string;
  [key: string]: unknown;
}

export interface DirectorNotesEntry {
  id?: string;
  type?: string;
  timestamp?: number;
  summary?: string;
  agentName?: string;
  success?: boolean;
  [key: string]: unknown;
}

export interface DirectorSynopsis {
  synopsis?: string;
  text?: string;
  markdown?: string;
  daysCovered?: number;
  entriesAnalyzed?: number;
  [key: string]: unknown;
}

export interface AutoRunOptions {
  agentId: string;
  docs: string[];
  prompt?: string;
  loop?: boolean;
  maxLoops?: number;
  resetOnCompletion?: boolean;
}

export interface MaestroPlaybookDetail extends MaestroPlaybook {
  documents: Array<{
    path: string;
    taskCount: number;
    completedCount: number;
  }>;
}

export interface PlaybookEvent {
  type:
    | 'start'
    | 'document_start'
    | 'task_start'
    | 'task_complete'
    | 'document_complete'
    | 'loop_complete'
    | 'complete';
  timestamp: number;
  success?: boolean;
  summary?: string;
  totalTasksCompleted?: number;
  totalElapsedMs?: number;
  totalCost?: number;
  [key: string]: unknown;
}

// --- Helpers ---

type RunOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
};

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

async function run(args: string[], opts: RunOptions = {}): Promise<string> {
  try {
    const { stdout } = (await execFileAsync('maestro-cli', args, {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    })) as { stdout: string; stderr: string };
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as {
      message?: string;
      stderr?: string;
      stdout?: string;
      code?: string | number;
      killed?: boolean;
    };
    const parts: string[] = [];
    if (e.killed) parts.push('process killed (timeout?)');
    if (e.code) parts.push(`exit code: ${e.code}`);
    if (e.stderr?.trim()) parts.push(`stderr: ${e.stderr.trim()}`);
    if (e.stdout?.trim()) parts.push(`stdout: ${e.stdout.trim()}`);
    if (parts.length === 0) parts.push(e.message || String(err));
    const detail = parts.join(' | ');
    console.error(`[maestro-cli ${args[0]}] ${detail}`);
    throw new Error(`maestro-cli ${args[0]} failed: ${detail}`, { cause: err });
  }
}

/**
 * Spawn maestro-cli without a timeout. Used for agent send operations where
 * response times are unpredictable (research tasks, complex code generation).
 * Collects stdout/stderr and resolves when the process exits.
 */
function runSpawn(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('maestro-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (data: Buffer) => chunks.push(data));
    child.stderr.on('data', (data: Buffer) => stderrChunks.push(data));

    child.on('error', (err) => {
      console.error(`[maestro-cli ${args[0]}] spawn error: ${err.message}`);
      reject(new Error(`maestro-cli ${args[0]} failed: spawn error: ${err.message}`));
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString().trim();
      const stderr = Buffer.concat(stderrChunks).toString().trim();

      if (code === 0) {
        resolve(stdout);
      } else {
        const parts: string[] = [];
        if (code !== null) parts.push(`exit code: ${code}`);
        if (stderr) parts.push(`stderr: ${stderr}`);
        if (stdout) parts.push(`stdout: ${stdout}`);
        const detail = parts.join(' | ');
        console.error(`[maestro-cli ${args[0]}] ${detail}`);
        reject(new Error(`maestro-cli ${args[0]} failed: ${detail}`));
      }
    });
  });
}

// --- Agent CWD cache ---

let agentCwdCache: Map<string, string> | null = null;
let agentCwdCacheTime = 0;
export const AGENT_CWD_CACHE_TTL = 60_000; // 60 seconds

/** Reset the agent CWD cache (exported for testing). */
export function resetAgentCwdCache(): void {
  agentCwdCache = null;
  agentCwdCacheTime = 0;
}

// --- Service ---

export const maestro = {
  /** Check if maestro-cli is installed and reachable */
  async isInstalled(): Promise<boolean> {
    try {
      await execFileAsync('maestro-cli', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  },

  /** List all agents. Returns empty array on error. */
  async listAgents(): Promise<MaestroAgent[]> {
    const raw = await run(['list', 'agents', '--json']);
    return JSON.parse(raw) as MaestroAgent[];
  },

  /** Look up an agent's cwd by ID, with a TTL cache to avoid repeated CLI calls. */
  async getAgentCwd(agentId: string): Promise<string | null> {
    const now = Date.now();
    if (!agentCwdCache || now - agentCwdCacheTime > AGENT_CWD_CACHE_TTL) {
      const agents = await this.listAgents();
      agentCwdCache = new Map(agents.map((a) => [a.id, a.cwd]));
      agentCwdCacheTime = now;
    }
    return agentCwdCache.get(agentId) ?? null;
  },

  /** List sessions for a given agent */
  async listSessions(agentId: string, limit = 25): Promise<MaestroSession[]> {
    const raw = await run(['list', 'sessions', agentId, '--json', '-l', String(limit)]);
    const parsed = JSON.parse(raw);
    const sessions = Array.isArray(parsed) ? parsed : parsed?.sessions;
    return Array.isArray(sessions) ? sessions : [];
  },

  /**
   * Send a message to an agent.
   * If sessionId is provided, resumes that session; otherwise starts a new one.
   * Returns the full structured response.
   */
  async send(
    agentId: string,
    message: string,
    sessionId?: string,
    readOnly?: boolean,
  ): Promise<SendResult> {
    const args = ['send'];
    if (sessionId) args.push('-s', sessionId);
    if (readOnly) args.push('-r');
    args.push(agentId, '--', message);
    try {
      const raw = await runSpawn(args);
      return JSON.parse(raw) as SendResult;
    } catch (err: unknown) {
      // CLI may exit non-zero but still return valid JSON (e.g. read-only rejection)
      const errMsg = err instanceof Error ? err.message : String(err);
      const stdoutMatch = errMsg.match(/stdout: ({[\s\S]*})/);
      if (stdoutMatch) {
        try {
          const parsed = JSON.parse(stdoutMatch[1]) as SendResult;
          if (parsed.agentId && parsed.usage) return parsed;
        } catch {
          /* not valid JSON, fall through */
        }
      }
      throw err;
    }
  },

  /** List all playbooks, optionally filtered by agent */
  async listPlaybooks(agentId?: string): Promise<MaestroPlaybook[]> {
    const args = ['list', 'playbooks', '--json'];
    if (agentId) args.push('-a', agentId);
    const raw = await run(args);
    return JSON.parse(raw) as MaestroPlaybook[];
  },

  /** Show detailed info for a single playbook */
  async showPlaybook(playbookId: string): Promise<MaestroPlaybookDetail> {
    const raw = await run(['show', 'playbook', playbookId, '--json']);
    return JSON.parse(raw) as MaestroPlaybookDetail;
  },

  /** Show detailed agent info including stats and recent history */
  async showAgent(agentId: string): Promise<MaestroAgentDetail> {
    const raw = await run(['show', 'agent', agentId, '--json']);
    return JSON.parse(raw) as MaestroAgentDetail;
  },

  /** Publish an agent's session transcript as a GitHub gist */
  async createGist(
    agentId: string,
    opts: { description?: string; isPublic?: boolean } = {},
  ): Promise<GistResult> {
    const args = ['gist', 'create', agentId];
    if (opts.description) args.push('-d', opts.description);
    if (opts.isPublic) args.push('-p');
    const raw = await run(args, { timeoutMs: 60_000 });
    return JSON.parse(raw) as GistResult;
  },

  /** Generate AI synopsis of recent activity (requires running Maestro app) */
  async directorSynopsis(opts: { days?: number } = {}): Promise<DirectorSynopsis> {
    const args = ['director-notes', 'synopsis', '--json'];
    if (opts.days != null) args.push('-d', String(opts.days));
    // Synopsis generation involves AI inference — give it 2 minutes
    const raw = await run(args, { timeoutMs: 120_000 });
    return JSON.parse(raw) as DirectorSynopsis;
  },

  /** Show unified history across all agents */
  async directorHistory(
    opts: { days?: number; limit?: number; filter?: 'auto' | 'user' | 'cue' } = {},
  ): Promise<DirectorNotesEntry[]> {
    const args = ['director-notes', 'history', '--json'];
    if (opts.days != null) args.push('-d', String(opts.days));
    if (opts.limit != null) args.push('-l', String(opts.limit));
    if (opts.filter) args.push('--filter', opts.filter);
    const raw = await run(args);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as DirectorNotesEntry[];
    if (Array.isArray(parsed?.entries)) return parsed.entries as DirectorNotesEntry[];
    return [];
  },

  /** Configure and launch an Auto Run with the given documents */
  async startAutoRun(opts: AutoRunOptions): Promise<string> {
    if (!opts.docs.length) throw new Error('startAutoRun requires at least one document');
    const args = ['auto-run', '--launch', '--agent', opts.agentId];
    if (opts.prompt) args.push('--prompt', opts.prompt);
    if (opts.maxLoops != null) args.push('--max-loops', String(opts.maxLoops));
    else if (opts.loop) args.push('--loop');
    if (opts.resetOnCompletion) args.push('--reset-on-completion');
    args.push(...opts.docs);
    return run(args, { timeoutMs: 60_000 });
  },

  /** Run a playbook and return the final completion event. Uses --wait so the CLI blocks until done. */
  async runPlaybook(playbookId: string): Promise<PlaybookEvent> {
    const raw = await run(['playbook', playbookId, '--wait'], {
      timeoutMs: 30 * 60 * 1000,
      maxBuffer: 100 * 1024 * 1024, // 100MB for long JSONL output
    });
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === 'complete' && typeof parsed.timestamp === 'number') {
          return parsed as PlaybookEvent;
        }
      } catch {
        // Ignore non-JSON lines; some CLI output may include extra text.
      }
    }

    const tail = lines.slice(-5).join('\n');
    throw new Error(
      `maestro-cli playbook did not emit a completion event for playbook "${playbookId}". Last lines:\n${tail || '(no output)'}`,
    );
  },
};
