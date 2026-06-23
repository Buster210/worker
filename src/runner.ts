import { spawn } from 'child_process';
import { openSync, closeSync, writeSync } from 'fs';
import { updateJob, getJob, finalizeJob } from './state.ts';
import { emitsJsonLog, QUIET_BACKENDS, type Backend } from './backends.ts';
import { readSentinel } from './logParse.ts';
import { resolveStatus } from './status.ts';
import { killProcessTree } from './process.ts';
import { startActivityMonitor } from './monitor.ts';
import { maybeVerifyAndCommit } from './commit.ts';

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
      try { updateJob(handle, { worker_pid: proc.pid, deadline_at: deadline }); } catch {}
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
