import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, openSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Point the state store at a throwaway dir BEFORE any state/runner fn runs. Safe because
// state.ts resolves WORKER_STATE_DIR lazily (no eager import-time mkdir).
const STATE_DIR = join(tmpdir(), `wrunner-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
// Hermetic: empty WORKER_RC so the backend shell sources no host rc (fakeScripts need no env/keys).
process.env.WORKER_RC = '';

import { runWorker, watchExisting, isProcessAlive, parseEtimeSeconds, activitySig, reapStoppedJobs } from './runner.ts';
import { insertJob, getJob, updateJob, logPath as stateLogPath } from './state.ts';

// Real subprocess fakes: a short bash script we spawn for real, so the tests exercise
// genuine signal/timing/process-control — not mocks. argv[0] is the command the non-interactive
// shell wrapper invokes ($0); ['bash', path] runs `bash <path>`.
const REPO = mkdtempSync(join(tmpdir(), 'wrunner-repo-'));
const tmpFiles: string[] = [];
const frozenPids: number[] = [];
const tmpDirs: string[] = [];
let seq = 0;

function fakeScript(body: string): string[] {
  const path = join(tmpdir(), `wfake-${process.pid}-${seq++}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  tmpFiles.push(path);
  return ['bash', path];
}

function seedJob(handle: string): string {
  const lp = stateLogPath(handle, REPO);
  insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: lp });
  return lp;
}

// Spawn a real detached process group writing to the log, mimicking a worker that
// watchExisting re-attaches to (it spawns nothing itself — only observes a live pid).
function spawnDetached(body: string, lp: string): number {
  const [cmd, path] = fakeScript(body);
  const fd = openSync(lp, 'a');
  const proc = spawn(cmd, [path], { detached: true, stdio: ['ignore', fd, fd] });
  proc.unref();
  return proc.pid!;
}

afterEach(() => {
  for (const k of ['WORKER_POLL_MS', 'WORKER_RESUME_POLL_MS', 'WORKER_STALL_MS', 'WORKER_TIMEOUT_MS', 'WORKER_REAP_MS']) {
    delete process.env[k];
  }
});

