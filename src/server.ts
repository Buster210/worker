import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { insertJob, getJob, updateJob, createLock, workersDir, lockPath, logPath as workerLogPath, finalizeJob, getRunningJobsForRepo, chainLockPath, createChainLock, removeChainLock } from './state.ts';
import { buildSpec, buildRunArgv, buildResumeArgv, getResumeToken, LADDER, ALL_BACKENDS, type Backend } from './backends.ts';
import {
  runWorker, runClaudeTmux, sweepStaleJobs, reapStoppedJobs, workerEnv,
  isProcessAlive, resolveStatus, watchExisting, defaultTimeoutMs, backendShellArgv, type RunResult,
} from './runner.ts';
import { recordLadder } from './ladder.ts';
import { killProcessTree } from './descendent-kill.ts';

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
  opts: { sid: string; model?: string; extraArgs?: string[]; timeoutMs?: number },
): { handle: string; lock_path: string; promise: Promise<RunResult> } {
  const handle = newHandle(backend);
  killLingeringJobs(dir);
  const lp = workerLogPath(handle, dir);
  const spec = buildSpec(backend, prompt);
  // claude pins sonnet; omp + claude_tmux ignore model entirely. None thread the model parameter.
  const modelToUse = (backend === 'claude' || backend === 'omp' || backend === 'claude_tmux') ? undefined : opts.model;
  insertJob({ handle, backend, sid: opts.sid, repo: dir, model: modelToUse, task: prompt, log_path: lp });

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
  return { handle, lock_path: lockPath(handle, dir), promise };
}

type LadderResult = { handle: string; status: string; lock_path: string } | { status: 'exhausted'; worker: null; note: string };

