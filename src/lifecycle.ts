import { randomUUID } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { killProcessTree, killProcessTrees, getProcessStartTime } from './process.ts';
import {
  handleDir, insertJob, getJob, updateJob, logPath as workerLogPath, finalizeJob, reaperPidPath,
  isInPlaceOwner,
} from './state.ts';
import { addWorktreeAsync, clearStaleIndexLock } from './worktree.ts';
import { buildSpec, buildRunArgv, buildResumeArgv, getResumeToken, type Backend } from './backends.ts';
import { runWorker, type RunResult } from './runner.ts';
import { loginShellEnvAsync } from './env.ts';
import { isProcessAlive } from './process.ts';
import { buildContinuationPreamble, type SeedContext } from './seed.ts';

// --- Server lifecycle state ---
// Use the OS-reported process start (ps etime), not module-import time. server_started is the
// pid-reuse guard: isProcessAlive() matches it against `ps` start time with a 60s skew window.
// new Date() at import lags real start whenever this module is imported late (e.g. a big test
// run importing it ~minutes in), pushing skew past 60s so the server's own job reads as dead.
export const SERVER_STARTED = getProcessStartTime(process.pid) ?? new Date().toISOString();
const SERVER_SID = process.env.CLAUDE_CODE_SESSION_ID ?? '';
const launchedHandles = new Set<string>();

export function trackLaunched(handle: string) { launchedHandles.add(handle); }
function untrackLaunched(handle: string) { launchedHandles.delete(handle); }
// --- External reaper (detached background orphan sweeper) ---
let _reaperPid: number | undefined;
let _reaperOwned = false;

