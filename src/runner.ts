import { spawn, spawnSync } from 'child_process';
import { openSync, closeSync, writeSync, statSync } from 'fs';
import { updateJob, getJob, finalizeJob } from './state.ts';
import { emitsJsonLog, QUIET_BACKENDS, type Backend } from './backends.ts';
import { readSentinel } from './logParse.ts';
import { killProcessTree } from './process.ts';
import { FILE_CONFIG } from './config.ts';

import { defaultTimeoutMs, workerEnv, watchdogMs, stallTimeoutMs, quietStallMs, graceMs, cpuThrottleArgv } from './env.ts';

export type RunResult = {
  status: string;
  exit_code: number;
  backend: string;
  handle: string;
  resume_token: string;
  repo: string;
  log: string;
};
function markStallOutcome(handle: string, pid: number, logPath: string, backend: string): boolean {
  killProcessTree(pid, 'SIGKILL');
  const { status } = readSentinel(logPath, emitsJsonLog(backend));
  if (status !== null && status.startsWith('failed')) {
    return false;
  }
  finalizeJob(handle, 'stalled');
  return true;
}

export function backendShellArgv(argv: string[]): string[] {
  const shell = process.env.SHELL ?? '/bin/zsh';
  return [...cpuThrottleArgv(), shell, '-c', '[ -n "$WORKER_RC" ] && [ -f "$WORKER_RC" ] && . "$WORKER_RC"; "$0" "$@"', ...argv];
}

