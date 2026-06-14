import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { killProcessTree, isProcessAlive } from './process.ts';
import { defaultTimeoutMs, workerEnv } from './env.ts';
import {
  insertJob, getJob, updateJob, createLock, logPath as workerLogPath, finalizeJob,
  getRunningJobsForRepo,
} from './state.ts';
import { buildSpec, buildRunArgv, buildResumeArgv, getResumeToken, type Backend } from './backends.ts';
import { runWorker, watchExisting, type RunResult } from './runner.ts';
import { runClaudeTmux } from './claudeTmux.ts';

// --- Server lifecycle state ---
export const SERVER_STARTED = new Date().toISOString();
const SERVER_SID = process.env.CLAUDE_CODE_SESSION_ID ?? '';
const launchedHandles = new Set<string>();

export function trackLaunched(handle: string) { launchedHandles.add(handle); }
function untrackLaunched(handle: string) { launchedHandles.delete(handle); }

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

export function forceKillJob(job: { handle: string; backend: string; worker_pid: number; log_path: string }): void {
  updateJob(job.handle, { kill_requested: true });
  if (job.backend === 'claude_tmux') {
    try { spawnSync('tmux', ['kill-session', '-t', job.handle], { stdio: 'ignore' }); } catch {}
  } else if (job.worker_pid > 0) {
    killProcessTree(job.worker_pid, 'SIGKILL');
  }
}

function newHandle(backend: Backend): string {
  const id = randomUUID();
  return backend === 'claude' ? id : `w-${id.slice(0, 8)}`;
}

function killLingeringJobs(dir: string): void {
  for (const job of getRunningJobsForRepo(dir)) {
    forceKillJob(job);
    finalizeJob(job.handle, 'killed');
  }
}

type LaunchResult = { handle: string; promise: Promise<RunResult> };

export function launch(
  backend: Backend,
  prompt: string,
  dir: string,
  opts: { sid: string; model?: string; extraArgs?: string[]; timeoutMs?: number; completionLock?: string },
): LaunchResult {
  const handle = newHandle(backend);
  trackLaunched(handle);
  killLingeringJobs(dir);
  const lp = workerLogPath(handle, dir);
  const spec = buildSpec(backend, prompt);
  const modelToUse = (backend === 'claude' || backend === 'omp' || backend === 'claude_tmux') ? undefined : opts.model;
  insertJob({ handle, backend, sid: opts.sid, repo: dir, model: modelToUse, task: prompt, log_path: lp, completion_lock: opts.completionLock, server_pid: process.pid, server_started: SERVER_STARTED, server_sid: SERVER_SID });

  const trackError = (p: Promise<RunResult>): Promise<RunResult> => p.catch((err: unknown) => {
    finalizeJob(handle, 'failed');
    throw err;
  });

  let promise: Promise<RunResult>;
  if (backend === 'claude_tmux') {
    promise = trackError(runClaudeTmux(spec, dir, handle, handle, opts.timeoutMs));
  } else {
    const argv = buildRunArgv(backend, spec, dir, handle, modelToUse, opts.extraArgs);
    const initToken = backend === 'opencode' ? '' : getResumeToken(backend, handle, lp);
    promise = trackError(runWorker(argv, dir, handle, backend, lp, initToken, opts.timeoutMs))
      .then(r => {
        if (backend === 'opencode') {
          const tok = getResumeToken('opencode', handle, lp);
          if (tok) { r.resume_token = tok; updateJob(handle, { resume_token: tok }); }
        }
        return r;
      });
  }
  promise.then(() => untrackLaunched(handle), () => untrackLaunched(handle));
  return { handle, promise };
}

export async function shutdown(): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  const toKill: string[] = [];
  for (const handle of launchedHandles) {
    const job = getJob(handle);
    if (!job || (job.status !== 'running' && job.status !== 'stopped')) continue;
    toKill.push(handle);
  }
  launchedHandles.clear();
  for (const handle of toKill) {
    const job = getJob(handle);
    if (!job) continue;
    if (job.worker_pid > 0) killProcessTree(job.worker_pid, 'SIGKILL');
    finalizeJob(handle, 'failed', { resume_token: job.resume_token });
    launchedHandles.delete(handle);
  }
  process.exit(0);
}
let _shuttingDown = false;
export function resetShutdownState(): void { _shuttingDown = false; launchedHandles.clear(); }

export function resumeLaunch(args: { handle: string; prompt: string; dir: string; timeout?: number; extraArgs?: string[] }): { handle: string; promise: Promise<RunResult> } {
  const { handle, prompt, dir, timeout, extraArgs } = args;
  const job = getJob(handle);
  if (!job) throw new Error(`No job found for handle: ${handle}`);
  updateJob(handle, { kill_requested: false });

  const trackError = (p: Promise<RunResult>): Promise<RunResult> => p.catch((err: unknown) => {
    finalizeJob(handle, 'failed');
    throw err;
  });

  if (job.status === 'stopped') {
    const pid = job.worker_pid;
    if (!isProcessAlive(pid, job.started)) {
      const be = job.backend as Backend;
      const lp = workerLogPath(handle);
      const spec = buildSpec(be, prompt);
      const argv = buildResumeArgv(be, spec, dir, job.resume_token, undefined, extraArgs);
      const p = runWorker(argv, dir, handle, be, lp,
        job.resume_token, timeout ? timeout * 1000 : undefined);
      return { handle, promise: trackError(p) };
    }

    try { process.kill(-pid, 'SIGCONT'); } catch {}
    updateJob(handle, { status: 'running' });
    createLock(handle);

    const be = job.backend as Backend;
    const lp = workerLogPath(handle);
    const deadlineMs = timeout ? timeout * 1000 : defaultTimeoutMs();
    return { handle, promise: trackError(watchExisting(handle, pid, dir, lp, be, deadlineMs)) };
  }

  const be = job.backend as Backend;
  const lp = workerLogPath(handle);
  let spec = buildSpec(be, prompt);
  if (be === 'cmd') {
    spec = `A prior attempt already ran in this repo — inspect the working tree, determine what is already done, and complete only the remainder.\n\n` + spec;
  }
  const argv = buildResumeArgv(be, spec, dir, job.resume_token, undefined, extraArgs);
  const p = runWorker(argv, dir, handle, be, lp,
    job.resume_token, timeout ? timeout * 1000 : undefined);
  return { handle, promise: trackError(p) };
}