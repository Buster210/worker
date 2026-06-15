import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { writeFileSync, readFileSync, rmSync, mkdirSync, mkdtempSync, openSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Hermetic state: set BEFORE importing state/lifecycle (lazy resolution) ──
const STATE_DIR = join(tmpdir(), `wcontract-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
const PLANS_DIR = join(tmpdir(), `wcontract-plans-${process.pid}`);
process.env.WORKER_PLANS_DIR = PLANS_DIR;
// Use bash for shell wrappers — zsh caches command lookups which prevents stub binaries
// from being found when a real binary with the same name exists earlier on PATH.
process.env.SHELL = '/bin/bash';
process.env.WORKER_RC = '';
process.env.WORKER_LOGIN_SHELL = '0';
import { insertJob, updateJob, getJob, getJobFresh, finalizeJob, logPath as stateLogPath } from '../src/state.ts';
import { handleKill, handleStatus, handleResume, handleRun } from '../src/server.ts';
import { isProcessAlive, listDescendants } from '../src/process.ts';
import { workerEnv } from '../src/env.ts';

// ── Shared state ──
const REPO = mkdtempSync(join(tmpdir(), 'wcontract-repo-'));
spawnSync('git', ['init', '-q'], { cwd: REPO });
// Initial commit so HEAD exists — required by `git worktree add` (G5+)
spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: REPO });
spawnSync('git', ['config', 'user.name', 'Test'], { cwd: REPO });
writeFileSync(join(REPO, '.gitkeep'), '');
spawnSync('git', ['add', '.'], { cwd: REPO });
spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: REPO });
const tmpFiles: string[] = [];
const frozenPids: number[] = [];
const tmpDirs: string[] = [REPO];
let seq = 0;
// ── Plans dir: write spec files here; WORKER_PLANS_DIR points here ──
mkdirSync(PLANS_DIR, { recursive: true });
tmpDirs.push(PLANS_DIR);
// Helper: write a spec file and return its bare filename
function writeSpec(name: string, body: string): string {
  writeFileSync(join(PLANS_DIR, name), body);
  return name;
}
// ── PATH stub: modify workerEnv after imports so the stub binary is findable ──
const STUB_DIR = mkdtempSync(join(tmpdir(), 'wcontract-stub-'));
tmpDirs.push(STUB_DIR);
workerEnv().PATH = `${STUB_DIR}:${workerEnv().PATH}`;
// workerEnv() is a memoized object; mutate directly so the shell wrapper
// doesn't source the host's .common rc file.
workerEnv().WORKER_RC = '';

// ── Poll helper: assert state reaches expectation within a generous ceiling ──
// Uses real wall-clock because we exercise real subprocesses — fake timers cannot drive them.
async function waitFor(pred: () => boolean, ceilingMs = 5_000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ceilingMs) {
    if (pred()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error(`waitFor timed out after ${ceilingMs}ms`);
}

// ── Helpers: mirror runner.test.ts conventions ──
function fakeScript(body: string): string[] {
  const path = join(tmpdir(), `wcontract-${process.pid}-${seq++}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  tmpFiles.push(path);
  return ['bash', path];
}

function seedJob(handle: string): string {
  const lp = stateLogPath(handle, REPO);
  insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: lp });
  return lp;
}

function spawnDetached(body: string, lp: string): number {
  const [cmd, path] = fakeScript(body);
  const fd = openSync(lp, 'a');
  const proc = spawn(cmd, [path], { detached: true, stdio: ['ignore', fd, fd] });
  proc.unref();
  return proc.pid!;
}

// ── Speed knobs per test ──
afterEach(() => {
  for (const k of ['WORKER_POLL_MS', 'WORKER_RESUME_POLL_MS', 'WORKER_STALL_MS', 'WORKER_TIMEOUT_MS', 'WORKER_REAP_MS', 'WORKER_PLANS_DIR']) {
    delete process.env[k];
  }
  // Restore plans dir for subsequent tests (deleted by the loop above)
  process.env.WORKER_PLANS_DIR = PLANS_DIR;
});

