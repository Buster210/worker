import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { spawnSync, execSync } from 'child_process';
import { insertJob, getJob, updateJob, createLock, workersDir, lockPath, logPath as workerLogPath, finalizeJob, getRunningJobsForRepo } from './state.ts';
import { buildSpec, buildRunArgv, buildResumeArgv, getResumeToken, type Backend } from './backends.ts';
import {
  runWorker, runClaudeTmux, trackJob, waitJob, sweepStaleJobs, workerEnv,
  isProcessAlive, resolveStatus, watchExisting, defaultTimeoutMs, type RunResult,
} from './runner.ts';
import { ladderNext, recordLadder } from './ladder.ts';

function killJobHard(job: { handle: string; backend: string; worker_pid: number; log_path: string }): void {
  updateJob(job.handle, { kill_requested: true });
  if (job.backend === 'claude_tmux') {
    try { spawnSync('tmux', ['kill-session', '-t', job.handle], { stdio: 'ignore' }); } catch {}
  } else if (job.worker_pid > 0) {
    try { process.kill(-job.worker_pid, 'SIGKILL'); } catch {}
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
// Stays ladder-agnostic — the caller composes the tracked promise (e.g. ladder appends recordLadder)
// and calls trackJob, so launch() is reusable by both run tools without knowing about ladders.
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

export function handleLadder(args: { sid: string; prompt: string; climb?: boolean; dir: string; timeout?: number }): LadderResult {
  assertRepo(args.dir);
  const next = ladderNext(args.sid, args.climb ?? false);
  if (!next) return { status: 'exhausted', worker: null, note: 'all backends exhausted' };
  const { backend, turn } = next;
  const { handle, lock_path, promise } = launch(backend, args.prompt, args.dir,
    { sid: args.sid, timeoutMs: args.timeout ? args.timeout * 1000 : undefined });
  trackJob(handle, promise.then(r => { recordLadder(args.sid, turn, backend, r.status); return r; }));
  return { handle, status: 'running', lock_path };
}

export function handleRun(args: { backend: Backend; prompt: string; model?: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string; lock_path: string } {
  assertRepo(args.dir);
  const sid = randomUUID();
  const { handle, lock_path, promise } = launch(args.backend, args.prompt, args.dir,
    { sid, model: args.model, extraArgs: args.extraArgs, timeoutMs: args.timeout ? args.timeout * 1000 : undefined });
  trackJob(handle, promise);
  return { handle, status: 'running', lock_path };
}

export function handleResume(args: { handle: string; prompt: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; status: string; lock_path: string } {
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
      trackJob(handle, p);
      return { handle, status: 'running', lock_path: lockPath(handle) };
    }

    // Resume the frozen process: SIGCONT, re-arm a fresh hard timeout, hand off to the watcher.
    try { process.kill(-pid, 'SIGCONT'); } catch {}
    updateJob(handle, { status: 'running' });
    createLock(handle);

    const be = job.backend as Backend;
    const lp = workerLogPath(handle);
    const deadlineMs = timeout ? timeout * 1000 : defaultTimeoutMs();
    trackJob(handle, watchExisting(handle, pid, dir, lp, be, deadlineMs));
    return { handle, status: 'running', lock_path: lockPath(handle) };
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
  trackJob(handle, p);
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
  const backends = args.backend ? [args.backend] : ['claude', 'omp', 'cmd', 'opencode', 'pool'];
  const lines = backends.map(be => {
    try {
      const ver = execSync(`${be} --version 2>/dev/null | head -1`, { encoding: 'utf8', env: workerEnv }).trim();
      return `DOCTOR|${be}|OK ${ver}`;
    } catch { return `DOCTOR|${be}|MISSING (not on PATH)`; }
  });
  return lines.join('\n');
}

export async function handleWait(args: { handle: string; timeout?: number }): Promise<Record<string, unknown>> {
  const { handle, timeout } = args;
  const waitPromise = waitJob(handle);
  let result: any;
  if (timeout) {
    const timer = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('wait timeout')), timeout * 1000));
    result = await Promise.race([waitPromise, timer]);
  } else {
    result = await waitPromise;
  }
  const { backend: _b, ...safe } = result as any;
  return safe;
}

export function handleList(args: { status?: string; limit?: number }): Record<string, unknown>[] {
  const { status, limit = 20 } = args;
  const root = workersDir();
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'ladder' && d.name !== 'tmux')
    .map(d => { try { return JSON.parse(readFileSync(`${root}/${d.name}/job.json`, 'utf8')); } catch { return null; } })
    .filter((j): j is NonNullable<typeof j> => j !== null)
    .filter(j => !status || j.status === status)
    .sort((a, b) => (b.started ?? '').localeCompare(a.started ?? ''))
    .slice(0, limit)
    .map(({ backend: _b, ...j }) => j);
}

