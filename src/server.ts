import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { insertJob, getJob, updateJob, createLock, workersDir, logPath as workerLogPath, finalizeJob, getRunningJobsForRepo, chainLockPath, createChainLock, removeChainLock } from './state.ts';
import { buildSpec, buildRunArgv, buildResumeArgv, getResumeToken, LADDER, ALL_BACKENDS, type Backend } from './backends.ts';
import {
  runWorker, runClaudeTmux, sweepStaleJobs, reapStoppedJobs, workerEnv,
  isProcessAlive, resolveStatus, watchExisting, defaultTimeoutMs, backendShellArgv, type RunResult,
} from './runner.ts';
import { recordLadder } from './ladder.ts';
import { killProcessTree } from './descendent-kill.ts';

// Boot timestamp captured once at module init — written to every job so the orphan sweep can
// verify a job's owning server is still alive (PID-reuse guard via isProcessAlive's started arg).
const SERVER_STARTED = new Date().toISOString();
// Handles (job IDs) this server process launched. Scoped cleanup on shutdown — never
// touch another session's workers. Populated by trackLaunched() at launch time.
const launchedHandles = new Set<string>();
export function trackLaunched(handle: string) { launchedHandles.add(handle); }


function killJobHard(job: { handle: string; backend: string; worker_pid: number; log_path: string }): void {
  updateJob(job.handle, { kill_requested: true });
  if (job.backend === 'claude_tmux') {
    try { spawnSync('tmux', ['kill-session', '-t', job.handle], { stdio: 'ignore' }); } catch {}
  } else if (job.worker_pid > 0) {
    killProcessTree(job.worker_pid, 'SIGKILL');
  }
}

function newHandle(backend: Backend): string {
  const id = randomUUID();
  // Only claude consumes a full --session-id; everything else (incl. omp, which keys
  // resume off a per-job --session-dir) uses the short w- handle.
  return backend === 'claude' ? id : `w-${id.slice(0, 8)}`;
}

function assertRepo(dir: string) {
  try {
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('not a git repo');
  }
  catch { throw new Error(`Not a git repo: ${dir}`); }
}

// Wrap a handler's return value in the MCP text-content envelope. Objects are JSON-encoded;
// strings pass through verbatim (worker_kill/worker_doctor return human-readable text, not JSON).
export function reply(r: unknown) {
  const text = typeof r === 'string' ? r : JSON.stringify(r);
  return { content: [{ type: 'text' as const, text }] };
}

// One worker per repo: kill any same-repo job still showing running/stopped before starting a new one.
function killLingeringJobs(dir: string): void {
  for (const job of getRunningJobsForRepo(dir)) {
    killJobHard(job);
    finalizeJob(job.handle, 'killed');
  }
}

// Shared spawn path for worker_ladder and worker_run: kill lingering → insert → buildSpec → spawn.
// Stays ladder-agnostic — the caller composes the promise (e.g. ladder appends recordLadder).
function launch(
  backend: Backend,
  prompt: string,
  dir: string,
  opts: { sid: string; model?: string; extraArgs?: string[]; timeoutMs?: number; completionLock?: string },
): { handle: string; promise: Promise<RunResult> } {
  const handle = newHandle(backend);
  trackLaunched(handle);
  killLingeringJobs(dir);
  const lp = workerLogPath(handle, dir);
  const spec = buildSpec(backend, prompt);
  // claude pins sonnet; omp + claude_tmux ignore model entirely. None thread the model parameter.
  const modelToUse = (backend === 'claude' || backend === 'omp' || backend === 'claude_tmux') ? undefined : opts.model;
  insertJob({ handle, backend, sid: opts.sid, repo: dir, model: modelToUse, task: prompt, log_path: lp, completion_lock: opts.completionLock, server_pid: process.pid, server_started: SERVER_STARTED });

  let promise: Promise<RunResult>;
  if (backend === 'claude_tmux') {
    promise = runClaudeTmux(spec, dir, handle, handle, opts.timeoutMs);
  } else {
    const argv = buildRunArgv(backend, spec, dir, handle, modelToUse, opts.extraArgs);
    const initToken = backend === 'opencode' ? '' : getResumeToken(backend, handle, lp);
    promise = runWorker(argv, dir, handle, backend, lp, initToken, opts.timeoutMs)
      .then(r => {
        if (backend === 'opencode') {
          const tok = getResumeToken('opencode', handle, lp);
          if (tok) { r.resume_token = tok; updateJob(handle, { resume_token: tok }); }
        }
        return r;
      });
  }
  return { handle, promise };
}

