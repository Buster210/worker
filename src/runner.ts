import { spawn, spawnSync, execSync } from 'child_process';
import { createWriteStream, statSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, realpathSync } from 'fs';
import { updateJob, getJob, getAllRunningJobs, removeLock, logPath as workerLogPath, WORKERS_DIR, finalizeJob } from './state.ts';
import type { Backend } from './backends.ts';
import type { Job } from './state.ts';

// In-process job registry — survives for the lifetime of this MCP server process.
// If the server restarts mid-job, waitJob falls back to PID polling + log-based status.
const runningJobs = new Map<string, Promise<RunResult>>();
export function trackJob(handle: string, p: Promise<RunResult>) {
  runningJobs.set(handle, p.finally(() => runningJobs.delete(handle)));
}
export async function waitJob(handle: string): Promise<RunResult> {
  const p = runningJobs.get(handle);
  if (p) return p;
  // Fallback: server restarted — poll PID liveness, derive status from log when dead
  while (true) {
    const job = getJob(handle);
    if (!job) throw new Error(`No job: ${handle}`);
    if (job.status !== 'running' && job.status !== 'stopped') return jobToResult(job);
    // For stopped jobs: if process is alive (frozen), return immediately
    if (job.status === 'stopped') {
      if (isProcessAlive(job.worker_pid, job.started)) {
        return jobToResult(job);
      }
      // Process is dead, derive status from log
      const status = resolveStatus(job.backend, 0, job.log_path, false);
      const completedJob = { ...job, status };
      return jobToResult(completedJob);
    }
    // For running jobs
    let alive = false;
    if (job.worker_pid) { alive = isProcessAlive(job.worker_pid, job.started); }
    if (!alive) {
      const status = finalizeJob(handle, resolveStatus(job.backend, 0, job.log_path, false));
      return jobToResult({...job, status});
    }
    await Bun.sleep(2_000);
  }
}

// On startup: mark any jobs still showing 'running' whose PIDs are dead as failed.
// Prevents stale state after a server restart mid-job.
export const DEFAULT_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 5_000;
const LOG_FRESHNESS_THRESHOLD_MS = 30_000;
const STALL_DETECTION_TIMEOUT_MS = 120_000;

// Augmented PATH so backends are findable (MCP server env is stripped)
const HOME = process.env.HOME ?? '';
export const workerEnv: NodeJS.ProcessEnv = {
  ...process.env,
  // rc the backend shell sources for env + key-injecting wrappers (see backendShellArgv).
  // Passed via env (not interpolated into the script) so its value can never be code-injected.
  WORKER_RC: process.env.WORKER_RC ?? `${HOME}/.common`,
  PATH: [
    `${HOME}/.bun/bin`,
    `${HOME}/.local/bin`,
    `${HOME}/.cargo/bin`,
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    process.env.PATH ?? '',
  ].join(':'),
};

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

export function jobToResult(job: Job): RunResult {
  return {
    status: job.status,
    exit_code: 0,
    backend: job.backend,
    handle: job.handle,
    resume_token: job.resume_token,
    repo: job.repo,
    shortstat: '',
    log: job.log_path,
  };
}

function shortstat(repo: string): string {
  try {
    const diffResult = spawnSync('git', ['diff', '--shortstat'], { cwd: repo, encoding: 'utf8' });
    const diffCachedResult = spawnSync('git', ['diff', '--cached', '--shortstat'], { cwd: repo, encoding: 'utf8' });
    const diffStat = (diffResult.stdout + diffCachedResult.stdout).trim();
    const untrackedResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' });
    const ut = untrackedResult.stdout.trim().split('\n').filter(Boolean).length;
    return [diffStat, ut > 0 ? `${ut} untracked` : ''].filter(Boolean).join(', ') || 'no changes';
  } catch { return 'unknown'; }
}