afterAll(() => {
  for (const pid of frozenPids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  for (const f of tmpFiles) { try { rmSync(f, { force: true }); } catch {} }
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
});

function makeStub(name: string, body: string) {
  const p = join(STUB_DIR, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section A — Hermetic (no binary)
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleKill — hermetic', () => {
  it('kills a running job: process dies, result contains handle', async () => {
    const handle = `hk-live-${seq++}`;
    const lp = seedJob(handle);
    const pid = spawnDetached('sleep 100', lp);
    updateJob(handle, { worker_pid: pid, status: 'running' });
    await waitFor(() => isProcessAlive(pid));

    const result = handleKill({ handle });
    expect(result).toContain('killed');
    expect(result).toContain(handle);

    // Process group dies from SIGTERM
    await waitFor(() => !isProcessAlive(pid));
    expect(isProcessAlive(pid)).toBe(false);
    // handleKill for a live running job may or may not finalize depending on SIGTERM timing;
    // the guaranteed contract is: result says "killed" and the process is dead.
  });

  it('kills all descendants (no orphans) for a forking job', async () => {
    const handle = `hk-orphan-${seq++}`;
    const lp = seedJob(handle);
    const pid = spawnDetached('sleep 100 & sleep 100 & wait', lp);
    updateJob(handle, { worker_pid: pid, status: 'running' });
    await waitFor(() => listDescendants(pid).length >= 2);

    const descendants = listDescendants(pid);
    expect(descendants.length).toBeGreaterThanOrEqual(2);

    handleKill({ handle });

    await waitFor(() => !isProcessAlive(pid));
    expect(isProcessAlive(pid)).toBe(false);
    for (const child of descendants) {
      await waitFor(() => !isProcessAlive(child));
      expect(isProcessAlive(child)).toBe(false);
    }
  });

  it('force-kills a stopped job with an alive frozen pid', async () => {
    const handle = `hk-stopped-${seq++}`;
    const lp = seedJob(handle);
    const pid = spawnDetached('sleep 100', lp);
    await waitFor(() => isProcessAlive(pid));
    try { process.kill(pid, 'SIGSTOP'); } catch {}
    updateJob(handle, { worker_pid: pid, status: 'stopped', stopped_at: new Date().toISOString() });

    const result = handleKill({ handle });
    expect(result).toContain('killed');
    expect(result).toContain(handle);

    await waitFor(() => !isProcessAlive(pid));
    // forceKillJob + finalizeJob: with empty log and rc=0, resolveStatus returns 'done',
    // and finalizeJob treats naturalStatus 'done' as terminal — status becomes 'done'.
    expect(getJob(handle)?.status).toBe('done');
    frozenPids.push(pid);
  });

  it('returns "already <status>" for a terminal job without touching it', () => {
    const handle = `hk-done-${seq++}`;
    seedJob(handle);
    updateJob(handle, { status: 'done' });
    expect(handleKill({ handle })).toBe('already done');

    const handle2 = `hk-failed-${seq++}`;
    seedJob(handle2);
    updateJob(handle2, { status: 'failed' });
    expect(handleKill({ handle: handle2 })).toBe('already failed');

    const handle3 = `hk-timeout-${seq++}`;
    seedJob(handle3);
    updateJob(handle3, { status: 'timeout' });
    expect(handleKill({ handle: handle3 })).toBe('already timeout');
  });

  it('finalizes a running job whose pid is already dead (dead-pid finalizeJob path)', () => {
    const handle = `hk-deadpid-${seq++}`;
    seedJob(handle);
    updateJob(handle, { status: 'running' });
    // Write FAILED to log so resolveStatus returns 'failed' (not 'done' from rc=0);
    // with kill_requested set, finalizeJob resolves to 'killed'.
    writeFileSync(stateLogPath(handle, REPO), 'FAILED\n');

    const result = handleKill({ handle });
    expect(result).toContain('killed');
    expect(result).toContain(handle);
    expect(result).toContain('(killed)'); // kill_requested beats 'failed' in finalizeJob
    expect(getJob(handle)?.status).toBe('killed');
  });
});

describe('handleStatus — hermetic', () => {
  it('live running job returns alive:true', async () => {
    const handle = `hs-live-${seq++}`;
    const lp = seedJob(handle);
    const pid = spawnDetached('sleep 100', lp);
    updateJob(handle, { worker_pid: pid, status: 'running' });
    await waitFor(() => isProcessAlive(pid));

    const s = handleStatus({ handle });
    expect(s.status).toBe('running');
    expect(s.alive).toBe(true);
    expect('started' in s).toBe(true);
    frozenPids.push(pid);
  });

  it('terminal job returns alive:false', () => {
    const handle = `hs-term-${seq++}`;
    seedJob(handle);
    updateJob(handle, { status: 'done' });

    const s = handleStatus({ handle });
    expect(s.status).toBe('done');
    expect(s.alive).toBe(false);
  });

  it('does not leak internal fields', () => {
    const handle = `hs-noleak-${seq++}`;
    seedJob(handle);
    updateJob(handle, { status: 'running', worker_pid: 12345, model: 'sonnet', task: 'test prompt' });

    const s = handleStatus({ handle });
    for (const k of ['handle', 'repo', 'task', 'backend', 'worker_pid', 'resume_token', 'log_path', 'kill_requested', 'sid', 'model']) {
      expect(k in s).toBe(false);
    }
  });

  it('throws for unknown handle', () => {
    expect(() => handleStatus({ handle: 'nonexistent' })).toThrow(/No job found/);
  });
});

describe('handleResume — hermetic (stopped + alive pid)', () => {
  it('thaws a frozen stopped job via SIGCONT, worker writes DONE, status becomes done', async () => {
    const handle = `hr-frozen-${seq++}`;
    const lp = seedJob(handle);
    process.env.WORKER_RESUME_POLL_MS = '50';
    process.env.WORKER_POLL_MS = '50';
    // Script emits work, sleeps briefly, then emits DONE — fast enough to finish within the timeout
    const pid = spawnDetached('echo working; sleep 1; echo; echo DONE', lp);
    updateJob(handle, { worker_pid: pid, status: 'stopped', stopped_at: new Date().toISOString(), backend: 'cmd' });
    await waitFor(() => isProcessAlive(pid));
    try { process.kill(-pid, 'SIGSTOP'); } catch {}

    // handleResume is fire-and-forget (returns {handle, status:'running'}); pass short timeout
    // so the watcher's deadline is tight and the test finishes promptly.
    const specFile = writeSpec('resume-test.md', 'resume test spec');
    const { handle: h, status } = handleResume({ handle, specFile, dir: REPO, timeout: 10 });
    expect(h).toBe(handle);
    expect(status).toBe('running');

    // Thaw the process (mirrors resumeLaunch: SIGCONT)
    try { process.kill(-pid, 'SIGCONT'); } catch {}

    // Poll until the job reaches a terminal status (not 'running' or 'stopped')
    await waitFor(() => {
      const j = getJobFresh(handle);
      return j != null && /^(done|failed|killed|timeout)/.test(j.status);
    }, 15_000);
    expect(getJobFresh(handle)?.status).toBe('done');
    // Post-resume output captured in the log
    const log = readFileSync(lp, 'utf8');
    expect(log).toContain('DONE');
  });

  it('throws for unknown handle', () => {
    const ghostSpec = writeSpec('ghost-spec.md', 'ghost spec');
    expect(() => handleResume({ handle: 'ghost', specFile: ghostSpec, dir: REPO })).toThrow(/No job found/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section A — Binary-dependent (PATH stub)
// ═══════════════════════════════════════════════════════════════════════════════

describe('handleRun — via PATH stub', () => {
  beforeAll(() => {
    makeStub('cmd', 'echo DONE; exit 0');
  });

  it('happy path: stub emits DONE, returns {handle, running}, poll → done', async () => {
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_RESUME_POLL_MS = '50';

    const specFile = writeSpec('happy-path.md', 'test spec');
    const { handle, status } = handleRun({ backend: 'cmd', specFile, dir: REPO });
    expect(status).toBe('running');
    expect(handle).toBeTruthy();

    const job = getJob(handle);
    expect(job).not.toBeNull();
    expect(job!.status).toBe('running');
    expect(job!.backend).toBe('cmd');
    expect(job!.sid).toBeTruthy(); // uuid
    expect(job!.repo).toBe(REPO);
    expect(job!.log_path).toBeTruthy();

    // Wait for the job to finalize to a terminal status
    await waitFor(() => {
      const j = getJobFresh(handle);
      return j != null && /^(done|failed|killed|timeout)/.test(j.status);
    }, 8_000);
    expect(getJobFresh(handle)?.status).toBe('done');
  });

  it('assertRepo rejects a non-git directory', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'wcontract-nongit-'));
    tmpDirs.push(nonGit);
    const specFile = writeSpec('non-git-test.md', 'test spec');
    expect(() => handleRun({ backend: 'cmd', specFile, dir: nonGit })).toThrow(/Not a git repo/);
    // No job should have been created (insertJob is after assertRepo in launch)
  });

  it('failure: stub emits FAILED + exits nonzero → poll → failed', async () => {
    makeStub('cmd', 'echo "FAILED: budget exceeded"; exit 1');
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_RESUME_POLL_MS = '50';

    const specFile = writeSpec('fail-test.md', 'fail test spec');
    const { handle, status } = handleRun({ backend: 'cmd', specFile, dir: REPO });
    expect(status).toBe('running');

    await waitFor(() => {
      const j = getJobFresh(handle);
      return j != null && /^(done|failed|killed|timeout)/.test(j.status);
    }, 8_000);
    const finalStatus = getJobFresh(handle)?.status;
    expect(finalStatus).toMatch(/^failed/);
  });

  it('parallel workers: launching B on the same repo does NOT kill A (both coexist)', async () => {
    // A: long-running (stays alive when B launches)
    makeStub('cmd', 'sleep 100');
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_RESUME_POLL_MS = '50';
    // Raise stall timeout so A is not frozen during the test
    process.env.WORKER_STALL_MS = '30000';

    const specA = writeSpec('parallel-a.md', 'parallel worker A spec');
    const a = handleRun({ backend: 'cmd', specFile: specA, dir: REPO });
    expect(a.status).toBe('running');
    // Wait for A's process to appear and be alive
    await waitFor(() => { const j = getJobFresh(a.handle); return j != null && j.worker_pid > 0 && isProcessAlive(j.worker_pid); });
    const pidA = getJobFresh(a.handle)!.worker_pid;
    expect(pidA).toBeGreaterThan(0);
    expect(isProcessAlive(pidA)).toBe(true);
    // Verify A was NOT killed before B launched
    expect(getJobFresh(a.handle)?.status).toBe('running');

    // B: completes quickly — launching B must NOT kill A
    makeStub('cmd', 'echo DONE; exit 0');
    const specB = writeSpec('parallel-b.md', 'parallel worker B spec');
    const b = handleRun({ backend: 'cmd', specFile: specB, dir: REPO });
    expect(b.status).toBe('running');

    // A must still be alive immediately after B launched — killLingeringJobs is gone
    expect(isProcessAlive(pidA)).toBe(true);
    expect(getJobFresh(a.handle)?.status).toBe('running');

    // B completes
    await waitFor(() => {
      const j = getJobFresh(b.handle);
      return j != null && /^(done|failed|killed|timeout)/.test(j.status);
    }, 8_000);
    expect(getJobFresh(b.handle)?.status).toBe('done');

    // A was never killed by B's launch — A's status never transitioned to 'killed'
    // (it may have been stopped by stall if the test took > STALL_MS, but not killed by launch)
    const aStatus = getJobFresh(a.handle)?.status;
    expect(aStatus).not.toBe('killed');

    // Each worker has its own worktree path
    expect(getJob(a.handle)?.worktree_path).toBeTruthy();
    expect(getJob(b.handle)?.worktree_path).toBeTruthy();
    expect(getJob(a.handle)?.worktree_path).not.toBe(getJob(b.handle)?.worktree_path);

    // Clean up A's process if still alive
    if (pidA > 0) frozenPids.push(pidA);
  });

  it('parallel workers: two concurrent workers each get isolated worktrees on separate branches', async () => {
    makeStub('cmd', 'echo DONE; exit 0');
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_RESUME_POLL_MS = '50';

    const specC = writeSpec('parallel-c.md', 'parallel worker C spec');
    const specD = writeSpec('parallel-d.md', 'parallel worker D spec');
    const c = handleRun({ backend: 'cmd', specFile: specC, dir: REPO });
    const d = handleRun({ backend: 'cmd', specFile: specD, dir: REPO });

    expect(c.status).toBe('running');
    expect(d.status).toBe('running');
    expect(c.handle).not.toBe(d.handle);

    const jobC = getJob(c.handle)!;
    const jobD = getJob(d.handle)!;

    // Both have distinct worktree paths
    expect(jobC.worktree_path).toBeTruthy();
    expect(jobD.worktree_path).toBeTruthy();
    expect(jobC.worktree_path).not.toBe(jobD.worktree_path);

    // Both workers complete
    await waitFor(() => {
      const jC = getJobFresh(c.handle);
      const jD = getJobFresh(d.handle);
      return jC != null && /^(done|failed|killed|timeout)/.test(jC.status)
          && jD != null && /^(done|failed|killed|timeout)/.test(jD.status);
    }, 12_000);
    expect(getJobFresh(c.handle)?.status).toBe('done');
    expect(getJobFresh(d.handle)?.status).toBe('done');
  });
});

describe('handleResume — via PATH stub (dead pid / failed retry)', () => {
  beforeAll(() => {
    makeStub('cmd', 'echo DONE; exit 0');
  });

  it('stopped job with dead pid → fresh re-run completes', async () => {
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_RESUME_POLL_MS = '50';
    makeStub('cmd', 'echo DONE; exit 0');

    const handle = `hr-deadpid-${seq++}`;
    const lp = stateLogPath(handle, REPO);
    insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: lp });
    const deadPid = spawnSync('true').pid!;
    updateJob(handle, { status: 'stopped', worker_pid: deadPid, stopped_at: new Date().toISOString() });

    const specFile = writeSpec('resume-dead.md', 'resume dead spec');
    const { handle: h, status: s1 } = handleResume({ handle, specFile, dir: REPO });
    expect(h).toBe(handle);
    expect(s1).toBe('running');

    // Wait for a terminal status — NOT "not running" (status is already 'stopped' initially)
    await waitFor(() => {
      const j = getJobFresh(handle);
      return j != null && /^(done|failed|killed|timeout)/.test(j.status);
    }, 8_000);

    const job = getJobFresh(handle);
    expect(job?.status).toBe('done');
    expect(job!.worker_pid).toBeGreaterThan(0); // new pid from fresh spawn
    expect(job!.worker_pid).not.toBe(deadPid);
  });

  it('failed job retry re-runs the worker but status stays failed (known gap)', async () => {
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_RESUME_POLL_MS = '50';
    makeStub('cmd', 'echo DONE; exit 0');

    const handle = `hr-failed-retry-${seq++}`;
    const lp = stateLogPath(handle, REPO);
    insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: lp });
    const deadPid = spawnSync('true').pid!;
    updateJob(handle, { status: 'failed', worker_pid: deadPid });

    const specFile = writeSpec('retry-failed.md', 'retry failed spec');
    const { handle: h, status: s1 } = handleResume({ handle, specFile, dir: REPO });
    expect(h).toBe(handle);
    expect(s1).toBe('running');

    // Cannot poll for "reaches terminal" — a `failed` seed is ALREADY terminal, so that predicate
    // resolves instantly without ever waiting for the retry. Prove the retry actually re-ran:
    // a fresh process is spawned (pid changes off the dead one) and the stub writes DONE.
    await waitFor(() => {
      try { return readFileSync(lp, 'utf8').includes('DONE'); } catch { return false; }
    }, 8_000);
    const job = getJobFresh(handle)!;
    expect(job.worker_pid).toBeGreaterThan(0);
    expect(job.worker_pid).not.toBe(deadPid); // fresh spawn replaced the dead pid

    // KNOWN GAP (real product bug, documented not asserted-as-correct): finalizeJob
    // (state.ts:158-160) is idempotent — once a job is terminal the first finalize wins. The
    // failed/timeout resume path (lifecycle.ts:149-158) never resets status to 'running' before
    // re-running (unlike the stopped-alive path at lifecycle.ts:140), and launchAndWait
    // (runner.ts:65-67) only sets worker_pid. So a SUCCESSFUL retry of a failed/timeout job CANNOT
    // flip failed->done — the job reports 'failed' despite the re-run completing, and a caller's
    // worker-report shows a good diff under a "failed" label. Fix = reset status to 'running' in
    // the failed/timeout resume path; when fixed, flip the assertion below to 'done'.
    expect(job.status).toBe('failed');
  });

  it('timeout job retry re-runs the worker but status stays timeout (known gap)', async () => {
    // Same bug as failed retry: a timeout job retried successfully stays timeout, not done.
    process.env.WORKER_POLL_MS = '50';
    process.env.WORKER_RESUME_POLL_MS = '50';
    makeStub('cmd', 'echo DONE; exit 0');

    const handle = `hr-timeout-retry-${seq++}`;
    const lp = stateLogPath(handle, REPO);
    insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: lp });
    const deadPid = spawnSync('true').pid!;
    updateJob(handle, { status: 'timeout', worker_pid: deadPid });

    const specFile = writeSpec('retry-timeout.md', 'retry timeout spec');
    const { handle: h, status: s1 } = handleResume({ handle, specFile, dir: REPO });
    expect(h).toBe(handle);
    expect(s1).toBe('running');

    await waitFor(() => {
      try { return readFileSync(lp, 'utf8').includes('DONE'); } catch { return false; }
    }, 8_000);
    const job = getJobFresh(handle)!;
    expect(job.worker_pid).toBeGreaterThan(0);
    // KNOWN GAP: status stays timeout despite successful retry
    expect(job.status).toBe('timeout');
  });
});