/**
 * Graceful shutdown: kill every worker process this server launched that is still in flight,
 * finalize it resumable (preserving resume_token), then exit. Idempotent — repeated calls
 * (signal + stdin EOF both firing) are a no-op after the first.
 */
export async function shutdown(): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  for (const handle of launchedHandles) {
    const job = getJob(handle);
    if (!job || (job.status !== 'running' && job.status !== 'stopped')) continue;
    if (job.worker_pid > 0) killProcessTree(job.worker_pid, 'SIGKILL');
    finalizeJob(handle, 'failed', { resume_token: job.resume_token });
  }
  process.exit(0);
}
let _shuttingDown = false;
/** Reset shutdown state for testing. Production code never calls this. */
export function resetShutdownState(): void { _shuttingDown = false; launchedHandles.clear(); }

type LadderResult = { handle: string; status: string } | { status: 'exhausted'; note: string };

// worker_ladder runs the FULL ladder autonomously in the background: it launches the first backend and,
// on a non-`done` terminal, auto-recovers without any caller action — stall/timeout → resume the same
// backend ONCE (preserving partial work), then climb; hard failure → climb straight to the next rung; until
// a backend succeeds (`done`) or the ladder is `exhausted`. A `killed` rung stops the chain (operator intent).
// Returns immediately with the first rung's handle; a chain lock is held for the entire climb
// (removed only when the chain terminates), and report.ts watches it to signal completion.
export function handleLadder(args: { sid: string; prompt: string; dir: string; timeout?: number }): LadderResult {
  assertRepo(args.dir);
  const { sid, prompt, dir } = args;
  const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;

  if (LADDER.length === 0) return { status: 'exhausted', note: 'no workers available' };

  createChainLock(sid);
  // Launch the first rung now so its handle is the stable key returned to the caller. Its
  // completion_lock is the chain lock (not rung-0's per-handle lock, which clears mid-climb) so
  // report.ts watches the right boundary from the handle alone.
  const timeoutSec = args.timeout;
  const first = launch(LADDER[0], prompt, dir, { sid, timeoutMs, completionLock: chainLockPath(sid) });
  const drivers: LadderDrivers = {
    runRung: (backend) => launch(backend, prompt, dir, { sid, timeoutMs }).promise,
    resumeRung: (handle) => resumeLaunch({ handle, prompt, dir, timeout: timeoutSec }).promise,
  };

  const chainPromise = runLadderChain(sid, first.promise, drivers)
    .catch((): RunResult => ({
      status: 'failed', exit_code: 1, backend: LADDER[0], handle: first.handle,
      resume_token: first.handle, repo: dir, shortstat: '', log: workerLogPath(first.handle),
    }))
    .finally(() => removeChainLock(sid));

  void chainPromise;
  return { handle: first.handle, status: 'running' };
}

// Executors the chain drives. Injected so the climb/resume decision logic is unit-testable without
// spawning real backends; production wiring (above) closes over the live launch()/resumeLaunch().
export type LadderDrivers = {
  runRung: (backend: Backend) => Promise<RunResult>;   // launch a fresh rung, resolve with its terminal result
  resumeRung: (handle: string) => Promise<RunResult>;  // resume the given handle once, resolve with its terminal result
};

// Detached controller for the whole ladder. rung 0's promise is passed in (already launched for its handle);
// every later rung/resume goes through `drivers`. Resolves with the terminal RunResult — the winning backend,
// or the last result tagged `exhausted`. recordLadder logs every turn to ladder/<sid>.jsonl (audit trail).
export async function runLadderChain(
  sid: string,
  firstPromise: Promise<RunResult>,
  drivers: LadderDrivers,
): Promise<RunResult> {
  let i = 0;
  let turn = 1;
  let result = await firstPromise;
  recordLadder(sid, turn++, LADDER[i], result.status);

  for (;;) {
    if (result.status === 'done' || result.status === 'killed') return result;

    if (result.status === 'stopped' || result.status === 'timeout') {
      // Stall/timeout → resume the SAME backend once to preserve partial work.
      const r2 = await drivers.resumeRung(result.handle);
      recordLadder(sid, turn++, LADDER[i], r2.status);
      if (r2.status === 'done' || r2.status === 'killed') return r2;
      result = r2; // carry the latest attempt forward so a later exhaustion reports it, not the stale pre-resume result
    }

    // failed, or post-resume still non-done → climb to the next rung.
    i++;
    if (i >= LADDER.length) return { ...result, status: 'exhausted' };
    result = await drivers.runRung(LADDER[i]);
    recordLadder(sid, turn++, LADDER[i], result.status);
  }
}