function resolveStatus(backend: string, rc: number, logPath: string, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const recent = lines.slice(-10);
    for (let i = recent.length - 1; i >= 0; i--) {
      const line = recent[i];
      if (/^DONE(\s|$)/.test(line)) return 'done';
      if (/^FAILED(:|$|\s)/.test(line)) {
        const reason = line.replace(/^FAILED:?\s*/, '').trim();
        return reason ? `failed:${reason}` : 'failed';
      }
    }
  } catch {}
  if (backend === 'cmd') return rc === 0 ? 'done' : rc === 8 ? 'failed:max-turns' : 'failed';
  if (backend === 'pool') return rc === 0 ? 'done' : rc === 4 ? 'failed:task' : 'failed';
  return rc === 0 ? 'done' : 'failed';
}

export { resolveStatus };

export function sweepStaleJobs() {
  for (const job of getAllRunningJobs()) {
    // Handle orphaned stopped jobs: frozen pid reparented to init can't be reattached
    if (job.status === 'stopped') {
      if (!isProcessAlive(job.worker_pid, job.started)) {
        finalizeJob(job.handle, 'failed:server-restart');
        continue;
      }
      continue;
    }
    
    let alive = false;
    if (job.worker_pid) { alive = isProcessAlive(job.worker_pid, job.started); }
    if (!alive) {
      const status = resolveStatus(job.backend, 0, job.log_path, false);
      finalizeJob(job.handle, status === 'done' ? status : 'failed:server-restart');
    }
  }
}

function killGroup(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' = 'SIGTERM') {
  try { process.kill(-pid, sig); } catch {}
}