function launchAndWait(
  argv: string[],
  repo: string,
  handle: string,
  backend: Backend,
  logPath: string,
  timeoutMs?: number,
  deadlineAt?: number,
): Promise<{ rc: number; timedOut: boolean; stalled: boolean }> {
  return new Promise((resolve) => {
    const logFd = openSync(logPath, 'a');
    const [cmd, ...args] = backendShellArgv(argv);
    const proc = spawn(cmd, args, {
      cwd: repo,
      env: workerEnv(),
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    const startMs = Date.now();
    const deadline = deadlineAt ?? (startMs + (timeoutMs ?? defaultTimeoutMs()));

    if (proc.pid) {
      try { updateJob(handle, { worker_pid: proc.pid, deadline_at: deadline }); } catch (err) {
        console.error('[worker] failed to update job with PID:', err instanceof Error ? err.message : err);
      }
    }

    let rc = 0;
    let stalled = false;
    let settled = false;
    let exiting = false;
    const mon = startActivityMonitor(repo, logPath);
    let lastSig = mon.sig;
    let lastActivityAt = mon.at;

    const finish = (code: number, timed: boolean, stalledJob: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      try { mon.dispose(); } catch {}
      try { closeSync(logFd); } catch {}
      resolve({ rc: code, timedOut: timed, stalled: stalledJob });
    };

    const killOnStallAndFinish = () => {
      if (settled || exiting) return;
      exiting = true;
      stalled = markStallOutcome(handle, proc.pid!, logPath, backend);
      finish(124, false, stalled);
    };

    // Hard backstop: if the deadline passes and nobody calls worker_extend within the
    // grace window, terminal-kill (no freeze, no resume). deadline_at is read fresh so
    // worker_extend pushes this out at runtime.
    const killAtGrace = () => {
      if (settled || exiting) return;
      exiting = true;
      killProcessTree(proc.pid!, 'SIGKILL');
      finish(124, true, false);
    };

    const watchdog = setInterval(() => {
      if (settled || exiting) return;
      const now = Date.now();
      const deadline = getJob(handle)?.deadline_at;
      if (deadline && now >= deadline + graceMs()) { killAtGrace(); return; }

      if (mon.sig !== lastSig) { lastSig = mon.sig; lastActivityAt = mon.at; }
      else if (now - lastActivityAt >= (QUIET_BACKENDS.has(backend) ? quietStallMs() : stallTimeoutMs())) {
        killOnStallAndFinish();
        return;
      }
    }, watchdogMs());
    watchdog.unref?.();

    proc.on('exit', (code, signal) => {
      exiting = true;
      rc = code ?? (signal ? 1 : 0);
      finish(rc, false, false);
    });

    proc.on('error', (err) => {
      const msg = `spawn error: ${err.message}`;
      console.error('[worker] backend spawn failed:', msg);
      try { writeSync(logFd, `\n${msg}\n`); } catch {}
      finish(1, false, false);
    });
  });
}

export async function runWorker(
  argv: string[],
  repo: string,
  handle: string,
  backend: Backend,
  logPath: string,
  resumeToken: string,
  timeoutMs?: number,
  deadlineAt?: number,
): Promise<RunResult> {
  const { rc, timedOut, stalled } = await launchAndWait(argv, repo, handle, backend, logPath, timeoutMs, deadlineAt);
  let status: string;
  if (stalled) {
    status = 'stalled';
  } else {
    const natural = resolveStatus(backend, rc, logPath, timedOut);
    const gated = maybeVerifyAndCommit(handle, repo, natural);
    status = finalizeJob(handle, gated, { resume_token: resumeToken });
  }
  return {
    status, exit_code: rc, backend, handle,
    resume_token: resumeToken, repo,
    log: logPath,
  };
}

// Shared status resolver — used by both runner.ts (live job finalization) and
// maintenance.ts (orphan sweep's dead-worker branch).
export function resolveStatus(backend: string, rc: number, logPath: string, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  const { status } = readSentinel(logPath, emitsJsonLog(backend));
  if (status) return status;
  if (backend === 'cmd') return rc === 0 ? 'done' : rc === 8 ? 'failed:max-turns' : 'failed';
  if (backend === 'pool') return rc === 0 ? 'done' : rc === 4 ? 'failed:task' : 'failed';
  return rc === 0 ? 'done' : 'failed';
}

type ActivityMonitor = {
  readonly sig: string;
  readonly log: string;
  readonly at: number;
  readonly repo: string;
  readonly logPath: string;
  dispose: () => void;
};

const _activityMonitors = new Map<string, ActivityMonitor>();

function readLogStat(logPath: string): string {
  try { const st = statSync(logPath); return `${st.mtimeMs}:${st.size}`; } catch { return ''; }
}

// ponytail: poll-on-read, no fs.watch. The watchdog reads sig/at every WORKER_WATCHDOG_MS (5s),
// each read runs poll() -> one statSync. fs.watch on the actively-appended worker log fired a
// callback per write (Bun/macOS kqueue event storm -> a pegged core for the whole run) while the
// watchdog never observes the sub-5s updates anyway. If a backend ever needs finer stall timing,
// shrink WORKER_WATCHDOG_MS rather than re-adding a watcher.
export function activitySig(repo: string, logPath: string, lastLog: string): { sig: string; log: string } {
  const log = readLogStat(logPath);
  if (log !== lastLog) return { sig: log, log };
  const r = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  const git = typeof r.stdout === 'string' ? r.stdout.trim() : '';
  return { sig: `${log}\n${git}`, log };
}

export function startActivityMonitor(repo: string, logPath: string): ActivityMonitor {
  const key = `${repo}\0${logPath}`;
  let cachedLog = readLogStat(logPath);
  let cachedAt = Date.now();
  let lastPollAt = 0;
  const poll = () => {
    if (Date.now() === lastPollAt) return;
    lastPollAt = Date.now();
    const fresh = readLogStat(logPath);
    if (fresh && fresh !== cachedLog) { cachedLog = fresh; cachedAt = Date.now(); }
  };
  const mon: ActivityMonitor = {
    get sig() { poll(); return cachedLog; },
    get log() { return cachedLog; },
    get at() { poll(); return cachedAt; },
    repo,
    logPath,
    dispose() {
      _activityMonitors.delete(key);
    },
  };
  _activityMonitors.set(key, mon);
  return mon;
}

export function __resetActivityMonitors(): void {
  for (const m of _activityMonitors.values()) { try { m.dispose(); } catch {} }
  _activityMonitors.clear();
}

function commitMessage(handle: string): string {
  const task = getJob(handle)?.task ?? '';
  const firstLine = task.split('\n')[0].trim();
  return firstLine ? `worker: ${firstLine}`.slice(0, 72) : 'worker: automated change';
}

function stageWorktree(worktree: string, handle: string): 'ok' | 'failed:commit' {
  const add = spawnSync('git', ['-C', worktree, 'add', '-A', '--', ':!.codegraph'], { encoding: 'utf8', timeout: 30_000 });
  if (add.error) {
    console.error(`[commit] git add failed for ${handle}: ${add.error.message}`);
    return 'failed:commit';
  }
  if (add.status !== 0) {
    console.error(`[commit] git add failed for ${handle}: ${add.stderr?.trim() ?? ''}`);
    return 'failed:commit';
  }
  return 'ok';
}

function hasStagedChanges(worktree: string): 'yes' | 'no' | 'failed:commit' {
  const diff = spawnSync('git', ['-C', worktree, 'diff', '--cached', '--quiet'], { encoding: 'utf8', timeout: 30_000 });
  if (diff.error) {
    console.error(`[commit] git diff --cached --quiet failed: ${diff.error.message}`);
    return 'failed:commit';
  }
  return diff.status === 0 ? 'no' : 'yes';
}

function commitWork(worktree: string, handle: string): 'done' | 'failed:commit' | 'failed:no-changes' {
  const staged = stageWorktree(worktree, handle);
  if (staged !== 'ok') return staged;
  const stagedChanges = hasStagedChanges(worktree);
  if (stagedChanges === 'failed:commit') return 'failed:commit';
  if (stagedChanges === 'no') return 'failed:no-changes';

  const commit = spawnSync('git', ['-C', worktree, 'commit', '-m', commitMessage(handle)], { encoding: 'utf8', timeout: 60_000 });
  if (commit.error) {
    console.error(`[commit] git commit failed for ${handle}: ${commit.error.message}`);
    return 'failed:commit';
  }
  if (commit.status !== 0) {
    console.error(`[commit] git commit failed for ${handle}: ${commit.stderr?.trim() ?? ''}`);
    return 'failed:commit';
  }
  return 'done';
}

export function maybeVerifyAndCommit(handle: string, worktree: string, natural: string): string {
  if (natural !== 'done') return natural;

  const cmd = process.env.WORKER_VERIFY_CMD ?? FILE_CONFIG.verifyCmd;
  if (cmd && cmd.length > 0) {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const result = spawnSync(shell, ['-c', cmd], { cwd: worktree, timeout: 120_000, stdio: 'ignore' });
    if (result.status !== 0 || result.error) {
      console.error(`[commit] verify gate failed for ${handle}: exit ${result.status ?? 'error'}`);
      return 'failed:verify';
    }
  }

  return commitWork(worktree, handle);
}