export function handleRun(args: { backend: Backend; prompt: string; model?: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string } {
  assertRepo(args.dir);
  const sid = randomUUID();
  const { handle, promise } = launch(args.backend, args.prompt, args.dir,
    { sid, model: args.model, extraArgs: args.extraArgs, timeoutMs: args.timeout ? args.timeout * 1000 : undefined });
  void promise.catch(() => {});
  return { handle, status: 'running' };
}

// Core resume: performs the stopped/dead/normal branching and returns the terminal RunResult promise
// (NOT tracked, NOT wrapped). Reused by handleResume (which tracks + returns the running envelope) and by
// the ladder controller (which awaits the promise directly for its auto-resume-once step).
function resumeLaunch(args: { handle: string; prompt: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; promise: Promise<RunResult> } {
  const { handle, prompt, dir, timeout, extraArgs } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found for handle: ${handle}`);
  updateJob(handle, { kill_requested: false });

  // Handle stopped jobs: SIGCONT the process, re-arm fresh timeout
  if (job.status === 'stopped') {
    const pid = job.worker_pid;
    // Check if process is still alive (it should be frozen with SIGSTOP)
    if (!isProcessAlive(pid, job.started)) {
      // Process is dead (race condition) - fall back to token-respawn
      const be = job.backend as Backend;
      const lp = workerLogPath(handle);
      const spec = buildSpec(be, prompt);
      const argv = buildResumeArgv(be, spec, dir, job.resume_token, undefined, extraArgs);
      const p = runWorker(argv, dir, handle, be, lp,
        job.resume_token, timeout ? timeout * 1000 : undefined);
      return { handle, promise: p };
    }

    // Resume the frozen process: SIGCONT, re-arm a fresh hard timeout, hand off to the watcher.
    try { process.kill(-pid, 'SIGCONT'); } catch {}
    updateJob(handle, { status: 'running' });
    createLock(handle);

    const be = job.backend as Backend;
    const lp = workerLogPath(handle);
    const deadlineMs = timeout ? timeout * 1000 : defaultTimeoutMs();
    return { handle, promise: watchExisting(handle, pid, dir, lp, be, deadlineMs) };
  }

  // Normal resume for non-stopped jobs
  const be = job.backend as Backend;
  const lp = workerLogPath(handle);
  let spec = buildSpec(be, prompt);
  if (be === 'cmd') {
    spec = `A prior attempt already ran in this repo — inspect the working tree, determine what is already done, and complete only the remainder.\n\n` + spec;
  }
  const argv = buildResumeArgv(be, spec, dir, job.resume_token, undefined, extraArgs);
  const p = runWorker(argv, dir, handle, be, lp,
    job.resume_token, timeout ? timeout * 1000 : undefined);
  return { handle, promise: p };
}

export function handleResume(args: { handle: string; prompt: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string } {
  const { handle, promise } = resumeLaunch(args);
  void promise.catch(() => {});
  return { handle, status: 'running' };
}

export function handleKill(args: { handle: string }): string {
  const { handle } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);
  // Already terminal — nothing to do
  const TERMINAL = /^(done|failed|timeout|killed)/;
  if (TERMINAL.test(job.status)) {
    return `already ${job.status}`;
  }
  // Mark intent up front so the completion path (or finalize below) derives 'killed', not 'failed'.
  updateJob(handle, { kill_requested: true });
  // claude_tmux: kill session and finalize immediately (no live pid → no tracked finalize otherwise)
  if (job.backend === 'claude_tmux') {
    killJobHard(job);
    const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
    return `killed: ${handle} (${final})`;
  }
  // stopped: kill process and finalize immediately
  if (job.status === 'stopped' && job.worker_pid) {
    killJobHard(job);
    const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
    return `killed: ${handle} (${final})`;
  }
  // running: SIGTERM then SIGKILL after delay
  if (job.worker_pid) {
    try { process.kill(-job.worker_pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-job.worker_pid, 'SIGKILL'); } catch {} }, 3_000);
  }
  // If process is already dead, finalize immediately so it can't get stuck 'running'
  if (!isProcessAlive(job.worker_pid, job.started)) {
    const final = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
    return `killed: ${handle} (${final})`;
  }
  return `killed: ${handle}`;
}

export function handleStatus(args: { handle: string }): Record<string, unknown> {
  const { handle } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);
  let alive = false;
  if (job.worker_pid && (job.status === 'running' || job.status === 'stopped')) {
    alive = isProcessAlive(job.worker_pid, job.started);
  }
  // Usage-facing view only. handle/repo/task are caller-known (it passed the handle) → omitted as
  // context pollution; internal fields (worker_pid, resume_token, log_path, kill_requested, backend,
  // sid, model) stay hidden. Just the live signal: status + liveness + start time (for elapsed).
  return { status: job.status, alive, started: job.started };
}

export function handleDoctor(args: { backend?: string }): string {
  // claude_tmux is claude-in-tmux, not a probeable binary — exclude it from the default sweep.
  const backends = args.backend ? [args.backend] : ALL_BACKENDS.filter(be => be !== 'claude_tmux');
  // Probe each backend exactly as the runner launches it — via backendShellArgv, which sources
  // WORKER_RC so shell-function backends (omp/cmd/pool/opencode) resolve, not just PATH binaries.
  // A non-zero exit or spawn error means that backend is down. Surface only the failures: backend
  // names are an implementation detail, so on full health we report nothing identifying.
  const down = backends.filter(be => {
    const [cmd, ...probeArgs] = backendShellArgv([be, '--version']);
    const r = spawnSync(cmd, probeArgs, { stdio: 'ignore', env: workerEnv, timeout: 10_000 });
    return r.status !== 0 || r.error != null;
  });
  return down.length === 0 ? 'All workers operational.' : `Not operational: ${down.join(', ')}`;
}

export function handleList(args: { status?: string; limit?: number }): Record<string, unknown>[] {
  const { status, limit = 20 } = args;
  const root = workersDir();
  // Jobs nest as <root>/<project>/<handle>/job.json (see state.insertJob), so walk two levels —
  // mirrors getAllRunningJobs. The old one-level read silently returned nothing for every job
  // stored under the current layout.
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'ladder' && d.name !== 'tmux')
    .flatMap(project => {
      try {
        return readdirSync(`${root}/${project.name}`, { withFileTypes: true })
          .filter(h => h.isDirectory())
          .map(h => { try { return JSON.parse(readFileSync(`${root}/${project.name}/${h.name}/job.json`, 'utf8')); } catch { return null; } });
      } catch { return []; }
    })
    .filter((j): j is NonNullable<typeof j> => j !== null)
    .filter(j => !status || j.status === status)
    .sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''))
    .slice(0, limit)
    // Usage-facing view only — same whitelist as worker_status; internal fields stay hidden.
    .map(j => ({ handle: j.handle, status: j.status, repo: j.repo, task: j.task, started: j.started }));
}

// Orchestration contract shipped to every client on connect (MCP `initialize`
// `instructions`). Folds in the former client-side worker-control skill so a bare
// `add this MCP` is self-sufficient — no skill install required.
const WORKER_INSTRUCTIONS = `# worker — delegate a coding task to a background agent

Hand a coding task to a background agent that edits a git repo, then check, resume, and report on it. One task = one running worker.

## Rules
- \`worker_ladder(sid, prompt, dir)\` is the DEFAULT — use it for every task. \`worker_run\` only when the user names a specific worker.
- \`dir\` is REQUIRED on every call — the absolute repo path.
- \`sid\` = your session id (e.g. \$CLAUDE_CODE_SESSION_ID).
- ONE worker per repo at a time — a new call on a busy repo replaces the one already there.
- Read a worker's output from git: \`git -C <dir> diff\`.

## Run a task
1. Call \`worker_ladder(sid, prompt, dir)\`. It returns at once: \`{ handle, status: "running" }\`, then works in the background — it keeps trying until the task is done or no worker can do it. You don't drive it.
2. Wait for completion in the BACKGROUND — run (just the handle):
       worker-report <handle>
   When the job ends it prints one bundle to stdout:
       line 1 = outcome — one of: completed · failed[:reason] · timeout · stopped · exhausted · killed
       completed / failed / timeout / exhausted → blank line, then the full \`git diff\`
       stopped / killed → just the one line
   This bundle is your completion signal AND the result — don't also run \`git diff\` / \`worker_status\`.
3. Act on the outcome:
   - \`completed\` → review the diff against the spec.
   - \`failed\` / \`timeout\` → inspect the diff; \`worker_resume\` to retry, or report.
   - \`stopped\` → the worker paused with its work preserved; \`worker_resume(handle, prompt, dir)\` to finish it.
   - \`exhausted\` → no worker could do it; report and stop.
   - \`killed\` → stop.

## Other tools
- \`worker_resume(handle, prompt, dir)\` — continue a \`stopped\` worker, or retry a \`failed\`/\`timeout\` one.
- \`worker_kill(handle)\` — stop a running worker.
- \`worker_status(handle)\` — mid-run check only; never your completion signal (use the report command above).
- \`worker_list(status?, limit?)\` — recent jobs.
- \`worker_doctor(backend?)\` — health check; names only the workers that aren't working.`;

const server = new McpServer(
  { name: 'worker', version: '0.1.0' },
  { instructions: WORKER_INSTRUCTIONS },
);

server.tool('worker_ladder',
  `DEFAULT way to run a coding task: hands it to a background agent that edits the repo and runs it to completion on its own, until the task is done or no worker can do it. Returns at once { handle, status:"running" }; get the result via the report command \`bun report.ts <handle>\` (see instructions).`,
  {
    sid: z.string().describe('Session ID ($CLAUDE_CODE_SESSION_ID)'),
    prompt: z.string().describe('Task spec'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds (default 600)'),
  },
  async (args) => reply(handleLadder(args))
);

server.tool('worker_run',
  `Run a coding task on a SPECIFIC worker — only when the user explicitly names one; otherwise use worker_ladder. Returns at once { handle, status:"running" }; get the result via the report command \`bun report.ts <handle>\` (see instructions).`,
  {
    backend: z.string().describe('The specific worker to run (default to worker_ladder unless the user named one).'),
    prompt: z.string(),
    model: z.string().optional().describe('Model override. Ignored by workers that pin their own model.'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds (default 600)'),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded verbatim to the worker. Omit unless you know the worker CLI.'),
  },
  async ({ backend, ...rest }) => {
    if (!ALL_BACKENDS.includes(backend as Backend)) return reply(`Unknown worker: ${backend}`);
    return reply(handleRun({ backend: backend as Backend, ...rest }));
  }
);

server.tool('worker_resume',
  'Continue a stopped worker, or retry a failed/timeout one.',
  {
    handle: z.string(),
    prompt: z.string(),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional(),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded to the worker.'),
  },
  async (args) => reply(handleResume(args))
);

server.tool('worker_kill',
  'Stop a running worker by handle.',
  { handle: z.string() },
  async (args) => reply(handleKill(args))
);

server.tool('worker_status',
  'Check a running worker mid-task. Not a completion signal — use the report command.',
  { handle: z.string() },
  async (args) => reply(handleStatus(args))
);

server.tool('worker_doctor',
  'Report worker health — names only the workers that are not operational; otherwise confirms all are fine.',
  { backend: z.string().optional() },
  async (args) => reply(handleDoctor(args))
);


server.tool('worker_list',
  'List recent worker jobs. Optionally filter by status.',
  {
    status: z.string().optional().describe('Filter by status: running|stopped|done|failed|timeout|killed'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async (args) => reply(handleList(args))
);

// Only boot the stdio transport when run as the entry point, so tests can import the
// handlers above without the module connecting to a (nonexistent) MCP client and hanging.
if (import.meta.main) {
  sweepStaleJobs();
  reapStoppedJobs();
  // Periodic sweep: reap frozen jobs AND reap orphaned workers (whose owning server was killed -9).
  // Both run in the same interval to keep the dead-worker logic single-sourced. unref'd → never
  // keeps the process alive on its own.
  setInterval(() => { reapStoppedJobs(); sweepStaleJobs(); }, 60_000).unref();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Clean up this session's workers on exit. SIGTERM/SIGINT from the OS, or stdin
  // EOF when the parent Claude process exits (pipe closes even on kill -9 of parent).
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);
}