afterAll(() => {
  for (const pid of frozenPids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  for (const f of tmpFiles) { try { rmSync(f, { force: true }); } catch {} }
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  try { rmSync(REPO, { recursive: true, force: true }); } catch {}
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
});

describe('runWorker lifecycle (real subprocess)', () => {
  // The leading blank `echo` guarantees the sentinel lands on its own clean line (separated from any
  // shell preamble), so resolveStatus's log scan matches it directly (not the rc fallback).
  it('resolves "done" when the worker prints DONE and exits 0', async () => {
    const handle = `done-${seq}`;
    const lp = seedJob(handle);
    const r = await runWorker(fakeScript('echo; echo DONE'), REPO, handle, 'cmd', lp, '');
    expect(r.status).toBe('done');
    expect(getJob(handle)?.status).toBe('done');
  });

  it('resolves "failed" when the worker prints FAILED and exits nonzero', async () => {
    const handle = `failed-${seq}`;
    const lp = seedJob(handle);
    const r = await runWorker(fakeScript('echo; echo FAILED\nexit 1'), REPO, handle, 'cmd', lp, '');
    expect(r.status).toBe('failed');
  });

  it('resolves "failed:<reason>" when the worker prints FAILED: reason', async () => {
    const handle = `failedreason-${seq}`;
    const lp = seedJob(handle);
    const r = await runWorker(fakeScript('echo; echo "FAILED: boom"\nexit 1'), REPO, handle, 'cmd', lp, '');
    expect(r.status).toBe('failed:boom');
  });

  it('freezes a quiet but alive worker to "stopped" when it blows the deadline (no false kill)', async () => {
    const handle = `dl-quiet-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = '100';
    // Silent + alive + not self-failed → frozen for recovery, not killed (the B-wide contract).
    const r = await runWorker(fakeScript('sleep 20'), REPO, handle, 'cmd', lp, '', 800);
    expect(r.status).toBe('stopped');
    expect(getJob(handle)?.status).toBe('stopped');
    const pid = getJob(handle)?.worker_pid;
    if (pid) frozenPids.push(pid);
  });

  it('kills a self-failed worker that lingers past the deadline to "timeout"', async () => {
    const handle = `dl-failed-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = '100';
    // Declared FAILED but still alive at the deadline → terminal SIGKILL, not a frozen corpse.
    const r = await runWorker(fakeScript('echo; echo FAILED; sleep 20'), REPO, handle, 'cmd', lp, '', 800);
    expect(r.status).toBe('timeout');
    expect(r.exit_code).toBe(124);
  });

  it('resolves "stopped" (frozen, resumable) when a productive worker blows the deadline', async () => {
    const handle = `stopped-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = '100';
    const r = await runWorker(fakeScript('while true; do echo working; sleep 0.1; done'), REPO, handle, 'cmd', lp, '', 800);
    expect(r.status).toBe('stopped');
    expect(getJob(handle)?.status).toBe('stopped');
    const pid = getJob(handle)?.worker_pid;
    if (pid) frozenPids.push(pid); // frozen by SIGSTOP — afterAll reaps it
  });

  it('resolves "killed" when kill_requested is set and the worker ends non-done (kill precedence)', async () => {
    const handle = `killed-${seq}`;
    const lp = seedJob(handle);
    updateJob(handle, { kill_requested: true });
    const r = await runWorker(fakeScript('echo FAILED\nexit 1'), REPO, handle, 'cmd', lp, '');
    expect(r.status).toBe('killed');
    expect(getJob(handle)?.status).toBe('killed');
  });
});

describe('watchExisting (resume watcher, real process)', () => {
  it('finalizes from the log when the re-attached process exits on its own', async () => {
    const handle = `we-done-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_RESUME_POLL_MS = '50';
    const pid = spawnDetached('echo; echo DONE', lp);
    updateJob(handle, { worker_pid: pid });
    await Bun.sleep(150); // resume attaches to an already-running process, not a just-spawned pid
    const r = await watchExisting(handle, pid, REPO, lp, 'cmd', 10_000);
    expect(r.status).toBe('done');
    expect(getJob(handle)?.status).toBe('done');
  });

  it('freezes to "stopped" when the re-armed deadline fires on a still-productive process', async () => {
    const handle = `we-stopped-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_RESUME_POLL_MS = '50';
    const pid = spawnDetached('while true; do echo working; sleep 0.1; done', lp);
    updateJob(handle, { worker_pid: pid });
    await Bun.sleep(150); // let the process come up so the watcher attaches to a live pid (as on real resume)
    const r = await watchExisting(handle, pid, REPO, lp, 'cmd', 400);
    expect(r.status).toBe('stopped');
    expect(getJob(handle)?.status).toBe('stopped');
    frozenPids.push(pid); // SIGSTOP'd by suspendAndEval — afterAll reaps it
  });

  it('freezes a stalled but alive worker to "stopped", regardless of log staleness', async () => {
    // Under B-wide a stall no longer kills: the process is alive and never self-failed, so a stale
    // log (it emitted once, then went silent past the stall window) freezes for recovery, not death.
    const handle = `we-stall-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_RESUME_POLL_MS = '50';
    process.env.WORKER_STALL_MS = '200'; // stall trips after 200ms of an unchanged activity sig
    const pid = spawnDetached('echo working; sleep 100', lp); // emits once, then goes silent
    updateJob(handle, { worker_pid: pid });
    await Bun.sleep(150);
    // Deadline is far off (10s) so the stall timer, not the deadline, is what ends the watch.
    const r = await watchExisting(handle, pid, REPO, lp, 'cmd', 10_000);
    expect(r.status).toBe('stopped');
    expect(getJob(handle)?.status).toBe('stopped');
    frozenPids.push(pid);
  });

  it('captures post-resume output across a real freeze→SIGCONT handoff (regression: closed log stream)', async () => {
    // End-to-end: a job launched by runWorker, frozen mid-run, then thawed and watched by
    // watchExisting on the SAME process. 'working' is logged before the freeze; 'DONE' is emitted
    // only AFTER SIGCONT. If launchAndWait piped stdout through a stream it .end()'d at freeze, the
    // post-resume 'DONE' would vanish and the job would mis-grade non-done. The inherited-fd log
    // keeps the frozen child's output flowing to the same file across the handoff.
    const handle = `resume-handoff-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = '100';
    process.env.WORKER_RESUME_POLL_MS = '50';
    const r1 = await runWorker(fakeScript('echo working; sleep 1; echo; echo DONE'), REPO, handle, 'cmd', lp, '', 300);
    expect(r1.status).toBe('stopped');
    const pid = getJob(handle)!.worker_pid!;
    frozenPids.push(pid); // defensive: it should exit on its own below, but reap if it flakes
    process.kill(-pid, 'SIGCONT'); // mirror resumeLaunch: thaw the group, then hand to the watcher
    const r2 = await watchExisting(handle, pid, REPO, lp, 'cmd', 10_000);
    expect(r2.status).toBe('done');
    expect(getJob(handle)?.status).toBe('done');
    expect(readFileSync(lp, 'utf8')).toContain('DONE'); // post-resume output reached the log
  });

  it('kills a stalled job to "timeout" only when it has self-declared FAILED', async () => {
    // The lone terminal stall case: the worker printed FAILED then hung. Alive but self-failed →
    // SIGKILL + terminal, so resume re-attempts fresh rather than thawing a corpse.
    const handle = `we-stall-failed-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_RESUME_POLL_MS = '50';
    process.env.WORKER_STALL_MS = '200';
    const pid = spawnDetached('echo; echo FAILED; sleep 100', lp);
    updateJob(handle, { worker_pid: pid });
    await Bun.sleep(150);
    const r = await watchExisting(handle, pid, REPO, lp, 'cmd', 10_000);
    expect(r.status).toBe('timeout');
    expect(getJob(handle)?.status).toBe('timeout');
    frozenPids.push(pid); // SIGKILLed by evalAfterStop; reap defensively
  });
});

// Use process.pid (this test runner — guaranteed alive) rather than a freshly spawned child,
// so there is no spawn/ps startup race to flake on. Derive the start from etime (elapsed) to
// match getProcessStartTime — a lstart wall-clock parse would be TZ-skewed under `bun test` (UTC).
function realStart(pid: number): string {
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' });
  return new Date(Date.now() - (parseEtimeSeconds(r.stdout) ?? 0) * 1000).toISOString();
}

describe('isProcessAlive PID-reuse guard', () => {
  it('returns true for a live pid and false for a dead pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const dead = spawnSync('true');
    expect(isProcessAlive(dead.pid ?? 999999)).toBe(false);
  });

  it('accepts a matching start and rejects one that skews from the real process start (reuse defense)', () => {
    // Recorded start matches the real process start → accepted.
    expect(isProcessAlive(process.pid, realStart(process.pid))).toBe(true);
    // Recorded start 10 min off the real start → treated as a recycled pid → rejected.
    const skewed = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect(isProcessAlive(process.pid, skewed)).toBe(false);
  });
});

