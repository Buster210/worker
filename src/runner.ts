import { spawn, spawnSync, execSync } from 'child_process';
import { createWriteStream, statSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, realpathSync, existsSync, copyFileSync, renameSync } from 'fs';
import { updateJob, getJob, getAllRunningJobs, getAllStoppedJobs, removeLock, logPath as workerLogPath, workersDir, finalizeJob } from './state.ts';
import type { Backend } from './backends.ts';
import type { Job } from './state.ts';

// On startup: mark any jobs still showing 'running' whose PIDs are dead as failed.
// Prevents stale state after a server restart mid-job.
// Timing knobs resolve from env at call time (defaults = production behavior), so tests
// can drive fast timeout/stall paths per-case without touching production values.
function envMs(key: string, def: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
export function defaultTimeoutMs(): number { return envMs('WORKER_TIMEOUT_MS', 600_000); }
function pollIntervalMs(): number { return envMs('WORKER_POLL_MS', 5_000); }
// Resume watcher polls tighter than the main watchdog: a resumed job is already in flight, so a
// quicker exit-detection cadence (matching the pre-extraction inline loop) keeps finalization snappy.
function resumePollIntervalMs(): number { return envMs('WORKER_RESUME_POLL_MS', 1_000); }
function stallTimeoutMs(): number { return envMs('WORKER_STALL_MS', 120_000); }
// A 'stopped' (frozen) job nobody resumed is reaped past this age so it stops holding RAM.
function reapAgeMs(): number { return envMs('WORKER_REAP_MS', 900_000); }

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
    let alive = false;
    if (job.worker_pid) { alive = isProcessAlive(job.worker_pid, job.started); }
    if (!alive) {
      const status = resolveStatus(job.backend, 0, job.log_path, false);
      finalizeJob(job.handle, status === 'done' ? status : 'failed:server-restart');
    }
  }
}

/**
 * Reclaim 'stopped' (frozen) jobs nobody resumed. Two reclaim causes, both terminal and both
 * keeping their resume_token (worker_resume still re-attempts from scratch):
 *  - dead frozen pid → the server bounced and the SIGSTOP'd group is gone: finalize now.
 *  - alive but frozen past the reap window → abandoned, holding RAM at zero CPU: SIGKILL + finalize.
 * Fresh freezes (within the window, still resumable) are left untouched.
 */
export function reapStoppedJobs() {
  const now = Date.now();
  const maxAgeMs = reapAgeMs();
  for (const job of getAllStoppedJobs()) {
    // 'stopped' implies a SIGSTOP'd pid; a 0/absent pid is anomalous and unkillable —
    // process.kill(-0) would signal our OWN group — so skip it rather than act on a guess.
    if (!job.worker_pid) continue;
    if (!isProcessAlive(job.worker_pid, job.started)) {
      finalizeJob(job.handle, 'failed:server-restart');
      continue;
    }
    const stoppedAt = Date.parse(job.stopped_at ?? '');
    // Missing/unparseable stopped_at → don't assume stale and kill a live job; leave it.
    if (!Number.isFinite(stoppedAt) || now - stoppedAt < maxAgeMs) continue;
    // Re-read in the same synchronous tick: guards a status flip (e.g. a concurrent resume that
    // thawed it back to 'running') between the disk snapshot above and the kill below.
    if (getJob(job.handle)?.status !== 'stopped') continue;
    killGroup(job.worker_pid, 'SIGKILL');
    setTimeout(() => killGroup(job.worker_pid, 'SIGKILL'), 5_000).unref?.();
    finalizeJob(job.handle, 'timeout');
  }
}

function killGroup(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' = 'SIGTERM') {
  try { process.kill(-pid, sig); } catch {}
}

/**
 * After SIGSTOP, decide a suspended (deadline- or stall-hit) job's fate. The watch loop only
 * suspends a process it just saw alive, so default to FREEZING it as 'stopped' — recoverable via
 * SIGCONT, no work discarded on a guess (we can't tell "slow but working" from "hung" by log/git,
 * and for the sole worker a false kill is the expensive failure). The lone terminal case is a
 * self-declared failure: a FAILED last log line → SIGKILL so resume re-attempts fresh from the
 * token rather than thawing a corpse. Caller must have already SIGSTOP'd the group.
 */