function readReaperPid(pidPath: string): number | null {
  try {
    const parsed = Number(readFileSync(pidPath, 'utf8').trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function spawnReaper(): void {
  try {
    if (_reaperPid && isProcessAlive(_reaperPid)) return;
    const reaperPath = new URL('./reaper.ts', import.meta.url).pathname;
    const pidPath = reaperPidPath();
    const existing = readReaperPid(pidPath);
    if (existing && isProcessAlive(existing)) {
      _reaperPid = existing;
      _reaperOwned = false;
      return;
    }
    try { unlinkSync(pidPath); } catch {}
    const child = spawn('bun', ['run', reaperPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    _reaperPid = child.pid;
    _reaperOwned = true;
    if (child.pid) {
      try { writeFileSync(pidPath, `${child.pid}\n`); } catch {}
    }
  } catch {}
}
// --- Repo guard ---
const _repoChecked = new Set<string>();
export function assertRepo(dir: string) {
  if (_repoChecked.has(dir)) return;
  try {
    const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('not a git repo');
  }
  catch { throw new Error(`Not a git repo: ${dir}`); }
  _repoChecked.add(dir);
}

// Single source for backend-aware process kill. markRequested sets kill_requested
// (forceKillJob path); shutdown passes false so jobs stay resumable.
function killByBackend(job: { handle: string; backend: string; worker_pid: number }, markRequested: boolean): void {
  if (markRequested) updateJob(job.handle, { kill_requested: true });
  if (job.worker_pid > 0) {
    killProcessTree(job.worker_pid, 'SIGKILL');
  }
}

export function forceKillJob(job: { handle: string; backend: string; worker_pid: number; log_path: string }): void {
  killByBackend(job, true);
}

function newHandle(backend: Backend): string {
  const id = randomUUID();
  return backend === 'claude' ? id : `w-${id.slice(0, 8)}`;
}

type LaunchResult = { handle: string; promise: Promise<RunResult> };

// Finalize a job as failed when its run promise rejects, then rethrow.
function failOnError(handle: string, p: Promise<RunResult>): Promise<RunResult> {
  return p.catch((err: unknown) => {
    finalizeJob(handle, 'failed');
    throw err;
  });
}

export function launch(
  backend: Backend,
  prompt: string,
  dir: string,
  opts: { sid: string; model?: string; complex?: boolean; extraArgs?: string[]; timeoutMs?: number; deadlineAt?: number; completionLock?: string; seed?: SeedContext; reuseWorktree?: string; reuseBaseSha?: string },
): LaunchResult {
  const handle = newHandle(backend);
  trackLaunched(handle);
  const promise: Promise<RunResult> = failOnError(handle, (async () => {
    // Ladder reuse: a climbing/retrying rung runs IN the prior rung's workspace (its uncommitted +
    // committed work is already there — no seed copy), sharing its base_sha so the report diff
    // stays anchored to the chain's original HEAD.
    const reuse = opts.reuseWorktree;
    const lp = workerLogPath(handle, dir);
    let spec = buildSpec(prompt);

    // Prepend continuation preamble if seed is present
    if (opts.seed) {
      spec = buildContinuationPreamble(opts.seed) + spec;
    }

    // ponytail: write-first + earliest-alive election. Provably <=1 worker in the
    // project dir (insert precedes read in program order -> two racers can't both
    // see only themselves). Project dir may idle if the in-place worker exits while
    // younger worktree workers persist -- safe, not optimal; re-elect oldest-alive
    // to dir on drain if reuse matters.
    const treePath = join(handleDir(handle, dir), 'tree');
    // claude picks model by task hardness: complex → sonnet, else haiku. omp self-selects.
    const claudeModel = opts.complex ? 'sonnet' : 'haiku';
    const modelToUse = backend === 'claude' ? (opts.model ?? claudeModel) : backend === 'omp' ? undefined : opts.model;
    insertJob({ handle, backend, sid: opts.sid, repo: dir, worktree_path: reuse ?? treePath, base_sha: opts.reuseBaseSha, model: modelToUse, task: prompt, log_path: lp, completion_lock: opts.completionLock, server_pid: process.pid, server_started: SERVER_STARTED, server_sid: SERVER_SID, deadline_at: opts.deadlineAt });

    let inPlace = false;
    let wt: string;
    if (reuse) { wt = reuse; }
    else {
      inPlace = isInPlaceOwner(handle, dir);
      wt = inPlace ? dir : treePath;
      if (inPlace) updateJob(handle, { worktree_path: dir });
    }

    try {
      if (reuse) {
        // Ladder reuse: reusing prior rung's workspace (could be project dir or a worktree).
        clearStaleIndexLock(reuse);
        await loginShellEnvAsync();
      } else if (inPlace) {
        // In-place: run directly in the project directory, no worktree.
        const [, base_sha, branch] = await Promise.all([
          loginShellEnvAsync(),
          new Promise<string | undefined>(resolve => {
            const chunks: Buffer[] = [];
            const p = spawn('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
            p.stdout?.on('data', (d: Buffer) => chunks.push(d));
            p.on('close', () => resolve(Buffer.concat(chunks).toString().trim() || undefined));
            p.on('error', () => resolve(undefined));
          }),
          new Promise<string>(resolve => {
            const chunks: Buffer[] = [];
            const p = spawn('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
            p.stdout?.on('data', (d: Buffer) => chunks.push(d));
            p.on('close', () => resolve(Buffer.concat(chunks).toString().trim() || 'HEAD'));
            p.on('error', () => resolve('HEAD'));
          }),
        ]);
        if (base_sha) updateJob(handle, { base_sha });
        updateJob(handle, { branch });
      } else {
        // Concurrent worker — isolated worktree from HEAD.
        const [createdWt, , base_sha] = await Promise.all([
          addWorktreeAsync(dir, handle),
          loginShellEnvAsync(),
          new Promise<string | undefined>(resolve => {
            const chunks: Buffer[] = [];
            const p = spawn('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
            p.stdout?.on('data', (d: Buffer) => chunks.push(d));
            p.on('close', () => resolve(Buffer.concat(chunks).toString().trim() || undefined));
            p.on('error', () => resolve(undefined));
          }),
        ]);
        if (createdWt !== wt) throw new Error(`worktree path mismatch for ${handle}`);
        if (base_sha) updateJob(handle, { base_sha });
        updateJob(handle, { branch: `worker/${handle}` });
      }
    } catch (err) {
      untrackLaunched(handle);
      throw err;
    }

    const argv = buildRunArgv(backend, spec, wt, handle, modelToUse, opts.extraArgs);
    const initToken = backend === 'opencode' ? '' : getResumeToken(backend, handle, lp);
    const result = await runWorker(argv, wt, handle, backend, lp, initToken, opts.timeoutMs, opts.deadlineAt);
    if (backend === 'opencode') {
      const tok = getResumeToken('opencode', handle, lp);
      if (tok) { result.resume_token = tok; updateJob(handle, { resume_token: tok }); }
    }
    return result;
  })()).finally(() => untrackLaunched(handle));

  return { handle, promise };
}

export async function shutdown(): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  // Reaper kill is independent of worker teardown — fire it first (instant), don't gate
  // it behind the kills.
  if (_reaperOwned && _reaperPid) {
    try { process.kill(_reaperPid, 'SIGTERM'); } catch {}
  }

  const jobs: NonNullable<ReturnType<typeof getJob>>[] = [];
  for (const handle of launchedHandles) {
    const job = getJob(handle);
    if (!job || (job.status !== 'running' && job.status !== 'stopped')) continue;
    jobs.push(job);
  }
  launchedHandles.clear();

  // Batch-kill every pid-backed worker tree from ONE process-table snapshot (2 `ps`
  // Batch-kill every pid-backed worker tree from ONE process-table snapshot.
  // Jobs stay resumable (finalized 'failed', not kill_requested).
  killProcessTrees(jobs.filter(j => j.worker_pid > 0).map(j => j.worker_pid), 'SIGKILL');
  for (const job of jobs) {
    finalizeJob(job.handle, 'failed', { resume_token: job.resume_token });
  }
  process.exit(0);
}
let _shuttingDown = false;
export function resetShutdownState(): void { _shuttingDown = false; launchedHandles.clear(); _reaperPid = undefined; _reaperOwned = false; }

export function resumeLaunch(args: { handle: string; prompt: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; promise: Promise<RunResult> } {
  const { handle, prompt, dir, timeout, extraArgs } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found for handle: ${handle}`);
  updateJob(handle, { kill_requested: false });

  const wtDir = job.worktree_path ?? dir;

  const be = job.backend as Backend;
  const lp = workerLogPath(handle);
  let spec = buildSpec(prompt);
  if (be === 'cmd') {
    spec = `A prior attempt already ran in this repo — inspect the working tree, determine what is already done, and complete only the remainder.\n\n` + spec;
  }
  const argv = buildResumeArgv(be, spec, wtDir, job.resume_token, job.model, extraArgs);
  const p = runWorker(argv, wtDir, handle, be, lp,
    job.resume_token, timeout ? timeout * 1000 : undefined);
  return { handle, promise: failOnError(handle, p) };
}