describe('parseEtimeSeconds', () => {
  it('parses every ps etime shape and rejects junk', () => {
    expect(parseEtimeSeconds('00:01')).toBe(1);          // mm:ss
    expect(parseEtimeSeconds('05:23')).toBe(323);
    expect(parseEtimeSeconds('01:05:23')).toBe(3923);    // hh:mm:ss
    expect(parseEtimeSeconds('2-01:05:23')).toBe(176723); // dd-hh:mm:ss
    expect(parseEtimeSeconds('  03:04  ')).toBe(184);    // surrounding whitespace from `ps -o etime=`
    expect(parseEtimeSeconds('garbage')).toBeNull();
    expect(parseEtimeSeconds('')).toBeNull();
  });
});

describe('reapStoppedJobs (stale frozen-job reaper)', () => {
  // Isolated state dir: reapStoppedJobs scans the WHOLE store, so without this the reaper would
  // also reclaim frozen leftovers from earlier tests — making these cases order/timing dependent.
  const REAP_DIR = join(tmpdir(), `wrunner-reap-${process.pid}`);
  let prevStateDir: string;
  beforeAll(() => { prevStateDir = process.env.WORKER_STATE_DIR!; process.env.WORKER_STATE_DIR = REAP_DIR; });
  afterAll(() => {
    process.env.WORKER_STATE_DIR = prevStateDir;
    try { rmSync(REAP_DIR, { recursive: true, force: true }); } catch {}
  });

  it('kills an alive frozen job past the reap window and finalizes it "timeout"', async () => {
    const handle = `reap-old-${seq}`;
    const lp = seedJob(handle);
    const pid = spawnDetached('sleep 100', lp);
    // Frozen long ago (stopped_at well past the 100ms window below), still alive → reclaim.
    updateJob(handle, { status: 'stopped', worker_pid: pid, stopped_at: '2020-01-01T00:00:00.000Z' });
    process.env.WORKER_REAP_MS = '100';
    reapStoppedJobs();
    expect(getJob(handle)?.status).toBe('timeout');
    await Bun.sleep(100);
    expect(isProcessAlive(pid)).toBe(false); // SIGKILLed by the reaper
    frozenPids.push(pid);
  });

  it('leaves a freshly frozen job (within the window) untouched', () => {
    const handle = `reap-fresh-${seq}`;
    const lp = seedJob(handle);
    const pid = spawnDetached('sleep 100', lp);
    updateJob(handle, { status: 'stopped', worker_pid: pid, stopped_at: new Date().toISOString() });
    // Default 15-min window → a seconds-old freeze is nowhere near stale.
    reapStoppedJobs();
    expect(getJob(handle)?.status).toBe('stopped');
    expect(isProcessAlive(pid)).toBe(true);
    frozenPids.push(pid);
  });

  it('finalizes a frozen job whose pid is already dead as "failed:server-restart"', () => {
    const handle = `reap-dead-${seq}`;
    seedJob(handle);
    const dead = spawnSync('true'); // exits immediately → pid is dead by the time we reap
    updateJob(handle, { status: 'stopped', worker_pid: dead.pid ?? 999999, stopped_at: new Date().toISOString() });
    reapStoppedJobs();
    expect(getJob(handle)?.status).toBe('failed:server-restart');
  });
});

describe('activitySig log-first probing (#6b)', () => {
  it('skips git while the log grows, falls back to git only when the log is idle', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wrunner-git-'));
    tmpDirs.push(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n'); // makes `git status --porcelain` non-empty
    const lp = join(repo, 'run.log');
    writeFileSync(lp, 'one\n');

    // Log advanced vs lastLog → activity proven by the log alone; sig is exactly the log
    // component, i.e. git was NOT consulted (else the dirty file would show up in sig).
    const grew = activitySig(repo, lp, '');
    expect(grew.sig).toBe(grew.log);
    expect(grew.sig).not.toContain('dirty.txt');

    // Log idle (lastLog === current) → fall back to git, which surfaces the dirty file.
    const idle = activitySig(repo, lp, grew.log);
    expect(idle.sig).toContain('dirty.txt');
    expect(idle.sig).not.toBe(idle.log);
  });
});