function evalAfterStop(handle: string, pid: number, logPath: string): boolean {
  let lastLine = '';
  let isFailed = false;
  try {
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    lastLine = lines[lines.length - 1] ?? '';
    isFailed = /^FAILED(:|$|\s)/.test(lastLine);
  } catch {}

  if (!isFailed) {
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

// ps `etime` = elapsed time since start, format [[dd-]hh:]mm:ss → seconds.
// Elapsed (not wall-clock lstart) is timezone-independent: parsing lstart with `new Date()`
// silently misreads the system-local string whenever the runtime TZ differs (e.g. TZ=UTC),
// skewing the start by the offset and breaking the PID-reuse guard for every live process.
export function parseEtimeSeconds(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return Number(dd ?? 0) * 86400 + Number(hh ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
}

function getProcessStartTime(pid: number): string | null {
  try {
    const result = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    const elapsedSec = parseEtimeSeconds(result.stdout);
    if (elapsedSec === null) return null;
    return new Date(Date.now() - elapsedSec * 1000).toISOString();
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
 * Composite activity signature, log-first. The log's mtime+size is the cheap primary signal:
 * if it advanced since the last tick the worker is demonstrably alive, so we skip the two git
 * probes entirely (the common case — backends stream to the log while working). Only when the
 * log is idle do we pay for `git diff`/`status`, which still catch a worker mutating files
 * without logging. Caller threads `lastLog` (the prior tick's log component) and stores the
 * returned `log` for the next call.
 */
export function activitySig(repo: string, logPath: string, lastLog: string): { sig: string; log: string } {
  let log = '';
  try { const st = statSync(logPath); log = `${st.mtimeMs}:${st.size}`; } catch {}
  if (log && log !== lastLog) return { sig: log, log };
  let gitDiff = '';
  try { gitDiff = spawnSync('git', ['-C', repo, 'diff', '--stat'], { encoding: 'utf8', timeout: 2000 }).stdout ?? ''; } catch {}
  let gitStatus = '';
  try { gitStatus = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', timeout: 2000 }).stdout ?? ''; } catch {}
  return { sig: log + gitDiff + gitStatus, log };
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
    let lastLog = '';
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
      const { sig, log } = activitySig(repo, logPath, lastLog);
      lastLog = log;
      if (sig !== lastSig) { lastSig = sig; lastSigChange = Date.now(); }
      else if (Date.now() - lastSigChange >= stallTimeoutMs()) {
        killGroup(proc.pid!, 'SIGSTOP');
        setTimeout(() => {
          if (settled) return;
          stopped = evalAfterStop(handle, proc.pid!, logPath);
          finish(124, true, stopped);
        }, 100);
        return;
      }
    }, pollIntervalMs());

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

/**
 * Watch an already-running process we hold no child handle for (a SIGCONT'd resume), polling to
 * completion. No spawn — the process exists; we only observe PID liveness against a re-armed
 * deadline and a stall timer. Mirrors launchAndWait's watchdog: exited-on-its-own → finalize from
 * log; deadline fired OR activity stalled (activitySig unchanged for stallTimeoutMs) → suspendAndEval
 * (freeze to 'stopped' if still productive, else SIGKILL + terminal).
 * started/resume_token come from the persisted job (set at insert, immutable for its lifetime).
 */
export function watchExisting(
  handle: string,
  pid: number,
  repo: string,
  logPath: string,
  backend: Backend,
  deadlineMs: number,
): Promise<RunResult> {
  const job = getJob(handle);
  const started = job?.started;
  const resumeToken = job?.resume_token ?? '';
  const watchStart = Date.now();
  let lastSig = '';
  let lastLog = '';
  let lastSigChange = watchStart;

  return new Promise((resolve) => {
    const mkResult = (status: string): RunResult => ({
      status, exit_code: 0, backend, handle,
      resume_token: resumeToken, repo, shortstat: '', log: logPath,
    });
    // Deadline or stall → suspend, then freeze ('stopped') if still productive or kill (terminal).
    const suspend = () => {
      if (suspendAndEval(handle, pid, logPath)) {
        resolve(mkResult('stopped')); // suspendAndEval persisted 'stopped' + removed the lock
      } else {
        resolve(mkResult(finalizeJob(handle, resolveStatus(backend, 124, logPath, true))));
      }
    };
    const check = () => {
      // Process exited on its own → finalize from log.
      if (!isProcessAlive(pid, started)) {
        resolve(mkResult(finalizeJob(handle, resolveStatus(backend, 0, logPath, false))));
        return;
      }
      // Re-armed deadline fired.
      if (Date.now() - watchStart >= deadlineMs) { suspend(); return; }
      // Activity stalled (no new log/diff for stallTimeoutMs) → treat like a fresh run's stall.
      const { sig, log } = activitySig(repo, logPath, lastLog);
      lastLog = log;
      if (sig !== lastSig) { lastSig = sig; lastSigChange = Date.now(); }
      else if (Date.now() - lastSigChange >= stallTimeoutMs()) { suspend(); return; }
      setTimeout(check, resumePollIntervalMs());
    };
    check();
  });
}

type TrustEntry = {
  hasTrustDialogAccepted?: boolean;
  hasCompletedProjectOnboarding?: boolean;
  projectOnboardingSeenCount?: number;
  [k: string]: unknown;
};
type ClaudeConfig = { projects?: Record<string, TrustEntry>; [k: string]: unknown };

const CLAUDE_CFG = `${process.env.HOME}/.claude.json`;
const CLAUDE_CFG_BAK = `${CLAUDE_CFG}.worker-bak`;

// Interactive claude (no -p) blocks on the workspace trust dialog in a fresh/untrusted repo,
// hanging the unattended TUI. No CLI flag bypasses it (trust is gated before settings are read,
// hardened by CVE-2026-33068), so we pre-seed the trust state in ~/.claude.json. Claude keys
// trust off the *canonical* cwd (/var -> /private/var on macOS), so seed both raw + realpath.
// We deliberately never restore afterward: the trust flag is benign/idempotent, while
// ~/.claude.json is a large file other claude processes write concurrently — a teardown restore
// would clobber their writes. One-time backup + atomic write keep the mutation safe; flag stays set.
function seedRepoTrust(repo: string): void {
  let cfg: ClaudeConfig;
  try { cfg = JSON.parse(readFileSync(CLAUDE_CFG, 'utf8')); }
  catch { return; } // missing/corrupt config → skip seeding, never crash the run

  const projects = cfg.projects ?? (cfg.projects = {});
  let real = repo;
  try { real = realpathSync(repo); } catch {}
  const keys = [...new Set([repo, real])];

  if (keys.every(k => projects[k]?.hasTrustDialogAccepted === true)) return;

  if (!existsSync(CLAUDE_CFG_BAK)) {
    try { copyFileSync(CLAUDE_CFG, CLAUDE_CFG_BAK); } catch {}
  }

  for (const key of keys) {
    projects[key] = {
      ...projects[key],
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: projects[key]?.projectOnboardingSeenCount ?? 1,
    };
  }

  const tmp = `${CLAUDE_CFG}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    renameSync(tmp, CLAUDE_CFG);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

export async function runClaudeTmux(
  spec: string,
  repo: string,
  handle: string,
  sid: string,
  timeoutMs: number = defaultTimeoutMs(),
): Promise<RunResult> {
  try { execSync('which tmux', { stdio: 'ignore' }); }
  catch { throw new Error('claude_tmux backend requires tmux'); }

  const wdir = `${workersDir()}/tmux`;
  mkdirSync(wdir, { recursive: true });

  const setf    = `${wdir}/${sid}.settings.json`;
  const donef   = `${wdir}/${sid}.done`;
  const specf   = `${wdir}/${sid}.spec`;
  const launchf = `${wdir}/${sid}.launch.sh`;
  const logPath = workerLogPath(handle);

  seedRepoTrust(repo);

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
    const pane = execSync(`tmux capture-pane -t ${sid} -p -S -5000 2>/dev/null`, { encoding: 'utf8', env: workerEnv });
    writeFileSync(logPath, pane);
  } catch {}

  try { execSync(`tmux kill-session -t ${sid} 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  for (const f of [setf, specf, launchf, donef]) { try { unlinkSync(f); } catch {} }

  const timedOut = !stopped;
  const status = finalizeJob(handle, resolveStatus('claude_tmux', 0, logPath, timedOut));

  return { status, exit_code: timedOut ? 124 : 0, backend: 'claude_tmux', handle, resume_token: '', repo, shortstat: shortstat(repo), log: logPath };
}