// Orchestration contract shipped to every client on connect (MCP `initialize`
// `instructions`). Folds in the former client-side worker-control skill so a bare
// `add this MCP` is self-sufficient — no skill install required.
const WORKER_INSTRUCTIONS = `# worker — delegate a coding task to a background agent

These tools spawn autonomous coding agents that MUTATE a git repo, then run, kill,
resume, and report on them. One task = one running worker.

## Invariants (always)
- \`worker_ladder\` is the DEFAULT — always use it; \`worker_run\` only when the user explicitly names a backend.
- \`dir\` is REQUIRED on every call — absolute repo path. Server has no cwd; a relative or omitted path won't resolve.
- git is GROUND TRUTH — read a worker's output with \`git -C <dir> diff\`, never the JSON log for file content.
- ONE worker PER REPO at a time. Never start a second on a repo already running one (\`worker_ladder\`/\`worker_run\` kills the lingering one for you).
- \`sid\` = the caller's session id (e.g. \$CLAUDE_CODE_SESSION_ID); it keys the ladder.

## Lifecycle
- Run tools are ASYNC: \`worker_ladder\`/\`worker_run\`/\`worker_resume\` return immediately as \`{ handle, status: "running", lock_path }\`; the agent keeps running in the background — poll/wait for the final status.
- \`climb: true\` escalates \`worker_ladder\` to the next backend after a failed/weak run.

## Status model — a job ends in ONE of these
- \`done\` — completed cleanly.
- \`failed[:reason]\` — the agent errored or produced nothing usable.
- \`timeout\` — hit its deadline while NOT productively working → terminated, gone.
- \`stopped\` — hit its deadline but WAS still productively working (fresh edits, no failure): the process is FROZEN via SIGSTOP, its lock removed, NOT dead. Usually recoverable, not lost — \`worker_resume\` thaws it (SIGCONT) and re-arms the timeout, rather than re-running from scratch.
- \`killed\` — terminated by \`worker_kill\`.
- \`exhausted\` — \`worker_ladder\` ran out of backends to climb to. Stop and report.

## Recovering / continuing a run — worker_resume(handle, prompt, dir)
- Thaws a \`stopped\` (frozen) worker and lets it finish; or re-attempts a \`failed\`/\`timeout\` one from its saved resume_token.
- The \`cmd\` backend auto-prepends "a prior attempt already ran — inspect the tree and complete only the remainder," so resume won't redo finished work.

## Wait for completion
- PREFER bash lock-poll — do NOT block on \`worker_wait\`. The run returns \`lock_path\`; it exists while the worker runs and is REMOVED when done. Fire a background bash poller right after the run call — its exit IS the completion signal:
    LOCK="<lock_path>"; while [ -f "\$LOCK" ]; do sleep 10; done
- \`worker_wait(handle)\` is a blocking fallback only.

## Drive loop
1. \`worker_ladder(sid, prompt, dir)\` → \`{ handle, lock_path }\` (returns at once).
2. Background bash-poll \`lock_path\` (do NOT block on \`worker_wait\`); lock removed = task complete.
3. On completion run \`git -C <dir> diff\` and evaluate the work against the spec.
4. Reviewer gate (mandatory): PASS → done · FAIL/timeout → re-call with \`climb: true\` · exhausted → report and stop.

\`worker_status\` is for mid-flight diagnostics only — never the completion signal; the diff is ground truth.

## Other tools
- \`worker_kill(handle)\` — terminate a running worker.
- \`worker_list(status?, limit?)\` — recent jobs.
- \`worker_doctor(backend?)\` — which backends are installed/on PATH.`;

const server = new McpServer(
  { name: 'worker', version: '0.1.0' },
  { instructions: WORKER_INSTRUCTIONS },
);

server.tool('worker_ladder',
  'DEFAULT way to run a coding task: spawns an autonomous agent that mutates the repo, auto-routing omp→opencode→pool→cmd→claude→claude_tmux. climb=true escalates to the next backend after a failed run. Async: returns { handle, status:"running", lock_path }; do NOT block on worker_wait — background bash-poll lock_path (removed = done), then read results with `git -C <dir> diff`.',
  {
    sid: z.string().describe('Session ID ($CLAUDE_CODE_SESSION_ID)'),
    prompt: z.string().describe('Task spec'),
    climb: z.boolean().optional().describe('Advance to next rung'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds (default 600)'),
  },
  async (args) => reply(handleLadder(args))
);

server.tool('worker_run',
  'Run a coding task on a SPECIFIC backend — only when the user explicitly names one; otherwise use worker_ladder. Spawns an autonomous agent that mutates the repo. Async: returns { handle, status:"running", lock_path }; read results via `git -C <dir> diff`.',
  {
    backend: z.enum(['pool', 'omp', 'opencode', 'cmd', 'claude', 'claude_tmux']),
    prompt: z.string(),
    model: z.string().optional().describe('Model override. IGNORED for claude and omp backends (they pin their own).'),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional().describe('Hard timeout seconds (default 600). On timeout a productively-working job is frozen as `stopped` and is resumable, not killed.'),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded verbatim to the backend binary (powerful: can alter permission mode etc.). Omit unless you know the backend CLI.'),
  },
  async ({ backend, ...rest }) => reply(handleRun({ backend: backend as Backend, ...rest }))
);

server.tool('worker_resume',
  'Resume a previous worker run.',
  {
    handle: z.string(),
    prompt: z.string(),
    dir: z.string().describe('Repo directory (absolute path, required)'),
    timeout: z.number().optional(),
    extraArgs: z.array(z.string()).optional().describe('Raw extra args forwarded to backend binary (-- passthrough)'),
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
  'Check which backends are available.',
  { backend: z.string().optional() },
  async (args) => reply(handleDoctor(args))
);

server.tool('worker_wait',
  'Wait for a background worker job to complete and return its final result. Call after worker_ladder/worker_run.',
  {
    handle: z.string().describe('Worker handle returned by worker_ladder or worker_run'),
    timeout: z.number().optional().describe('Max seconds to wait (default: no limit)'),
  },
  async (args) => reply(await handleWait(args))
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
