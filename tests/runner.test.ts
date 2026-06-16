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

import { runWorker, type RunResult } from '../src/runner.ts';
import { reapStoppedJobs } from '../src/maintenance.ts';
import { isProcessAlive, parseEtimeSeconds } from '../src/process.ts';
import { activitySig } from '../src/monitor.ts';
import { insertJob, getJob, updateJob, logPath as stateLogPath } from '../src/state.ts';

// Real subprocess fakes: a short bash script we spawn for real, so the tests exercise
// genuine signal/timing/process-control — not mocks. argv[0] is the command the non-interactive
// shell wrapper invokes ($0); ['bash', path] runs `bash <path>`.
const REPO = mkdtempSync(join(tmpdir(), 'wrunner-repo-'));
spawnSync('git', ['-C', REPO, 'init', '-q'], { encoding: 'utf8' });
spawnSync('git', ['-C', REPO, 'config', 'user.email', 'test@test.com'], { encoding: 'utf8' });
spawnSync('git', ['-C', REPO, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
writeFileSync(join(REPO, 'README.md'), 'init\n');
spawnSync('git', ['-C', REPO, 'add', '.'], { encoding: 'utf8' });
spawnSync('git', ['-C', REPO, 'commit', '-m', 'init', '--no-gpg-sign'], { encoding: 'utf8' });
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
  for (const k of ['WORKER_POLL_MS', 'WORKER_WATCHDOG_MS', 'WORKER_RESUME_POLL_MS', 'WORKER_STALL_MS', 'WORKER_TIMEOUT_MS', 'WORKER_REAP_MS', 'WORKER_GRACE_MS', 'WORKER_REAPER_MS']) {
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
    const r = await runWorker(fakeScript(`echo work > ${handle}.out; echo; echo DONE`), REPO, handle, 'cmd', lp, '');
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

  it('kills a quiet idle worker to "stalled" when it stalls (SIGKILL, not frozen)', async () => {
    const handle = `stall-quiet-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_WATCHDOG_MS = '50';
    process.env.WORKER_STALL_MS = '200';
    // Silent + alive + not self-failed, idle past the stall window → terminal SIGKILL + 'stalled'
    // (no freeze, no leaked suspended corpse). Deadline far off so the stall, not deadline+grace, ends it.
    const started = Date.now();
    const r = await runWorker(fakeScript('sleep 20'), REPO, handle, 'cmd', lp, '', 60_000);
    const elapsed = Date.now() - started;
    expect(r.status).toBe('stalled');
    expect(elapsed).toBeLessThan(1500);
    const job = getJob(handle);
    expect(job?.status).toBe('stalled');
    expect(job?.finished).toBeTruthy();              // finalized as terminal
    const pid = job?.worker_pid;
    if (pid) {
      await Bun.sleep(100);
      expect(isProcessAlive(pid)).toBe(false);       // SIGKILLed, not suspended
      frozenPids.push(pid);                           // defensive reap
    }
  });

  it('kills a self-failed worker that stalls to "failed" (SIGKILL, not frozen)', async () => {
    const handle = `stall-failed-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_STALL_MS = '200';
    // Declared FAILED but still alive and idle → terminal SIGKILL, resolves its self-declared failure.
    const r = await runWorker(fakeScript('echo; echo FAILED; sleep 20'), REPO, handle, 'cmd', lp, '', 60_000);
    expect(r.status).toBe('failed');
    expect(r.exit_code).toBe(124);
  });

  it('kills a productive worker at deadline+grace when nobody extends → "timeout"', async () => {
    const handle = `grace-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_GRACE_MS = '150';
    // Productive (never stalls), but the deadline passes and no worker_extend lands within the
    // grace window → hard terminal kill, no freeze, no resume.
    const r = await runWorker(fakeScript('while true; do echo working; sleep 0.1; done'), REPO, handle, 'cmd', lp, '', 200);
    expect(r.status).toBe('timeout');
    expect(r.exit_code).toBe(124);
    expect(getJob(handle)?.status).toBe('timeout');
  });

  it('does NOT kill when the deadline is pushed out (worker_extend) before grace expires', async () => {
    const handle = `extend-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_GRACE_MS = '150';
    // deadline 100 + grace 150 = kill at ~250ms, but at 120ms we bump deadline_at far out
    // (what worker_extend does) and the watchdog reads it fresh → the worker runs to "done".
    setTimeout(() => updateJob(handle, { deadline_at: Date.now() + 60_000 }), 120).unref?.();
    const r = await runWorker(fakeScript(`for i in 1 2 3; do echo working $i; sleep 0.1; done; echo work > ${handle}.out; echo; echo DONE`), REPO, handle, 'cmd', lp, '', 100);
    expect(r.status).toBe('done');
  });

  it('resolves "killed" when kill_requested is set and the worker ends non-done (kill precedence)', async () => {
    const handle = `killed-${seq}`;
    const lp = seedJob(handle);
    updateJob(handle, { kill_requested: true });
    const r = await runWorker(fakeScript('echo FAILED\nexit 1'), REPO, handle, 'cmd', lp, '');
    expect(r.status).toBe('killed');
    expect(getJob(handle)?.status).toBe('killed');
  });

  it('resolves "failed" when the spawn errors before the process starts', async () => {
    // Spawn error (e.g., ENOENT for missing command) still resolves via the error handler
    const handle = `spawn-err-${seq}`;
    const lp = seedJob(handle);
    // Fake script with a non-existent command - spawn will fail
    const nonExistentDir = join(tmpdir(), `nonexistent-${process.pid}`);
    const badScriptPath = join(nonExistentDir, 'fake.cmd');
    try { rmSync(nonExistentDir, { recursive: true, force: true }); } catch {}
    // No script written - running it will error at spawn time
    const r = await runWorker(['bash', badScriptPath], REPO, handle, 'cmd', lp, '');
    expect(r.status).toBe('failed');
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