function getLogMtime(logPath: string): number {
  try {
    return statSync(logPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * After SIGSTOP, decide whether a timed-out job was still productively working.
 * Productive (log mtime fresh AND last line not FAILED) → mark 'stopped', remove lock,
 * leave the process frozen for SIGCONT resume → returns true.
 * Otherwise → SIGKILL the group, terminal → returns false.
 * Caller must have already SIGSTOP'd the group.
 */
function evalAfterStop(handle: string, pid: number, logPath: string): boolean {
  const isMakingProgress = (Date.now() - getLogMtime(logPath)) < LOG_FRESHNESS_THRESHOLD_MS;
  let lastLine = '';
  let isFailed = false;
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    lastLine = lines[lines.length - 1] ?? '';
    isFailed = /^FAILED(:|$|\s)/.test(lastLine);
  } catch {}

  if (isMakingProgress && !isFailed) {
    updateJob(handle, { status: 'stopped', stopped_at: new Date().toISOString(), last_line: lastLine });
    removeLock(handle);
    return true;
  }
  killGroup(pid, 'SIGKILL');
  setTimeout(() => killGroup(pid, 'SIGKILL'), 5_000);
  return false;
}

/** SIGSTOP the group then evaluate — used by the resume path when a re-armed timeout fires. */
export function suspendAndEval(handle: string, pid: number, logPath: string): boolean {
  killGroup(pid, 'SIGSTOP');
  return evalAfterStop(handle, pid, logPath);
}

function getProcessStartTime(pid: number): string | null {
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    const lstart = result.stdout.trim();
    // ps lstart format: "Tue Jun 10 21:00:00 2026"
    const date = new Date(lstart);
    return isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number, started?: string): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  
  if (!started) return true;
  
  const procStart = getProcessStartTime(pid);
  if (!procStart) return true;
  
  const jobStart = new Date(started);
  const procStartDate = new Date(procStart);
  const skewMs = Math.abs(procStartDate.getTime() - jobStart.getTime());
  
  return skewMs < 60_000;
}
/**
 * Composite activity signature: log size + git diff --stat + git status --porcelain.
 * Changes in any component mean the worker is still producing output.
 */
function activitySig(repo: string, logPath: string): string {
  let logSize = 0;
  try { logSize = statSync(logPath).size; } catch {}
  let gitDiff = '';
  try { gitDiff = spawnSync('git', ['-C', repo, 'diff', '--stat'], { encoding: 'utf8', timeout: 2000 }).stdout ?? ''; } catch {}
  let gitStatus = '';
  try { gitStatus = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', timeout: 2000 }).stdout ?? ''; } catch {}
  return logSize + gitDiff + gitStatus;
}

// Wrap argv to run through a NON-INTERACTIVE shell that first sources the host's env-defining
// rc, so backends inherit its env + per-launch auth wrappers (e.g. provider-key injectors) that
// the stripped MCP server env lacks — WITHOUT any interactive cosmetics (prompt frameworks,
// fastfetch banners, job-control setopts) that corrupt a headless, TTY-less worker's stdio. An
// interactive shell (`-i`) into a pipe makes `[[ -o interactive ]]` guards fire with no terminal,
// flooding the backend's channel; `-c` keeps the rc's own guards correctly skipping cosmetics.
// The rc path arrives as $WORKER_RC in the spawn env (workerEnv) and the backend command as $0 +
// argv — BOTH are data the shell expands at runtime, never text interpolated into the script
// string, so neither can inject code (a WORKER_RC of `$(rm -rf ~)` is sourced as a filename, not
// evaluated). Empty/missing WORKER_RC sources nothing. $0 honors a shell function of that name.
function backendShellArgv(argv: string[]): string[] {
  const shell = process.env.SHELL ?? '/bin/zsh';
  return [shell, '-c', '[ -n "$WORKER_RC" ] && [ -f "$WORKER_RC" ] && . "$WORKER_RC"; "$0" "$@"', ...argv];
}

export function launchAndWait(
  argv: string[],
  repo: string,
  handle: string,
  backend: Backend,
  logPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ rc: number; timedOut: boolean; stopped: boolean }> {
  return new Promise((resolve) => {
    const logStream = createWriteStream(logPath, { flags: 'a' });
    const [cmd, ...args] = backendShellArgv(argv);
    const proc = spawn(cmd, args, {
      cwd: repo,
      env: workerEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);

    updateJob(handle, { worker_pid: proc.pid ?? 0 });

    let rc = 0;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    const startMs = Date.now();

    const finish = (code: number, timed: boolean, stoppedJob: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      logStream.end();
      resolve({ rc: code, timedOut: timed, stopped: stoppedJob });
    };
    let lastSig = '';
    let lastSigChange = Date.now();

    const watchdog = setInterval(() => {
      if (settled) return;
      const now = Date.now();

      if (now - startMs >= timeoutMs) {
        timedOut = true;
        killGroup(proc.pid!, 'SIGSTOP');

        setTimeout(() => {
          if (settled) return;
          stopped = evalAfterStop(handle, proc.pid!, logPath);
          finish(124, true, stopped);
        }, 100);
        return;
      }
      const sig = activitySig(repo, logPath);
      if (sig !== lastSig) { lastSig = sig; lastSigChange = Date.now(); }
      else if (Date.now() - lastSigChange >= STALL_DETECTION_TIMEOUT_MS) {
        killGroup(proc.pid!, 'SIGSTOP');
        setTimeout(() => {
          if (settled) return;
          stopped = evalAfterStop(handle, proc.pid!, logPath);
          finish(124, true, stopped);
        }, 100);
        return;
      }
    }, POLL_INTERVAL_MS);

    proc.on('exit', (code, signal) => {
      rc = code ?? (signal ? 1 : 0);
      finish(rc, false, false);
    });

    proc.on('error', (err) => {
      logStream.write(`\nspawn error: ${err.message}\n`);
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
  const { rc, timedOut, stopped } = await launchAndWait(argv, repo, handle, backend, logPath, timeoutMs);
  // Stopped jobs are already persisted (status='stopped', lock removed) inside evalAfterStop.
  let status: string;
  if (stopped) {
    status = 'stopped';
  } else {
    status = finalizeJob(handle, resolveStatus(backend, rc, logPath, timedOut), { resume_token: resumeToken });
  }
  return {
    status, exit_code: rc, backend, handle,
    resume_token: resumeToken, repo,
    shortstat: shortstat(repo),
    log: logPath,
  };
}

export async function runClaudeTmux(
  spec: string,
  repo: string,
  handle: string,
  sid: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RunResult> {
  try { execSync('which tmux', { stdio: 'ignore' }); }
  catch { throw new Error('claude_tmux backend requires tmux'); }

  const wdir = `${WORKERS_DIR}/tmux`;
  mkdirSync(wdir, { recursive: true });

  const setf    = `${wdir}/${sid}.settings.json`;
  const donef   = `${wdir}/${sid}.done`;
  const specf   = `${wdir}/${sid}.spec`;
  const launchf = `${wdir}/${sid}.launch.sh`;
  const logPath = workerLogPath(handle);

  // Interactive claude (no -p) does NOT auto-skip the workspace trust dialog, so a fresh/untrusted
  // repo would block the TUI on "Do you trust the files in this folder?". Pre-seed the trust state
  // in ~/.claude.json so the session starts unattended. Best-effort: never fail the run on this.
  // Claude keys trust off the *canonical* cwd (e.g. /var → /private/var on macOS), so seed the
  // realpath; also seed the raw path so either resolution hits a trusted entry.
  try {
    const cfgPath = `${process.env.HOME}/.claude.json`;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    cfg.projects = cfg.projects ?? {};
    let real = repo;
    try { real = realpathSync(repo); } catch {}
    for (const key of new Set([repo, real])) {
      const proj = cfg.projects[key] ?? {};
      cfg.projects[key] = {
        ...proj,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: proj.projectOnboardingSeenCount ?? 1,
      };
    }
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch {}

  // Sentinel: Stop hook writes to donef
  writeFileSync(setf, JSON.stringify({
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `printf 'stop\\n' >> '${donef}'` }] }] }
  }));
  writeFileSync(specf, spec);
  writeFileSync(donef, '');  // touch
  writeFileSync(launchf, `#!/usr/bin/env bash\nexec claude --settings "${setf}" --dangerously-skip-permissions --model sonnet "$(cat "${specf}")"`, { mode: 0o755 });

  try { execSync(`tmux kill-session -t ${sid} 2>/dev/null`, { stdio: 'ignore' }); } catch {}

  const spawn = spawnSync('tmux', ['new-session', '-d', '-s', sid, '-x', '220', '-y', '50', '-c', repo, `bash "${launchf}"`], {
    env: workerEnv, encoding: 'utf8',
  });

  if (spawn.status !== 0) {
    finalizeJob(handle, 'failed');
    return { status: 'failed', exit_code: 1, backend: 'claude_tmux', handle, resume_token: '', repo, shortstat: shortstat(repo), log: logPath };
  }

  updateJob(handle, { worker_pid: 0 });

  const deadline = Date.now() + timeoutMs;
  let stopped = false;

  while (Date.now() < deadline) {
    try {
      const content = readFileSync(donef, 'utf8');
      if (content.trim().length > 0) { stopped = true; break; }
    } catch {}
    try { execSync(`tmux has-session -t ${sid} 2>/dev/null`, { stdio: 'ignore' }); }
    catch { stopped = true; break; }
    await Bun.sleep(1000);
  }

  try {
    const pane = execSync(`tmux capture-pane -t ${sid} -p -S -200 2>/dev/null`, { encoding: 'utf8', env: workerEnv });
    writeFileSync(logPath, pane);
  } catch {}

  try { execSync(`tmux kill-session -t ${sid} 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  for (const f of [setf, specf, launchf, donef]) { try { unlinkSync(f); } catch {} }

  const timedOut = !stopped;
  const status = finalizeJob(handle, resolveStatus('claude_tmux', 0, logPath, timedOut));

  return { status, exit_code: timedOut ? 124 : 0, backend: 'claude_tmux', handle, resume_token: '', repo, shortstat: shortstat(repo), log: logPath };
}
