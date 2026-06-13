import { spawn, spawnSync } from 'child_process';
import { openSync, closeSync, writeSync } from 'fs';
import { updateJob, getJob, removeLock, finalizeJob } from './state.ts';
import { emitsJsonLog, type Backend } from './backends.ts';
import { readSentinel } from './logParse.ts';
import { resolveStatus } from './status.ts';
import { killProcessTree, killGroup, isProcessAlive } from './process.ts';
import { startActivityMonitor } from './monitor.ts';

import { defaultTimeoutMs, workerEnv, pollIntervalMs, resumePollIntervalMs, stallTimeoutMs } from './env.ts';

export type RunResult = {
  status: string;
  exit_code: number;
  backend: string;
  handle: string;
  resume_token: string;
  repo: string;
  shortstat: string;
  log: string;
};

export function shortstat(repo: string): string {
  try {
    const r = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', timeout: 2000 });
    if (r.status !== 0) return 'unknown';
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return 'no changes';
    let adds = 0, dels = 0;
    try {
      const n = spawnSync('git', ['-C', repo, 'diff', '--numstat', 'HEAD'], { encoding: 'utf8', timeout: 2000 });
      if (n.status === 0) {
        for (const ln of n.stdout.split('\n').filter(Boolean)) {
          const [a, d] = ln.split('\t');
          adds += a === '-' ? 0 : Number(a);
          dels += d === '-' ? 0 : Number(d);
        }
      }
    } catch {}
    return `${lines.length} file${lines.length === 1 ? '' : 's'} +${adds}/-${dels}`;
  } catch { return 'unknown'; }
}

export function decideFateAfterFreeze(handle: string, pid: number, logPath: string, backend: string): boolean {
  const { status, lastText } = readSentinel(logPath, emitsJsonLog(backend));
  const isFailed = status !== null && status.startsWith('failed');
  const lastLine = lastText.length > 500 ? lastText.slice(0, 500) : lastText;

  if (!isFailed) {
    updateJob(handle, { status: 'stopped', stopped_at: new Date().toISOString(), last_line: lastLine });
    removeLock(handle);
    return true;
  }
  killProcessTree(pid, 'SIGKILL');
  setTimeout(() => killProcessTree(pid, 'SIGKILL'), 5_000).unref?.();
  return false;
}

export function freezeThenDecide(handle: string, pid: number, logPath: string, backend: string): boolean {
  killGroup(pid, 'SIGSTOP');
  return decideFateAfterFreeze(handle, pid, logPath, backend);
}

export function backendShellArgv(argv: string[]): string[] {
  const shell = process.env.SHELL ?? '/bin/zsh';
  return [shell, '-c', '[ -n "$WORKER_RC" ] && [ -f "$WORKER_RC" ] && . "$WORKER_RC"; "$0" "$@"', ...argv];
}

export function launchAndWait(
  argv: string[],
  repo: string,
  handle: string,
  backend: Backend,
  logPath: string,
  timeoutMs: number = defaultTimeoutMs(),
): Promise<{ rc: number; timedOut: boolean; stopped: boolean; dirty: string }> {
  return new Promise((resolve) => {
    const logFd = openSync(logPath, 'a');
    const [cmd, ...args] = backendShellArgv(argv);
    const proc = spawn(cmd, args, {
      cwd: repo,
      env: workerEnv,
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });

    if (proc.pid) {
      try { updateJob(handle, { worker_pid: proc.pid }); } catch {}
    }

    let rc = 0;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    let exiting = false;
    const startMs = Date.now();
    const mon = startActivityMonitor(repo, logPath);
    let lastSig = mon.sig;
    let lastActivityAt = mon.at;

    const finish = (code: number, timed: boolean, stoppedJob: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      const dirty = mon.dirty;
      try { mon.dispose(); } catch {}
      try { closeSync(logFd); } catch {}
      resolve({ rc: code, timedOut: timed, stopped: stoppedJob, dirty });
    };

    const freezeAndFinish = () => {
      if (settled || exiting) return;
      killGroup(proc.pid!, 'SIGSTOP');
      setTimeout(() => {
        if (settled || exiting) return;
        if (!isProcessAlive(proc.pid!)) { exiting = true; finish(124, true, false); return; }
        stopped = decideFateAfterFreeze(handle, proc.pid!, logPath, backend);
        finish(124, true, stopped);
      }, 20);
    };

    const watchdog = setInterval(() => {
      if (settled || exiting) return;
      const now = Date.now();

      if (now - startMs >= timeoutMs) {
        timedOut = true;
        freezeAndFinish();
        return;
      }
      if (mon.sig !== lastSig) { lastSig = mon.sig; lastActivityAt = mon.at; }
      else if (now - lastActivityAt >= stallTimeoutMs()) {
        freezeAndFinish();
        return;
      }
    }, pollIntervalMs());

    proc.on('exit', (code, signal) => {
      exiting = true;
      rc = code ?? (signal ? 1 : 0);
      finish(rc, false, false);
    });

    proc.on('error', (err) => {
      try { writeSync(logFd, `\nspawn error: ${err.message}\n`); } catch {}
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
): Promise<RunResult> {
  const { rc, timedOut, stopped, dirty } = await launchAndWait(argv, repo, handle, backend, logPath, timeoutMs);
  let status: string;
  if (stopped) {
    status = 'stopped';
  } else {
    status = finalizeJob(handle, resolveStatus(backend, rc, logPath, timedOut), { resume_token: resumeToken });
  }
  const ss = shortstatFromDirty(dirty) ?? shortstat(repo);
  return {
    status, exit_code: rc, backend, handle,
    resume_token: resumeToken, repo,
    shortstat: ss,
    log: logPath,
  };
}

function shortstatFromDirty(dirty: string): string | null {
  if (!dirty) return null;
  const lines = dirty.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return 'no changes';
  return `${lines.length} file${lines.length === 1 ? '' : 's'}`;
}

export function watchExisting(
  handle: string,
  pid: number,
  repo: string,
  logPath: string,
  backend: Backend,
  deadlineMs: number,
): Promise<RunResult> {
  const job = getJob(handle);
  const resumeToken = job?.resume_token ?? '';
  const watchStart = Date.now();
  const mon = startActivityMonitor(repo, logPath);
  let lastSig = mon.sig;
  let lastActivityAt = mon.at;

  return new Promise((resolve) => {
    let resolved = false;
    const buildResult = (status: string): RunResult => ({
      status, exit_code: 0, backend, handle,
      resume_token: resumeToken, repo, shortstat: '', log: logPath,
    });
    const finish = (status: string) => {
      if (resolved) return;
      resolved = true;
      try { mon.dispose(); } catch {}
      resolve(buildResult(status));
    };

    const suspend = () => {
      if (freezeThenDecide(handle, pid, logPath, backend)) {
        finish('stopped');
      } else {
        finish(finalizeJob(handle, resolveStatus(backend, 124, logPath, true)));
      }
    };

    const check = () => {
      if (resolved) return;
      if (!isProcessAlive(pid)) {
        finish(finalizeJob(handle, resolveStatus(backend, 0, logPath, false)));
        return;
      }
      const now = Date.now();
      if (now - watchStart >= deadlineMs) { suspend(); return; }
      if (mon.sig !== lastSig) { lastSig = mon.sig; lastActivityAt = mon.at; }
      else if (now - lastActivityAt >= stallTimeoutMs()) { suspend(); return; }
      setTimeout(check, resumePollIntervalMs());
    };
    check();
  });
}