// worker_ladder runs the FULL ladder autonomously in the background: it launches the first backend and,
// on a non-`done` terminal, auto-recovers without any caller action — stall/timeout → resume the same
// backend ONCE (preserving partial work), then climb; hard failure → climb straight to the next rung; until
// a backend succeeds (`done`) or the ladder is `exhausted`. A `killed` rung stops the chain (operator intent).
// Returns immediately with the first rung's handle and a chain lock_path held for the entire climb
// (removed only when the chain terminates). Completion is signaled by the lock_path clearing.
export function handleLadder(args: { sid: string; prompt: string; dir: string; timeout?: number }): LadderResult {
  assertRepo(args.dir);
  const { sid, prompt, dir } = args;
  const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;

  if (LADDER.length === 0) return { status: 'exhausted', worker: null, note: 'no workers available' };

  createChainLock(sid);
  // Launch the first rung now so its handle is the stable key returned to the caller.
  const timeoutSec = args.timeout;
  const first = launch(LADDER[0], prompt, dir, { sid, timeoutMs });
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
  return { handle: first.handle, status: 'running', lock_path: chainLockPath(sid) };
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

export function handleRun(args: { backend: Backend; prompt: string; model?: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string; lock_path: string } {
  assertRepo(args.dir);
  const sid = randomUUID();
  const { handle, lock_path, promise } = launch(args.backend, args.prompt, args.dir,
    { sid, model: args.model, extraArgs: args.extraArgs, timeoutMs: args.timeout ? args.timeout * 1000 : undefined });
  void promise.catch(() => {});
  return { handle, status: 'running', lock_path };
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

export function handleResume(args: { handle: string; prompt: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string; lock_path: string } {
  const { handle, promise } = resumeLaunch(args);
  void promise.catch(() => {});
  return { handle, status: 'running', lock_path: lockPath(handle) };
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
  return `killed: ${handle} (pid ${job.worker_pid})`;
}

export function handleStatus(args: { handle: string }): Record<string, unknown> {
  const { handle } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found: ${handle}`);
  let alive = false;
  if (job.worker_pid && (job.status === 'running' || job.status === 'stopped')) {
    alive = isProcessAlive(job.worker_pid, job.started);
  }
  const { backend: _b, ...safe } = job;
  return { ...safe, alive };
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
    .map(({ backend: _b, ...j }) => j);
}

// Absolute path to the completion watcher, resolved at load so the shipped instructions carry a
// runnable command regardless of where the server is installed.
const reportScript = join(import.meta.dir, 'report.ts');

// Orchestration contract shipped to every client on connect (MCP `initialize`
// `instructions`). Folds in the former client-side worker-control skill so a bare
// `add this MCP` is self-sufficient — no skill install required.
const WORKER_INSTRUCTIONS = `# worker — delegate a coding task to a background agent

These tools spawn autonomous coding agents that MUTATE a git repo, then run, kill,
resume, and report on them. One task = one running worker.

## Invariants (always)
- \`worker_ladder\` is the DEFAULT — always use it; \`worker_run\` only when the user explicitly names a specific worker.
- \`dir\` is REQUIRED on every call — absolute repo path. Server has no cwd; a relative or omitted path won't resolve.
- git is GROUND TRUTH — read a worker's output with \`git -C <dir> diff\`, never the JSON log for file content.
- ONE worker PER REPO at a time. Never start a second on a repo already running one (\`worker_ladder\`/\`worker_run\` kills the lingering one for you).
- \`sid\` = the caller's session id (e.g. \$CLAUDE_CODE_SESSION_ID); it keys the ladder.

## Lifecycle
- Run tools are ASYNC: \`worker_ladder\`/\`worker_run\`/\`worker_resume\` return immediately as \`{ handle, status: "running", lock_path }\`; the agent keeps running in the background.
- \`worker_ladder\` AUTO-CLIMBS: on failed/timeout/stall it resumes the same worker once then advances to the next worker itself, until one succeeds (\`done\`) or the ladder is \`exhausted\`. No caller action to climb. Its \`lock_path\` spans the whole chain (removed only when the ladder terminates); the returned \`handle\` is the first rung's handle. For completion + results, run the report watcher (see Completion) — it emits the outcome and diff in one bundle.

## Status model — a job ends in ONE of these
- \`done\` — completed cleanly.
- \`failed[:reason]\` — the agent errored or produced nothing usable.
- \`timeout\` — hit its deadline or stalled AND had self-declared failure (last log line FAILED) → SIGKILL, terminal. \`worker_resume\` re-attempts fresh from the token.
- \`stopped\` — hit its deadline or stalled while still ALIVE and not self-failed: the process is FROZEN via SIGSTOP, its lock removed, NOT dead. The default outcome of a non-completing live job — we freeze rather than kill so no work is lost on a guess. Recoverable — \`worker_resume\` thaws it (SIGCONT) and re-arms the timeout, rather than re-running from scratch. Left unresumed past the reap window (\`WORKER_REAP_MS\`, default 15min) it's auto-killed and finalized \`timeout\` so it stops holding memory.
- \`killed\` — terminated by \`worker_kill\`.
- \`exhausted\` — \`worker_ladder\` ran out of workers to try. Stop and report.

## Recovering / continuing a run — worker_resume(handle, prompt, dir)
- Thaws a \`stopped\` (frozen) worker and lets it finish; or re-attempts a \`failed\`/\`timeout\` one from its saved resume_token.
- On resume the worker is told "a prior attempt already ran — inspect the tree and complete only the remainder," so it won't redo finished work.

## Completion — run the report watcher (do this instead of polling by hand)
- Right after a run/ladder call, launch the watcher in the BACKGROUND (non-blocking). It polls the lock and, when the job terminates, prints ONE status-aware bundle to stdout — the same diff you'd otherwise fetch yourself, front-loaded:
    bun ${reportScript} <handle> '<lock_path>'   # single-quote it: lock_path may contain a literal \$sid that an unquoted shell would expand to the wrong path → false \`exhausted\`
- Its stdout IS both the completion signal and the result:
    line 1 = outcome — one of: completed · failed[:reason] · timeout · exhausted · stopped · killed
    completed / failed / timeout / exhausted → blank line, then the full \`git diff\`
    stopped / killed → just the one line (no diff)
- Do NOT also run \`git diff\` / \`worker_status\` — the bundle already carries what you need.

## Drive loop
1. \`worker_ladder(sid, prompt, dir)\` → \`{ handle, lock_path }\` (returns at once).
2. Background-run the report watcher with that \`handle\` + \`lock_path\` (see Completion).
3. Act on line 1 of its output:
   - \`completed\` → reviewer-gate the diff against the spec (mandatory).
   - \`failed\` / \`timeout\` → inspect the diff; \`worker_resume\` to re-attempt, or report.
   - \`exhausted\` → the ladder already auto-resumed + tried every worker and none succeeded → report and stop.
   - \`stopped\` → \`worker_resume\` to finish (frozen, work preserved).
   - \`killed\` → stop.

\`worker_status\` is for mid-flight diagnostics only — never the completion signal; the report watcher's bundle (built from git) is ground truth.

## Other tools
- \`worker_kill(handle)\` — terminate a running worker.
- \`worker_list(status?, limit?)\` — recent jobs.
- \`worker_doctor(backend?)\` — health check; names only the workers that aren't operational.`;

const server = new McpServer(
  { name: 'worker', version: '0.1.0' },
  { instructions: WORKER_INSTRUCTIONS },
);

server.tool('worker_ladder',
  `DEFAULT way to run a coding task: spawns an autonomous agent that mutates the repo, auto-selecting a capable worker. Runs the FULL ladder itself — on failed/timeout/stall it resumes once then advances to the next worker automatically, until one succeeds (done) or the ladder is exhausted. No caller action needed to climb. Async: returns { handle, status:"running", lock_path }; then background-run the report watcher (\`bun ${reportScript} <handle> <lock_path>\`) — its stdout is the outcome line + full git diff (completion signal + result in one). See MCP instructions.`,
  {
    sid: z.string().describe('Session ID ($CLAUDE_CODE_SESSION_ID)'),
    prompt: z.string().describe('Task spec'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds per backend attempt (default 600)'),
  },
  async (args) => reply(handleLadder(args))
);

server.tool('worker_run',
  `Run a coding task on a SPECIFIC worker — only when the user explicitly names one; otherwise use worker_ladder. Spawns an autonomous agent that mutates the repo. Async: returns { handle, status:"running", lock_path }; then background-run the report watcher (\`bun ${reportScript} <handle> <lock_path>\`) for the outcome line + git diff.`,
  {
    backend: z.string().describe('The specific worker to run (default to worker_ladder unless the user named one).'),
    prompt: z.string(),
    model: z.string().optional().describe('Model override. Ignored by workers that pin their own model.'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds (default 600). On timeout a productively-working job is frozen as `stopped` and is resumable, not killed.'),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded verbatim to the underlying worker (powerful: can alter permission mode etc.). Omit unless you know the worker CLI.'),
  },
  async ({ backend, ...rest }) => {
    if (!ALL_BACKENDS.includes(backend as Backend)) return reply(`Unknown worker: ${backend}`);
    return reply(handleRun({ backend: backend as Backend, ...rest }));
  }
);

server.tool('worker_resume',
  'Resume a previous worker run.',
  {
    handle: z.string(),
    prompt: z.string(),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional(),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded to the underlying worker (-- passthrough)'),
  },
  async (args) => reply(handleResume(args))
);

server.tool('worker_kill',
  'Kill a running worker by handle.',
  { handle: z.string() },
  async (args) => reply(handleKill(args))
);

server.tool('worker_status',
  'Check status of a worker by handle.',
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
  // Periodic reap so a frozen job nobody resumes is reclaimed within ~1 scan of its window,
  // not only on the next server boot. unref'd → never keeps the process alive on its own.
  setInterval(reapStoppedJobs, 60_000).unref();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
