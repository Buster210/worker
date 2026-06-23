import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { spyOn } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as childProcess from 'child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Point the state store at a throwaway dir BEFORE any state/runner fn runs. state.ts resolves
// WORKER_STATE_DIR lazily (no eager import-time mkdir). No module mocks here on purpose — a
// global mock.module leaks across test files in one `bun test` run and would break runner.test.ts.
// Instead we drive the REAL killProcessTree against real `sleep` processes.
const STATE_DIR = join(tmpdir(), `worphan-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
// Capture the runner's view of THIS server's sid so seedRunning() can tag jobs as "ours" —
// without matching server_sid, the new sid-aware orphan check skips every seeded job.
const THIS_SID = process.env.CLAUDE_CODE_SESSION_ID ?? `test-sid-${process.pid}`;
process.env.CLAUDE_CODE_SESSION_ID = THIS_SID;

import { sweepStaleJobs, sweepChainLocks } from '../src/maintenance.ts';
import { isProcessAlive } from '../src/process.ts';
import { insertJob, getJob, getJobFresh, updateJob, finalizeJob, pruneOldJobs, ownsWorktree, logPath as stateLogPath, chainLockPath, workersDir, handleDir, __resetStateForTest, getAllRunningJobs, getAllRunningJobsFresh } from '../src/state.ts';
import { SERVER_STARTED, forceKillJob, spawnReaper, resetShutdownState } from '../src/lifecycle.ts';
import { addWorktree } from '../src/worktree.ts';
import { reaperPidPath } from '../src/state.ts';
import { serverAliveInPs } from '../src/reaper.ts';

const REPO = join(tmpdir(), `worphan-repo-${process.pid}`);
const livePids: number[] = [];
let seq = 0;

// Real detached, group-leading process so killProcessTree(-pid) reaches it. Stays alive 300s.
function spawnSleep(): number {
  const proc = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  proc.unref();
  const pid = proc.pid!;
  livePids.push(pid);
  return pid;
}

// PID space well above anything a fresh test box will have allocated → process.kill throws → dead.
function deadPid(): number { return 42_000_000 + seq++; }

function seedRunning(fields: {
  worker_pid: number;
  server_pid?: number;
  server_started?: string;
  resume_token?: string;
  server_sid?: string;
}): string {
  const handle = `orphan-${process.pid}-${seq++}`;
  insertJob({
    handle, backend: 'cmd', sid: 'test', repo: REPO,
    log_path: stateLogPath(handle, REPO),
    worker_pid: fields.worker_pid,
    resume_token: fields.resume_token,
    server_pid: fields.server_pid ?? 0,
    server_started: fields.server_started ?? '',
    server_sid: fields.server_sid ?? THIS_SID,
  });
  return handle;
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', dir], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  // Create an initial commit so worktree add works
  writeFileSync(join(dir, 'README.md'), 'init');
  spawnSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' });
  spawnSync('git', ['-C', dir, 'commit', '-m', 'init'], { stdio: 'ignore' });
}

afterEach(() => {
  for (const pid of livePids) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  livePids.length = 0;
});

afterAll(() => {
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(REPO, { recursive: true, force: true }); } catch {}
});

describe('sweepStaleJobs — orphan branch', () => {
  it('kills + finalizes resumable a job whose server is dead but worker alive', async () => {
    const workerPid = spawnSleep();                 // real, alive
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: deadPid(),                          // owner server is gone
      server_started: new Date().toISOString(),
      resume_token: 'tok-orphan-1',
    });

    sweepStaleJobs();

    const job = getJob(handle)!;
    expect(job).not.toBeNull();
    expect(job.status).toBe('failed');                // resumable terminal
    expect(job.resume_token).toBe('tok-orphan-1');    // token preserved for worker_resume
    await Bun.sleep(100);                             // let the kernel reap the SIGKILL'd group
    expect(isProcessAlive(workerPid)).toBe(false);    // real worker process reaped
  });

  it('leaves a job whose owning server is alive untouched', () => {
    const serverPid = spawnSleep();                   // owner server still running
    const workerPid = spawnSleep();
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: serverPid,
      server_started: new Date().toISOString(),
    });

    sweepStaleJobs();

    expect(getJob(handle)!.status).toBe('running');   // not swept
    expect(isProcessAlive(workerPid)).toBe(true);     // worker still alive
  });

  it('leaves a worker_pid=0 job (insert window) whose owning server is alive untouched', () => {
    const serverPid = spawnSleep();                   // owner server still running
    const handle = seedRunning({
      worker_pid: 0,
      server_pid: serverPid,
      server_started: new Date().toISOString(),
    });

    sweepStaleJobs();

    // The live in-process runner owns finalization; the periodic sweep must not finalize it
    // failed:server-restart just because worker_pid is 0.
    expect(getJob(handle)!.status).toBe('running');
  });

  it('leaves a legacy job (server_pid 0) with a live worker untouched', () => {
    const workerPid = spawnSleep();
    const handle = seedRunning({ worker_pid: workerPid }); // server_pid defaults to 0

    sweepStaleJobs();

    expect(getJob(handle)!.status).toBe('running');   // live worker, legacy owner → leave it
    expect(isProcessAlive(workerPid)).toBe(true);
  });

  it('cleans a legacy job (server_pid 0) whose worker is dead', () => {
    const handle = seedRunning({
      worker_pid: deadPid(),   // dead worker
      server_pid: 0,            // legacy / unknown owner
    });

    sweepStaleJobs();

    // Dead worker, unknown owner → finalize as failed:server-restart
    expect(getJob(handle)!.status).toBe('failed:server-restart');
  });

  // Cross-session dead-owner reap: Fix B removes the server_sid skip so jobs from OTHER
  // dead sessions are now cleaned up by ANY surviving server. The live-owner guard (isProcessAlive)
  // protects all live sessions regardless of sid.
  it('reaps a cross-session job whose server_pid is DEAD (dead-owner reap, any sid)', async () => {
    const workerPid = spawnSleep();                   // worker alive
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: deadPid(),                           // dead owner
      server_started: new Date().toISOString(),
      server_sid: 'some-other-sid',                   // different session — no longer protected by sid check
    });

    sweepStaleJobs();

    // Dead owner → reaped regardless of session
    expect(getJob(handle)!.status).toBe('failed');
    await Bun.sleep(100);
    expect(isProcessAlive(workerPid)).toBe(false);
  });

  it('leaves a cross-session job whose server_pid is ALIVE (live-owner guard)', () => {
    const serverPid = spawnSleep();                   // live owner, different session
    const workerPid = spawnSleep();
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: serverPid,
      server_started: new Date().toISOString(),
      server_sid: 'some-other-sid',                   // different session
    });

    sweepStaleJobs();

    // Live owner → worker protected by live-owner guard even across sessions
    expect(getJob(handle)!.status).toBe('running');
    expect(isProcessAlive(workerPid)).toBe(true);
  });
});

describe('reaper serverAliveInPs — self-exit detection', () => {
  const SRV = '/x/worker/src/server.ts';

  it('true when a non-self line contains the server path', () => {
    const ps = `100 /bin/bun run ${SRV}\n200 sleep 5`;
    expect(serverAliveInPs(ps, SRV, 999)).toBe(true);
  });

  it('false when the only matching line is self (the reaper)', () => {
    const ps = `999 /bin/bun run ${SRV}`;
    expect(serverAliveInPs(ps, SRV, 999)).toBe(false);
  });

  it('false when no line contains the server path → reaper would self-exit', () => {
    const ps = `100 sleep 5\n200 node app.js`;
    expect(serverAliveInPs(ps, SRV, 999)).toBe(false);
  });
});

describe('sweepChainLocks', () => {
  let savedStateDir: string | undefined;

  beforeEach(() => {
    // Pin WORKER_STATE_DIR to this file's own unique temp dir at runtime so sibling
    // test files' module-level assignments (which win at import time) don't bleed in.
    savedStateDir = process.env.WORKER_STATE_DIR;
    process.env.WORKER_STATE_DIR = STATE_DIR;
    __resetStateForTest();
    // Remove any stray *.chain.lock files from the ladder dir so sibling locks can't bleed in.
    const ladder = join(STATE_DIR, 'ladder');
    mkdirSync(ladder, { recursive: true });
    try {
      for (const f of readdirSync(ladder)) {
        if (f.endsWith('.chain.lock')) { try { unlinkSync(join(ladder, f)); } catch {} }
      }
    } catch {}
  });

  afterEach(() => {
    process.env.WORKER_STATE_DIR = savedStateDir;
    __resetStateForTest();
  });

  function lockDir(): string {
    return join(workersDir(), 'ladder');
  }

  function writeLock(sid: string, content: string): string {
    const path = chainLockPath(sid);
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  it('unlinks a chain lock whose owner pid is dead', () => {
    const sid = `test-dead-${process.pid}-${seq++}`;
    const dead = deadPid();
    const path = writeLock(sid, `${dead}\n2024-01-01T00:00:00.000Z`);

    sweepChainLocks();

    expect(existsSync(path)).toBe(false);
  });

  it('leaves a chain lock whose owner pid is alive', () => {
    const sid = `test-live-${process.pid}-${seq++}`;
    // Freshly-spawned child: its real start ≈ now, so the stored started matches what
    // isProcessAlive derives from `ps etime` (~0 skew). Using SERVER_STARTED here is
    // flaky — that import-time stamp drifts past the 60s skew window in a long full-suite
    // run, so the live owner gets misjudged dead and the lock wrongly unlinked.
    const pid = spawnSleep();
    const path = writeLock(sid, `${pid}\n${new Date().toISOString()}`);

    sweepChainLocks();

    expect(existsSync(path)).toBe(true);
    // Cleanup
    try { unlinkSync(path); } catch {}
  });

  it('leaves a legacy/empty chain lock with a fresh mtime (within TTL)', () => {
    const sid = `test-legacy-fresh-${process.pid}-${seq++}`;
    const path = writeLock(sid, ''); // empty = legacy, no pid

    sweepChainLocks();

    // Fresh mtime → within reapAgeMs TTL → left alone
    expect(existsSync(path)).toBe(true);
    // Cleanup
    try { unlinkSync(path); } catch {}
  });
});


describe('spawnReaper single-instance guard', () => {
  afterEach(() => {
    resetShutdownState();
    try { unlinkSync(reaperPidPath()); } catch {}
  });

  it('does not spawn a second reaper when a live pidfile already exists', () => {
    resetShutdownState();
    writeFileSync(reaperPidPath(), `${process.pid}\n`);
    const spawnSpy = spyOn(childProcess, 'spawn');

    spawnReaper();
    spawnReaper();

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(readFileSync(reaperPidPath(), 'utf8').trim()).toBe(String(process.pid));
  });
});

describe('worktree reap — pruneOldJobs and normal finalize', () => {
  it('pruneOldJobs removes the worktree via removeWorktree before rmSync', () => {
    const repo = join(tmpdir(), `wreap-repo-${process.pid}-${seq++}`);
    initGitRepo(repo);

    const handle = `wreap-prune-${process.pid}-${seq++}`;

    insertJob({
      handle, backend: 'cmd', sid: 'test', repo,
      log_path: stateLogPath(handle, repo),
      server_pid: process.pid,
      server_started: SERVER_STARTED,
    });
    const wt = addWorktree(repo, handle);
    updateJob(handle, { worktree_path: wt, status: 'done', finished: new Date(Date.now() - 8 * 86_400_000).toISOString() });

    // Worktree dir should exist before pruning
    expect(existsSync(wt)).toBe(true);

    pruneOldJobs(Date.now());

    // Worktree should be removed by pruneOldJobs
    expect(existsSync(wt)).toBe(false);

    // Cleanup
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('a normal done finalize does NOT remove the worktree', () => {
    const repo = join(tmpdir(), `wreap-normal-${process.pid}-${seq++}`);
    initGitRepo(repo);

    const handle = `wreap-normal-${process.pid}-${seq++}`;

    insertJob({
      handle, backend: 'cmd', sid: 'test', repo,
      log_path: stateLogPath(handle, repo),
      server_pid: process.pid,
      server_started: SERVER_STARTED,
    });
    const wt = addWorktree(repo, handle);
    updateJob(handle, { worktree_path: wt });

    // Normal finalize (done)
    finalizeJob(handle, 'done');

    // Worktree must still exist — orchestrator reads it after finalize
    expect(existsSync(wt)).toBe(true);

    // Cleanup
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('ownsWorktree: true for the creator, false for a ladder reuse-sibling sharing the path', () => {
    const repo = join(tmpdir(), `wreap-owns-${process.pid}-${seq++}`);
    initGitRepo(repo);
    const owner = `wreap-owner-${process.pid}-${seq++}`;
    const sibling = `wreap-sibling-${process.pid}-${seq++}`;
    insertJob({ handle: owner, backend: 'cmd', sid: 'test', repo, log_path: stateLogPath(owner, repo) });
    const wt = addWorktree(repo, owner);
    updateJob(owner, { worktree_path: wt });
    // The sibling reuses the owner's worktree path (what a retry/climb rung does).
    insertJob({ handle: sibling, backend: 'cmd', sid: 'test', repo, log_path: stateLogPath(sibling, repo), worktree_path: wt });

    expect(ownsWorktree(getJob(owner)!)).toBe(true);
    expect(ownsWorktree(getJob(sibling)!)).toBe(false);
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('pruneOldJobs on a reuse-sibling does NOT remove the shared worktree (owner gate)', () => {
    const repo = join(tmpdir(), `wreap-share-${process.pid}-${seq++}`);
    initGitRepo(repo);
    const owner = `wreap-shareowner-${process.pid}-${seq++}`;
    const sibling = `wreap-sharesib-${process.pid}-${seq++}`;

    // Owner created the worktree but is still FRESH → not eligible for pruning this pass.
    insertJob({ handle: owner, backend: 'cmd', sid: 'test', repo, log_path: stateLogPath(owner, repo) });
    const wt = addWorktree(repo, owner);
    updateJob(owner, { worktree_path: wt, status: 'done', finished: new Date().toISOString() });

    // Sibling reuses the same worktree and is OLD → gets pruned. It must NOT take the worktree down.
    insertJob({ handle: sibling, backend: 'cmd', sid: 'test', repo, log_path: stateLogPath(sibling, repo), worktree_path: wt });
    updateJob(sibling, { status: 'failed', finished: new Date(Date.now() - 8 * 86_400_000).toISOString() });

    expect(existsSync(wt)).toBe(true);
    pruneOldJobs(Date.now());

    expect(getJob(sibling)).toBeNull();          // sibling row pruned
    expect(getJob(owner)).not.toBeNull();        // owner kept (still fresh)
    expect(existsSync(wt)).toBe(true);           // shared worktree survives the sibling prune

    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('reaped orphan (sweepStaleJobs dead-owner) removes its worktree', async () => {
    const repo = join(tmpdir(), `wreap-orphan-${process.pid}-${seq++}`);
    initGitRepo(repo);

    const workerPid = spawnSleep();
    const handle = `wreap-orphan-${process.pid}-${seq++}`;

    insertJob({
      handle, backend: 'cmd', sid: 'test', repo,
      log_path: stateLogPath(handle, repo),
      worker_pid: workerPid,
      server_pid: deadPid(),
      server_started: new Date().toISOString(),
    });
    const wt = addWorktree(repo, handle);
    updateJob(handle, { worktree_path: wt });

    sweepStaleJobs();

    await Bun.sleep(100);
    // Job reaped
    expect(getJob(handle)!.status).toBe('failed');
    // Worktree removed by reapWorktree
    expect(existsSync(wt)).toBe(false);

    // Cleanup
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });
});

describe('getAllRunningJobsFresh — stale cache regression', () => {
  it('returns jobs created after cache bootstrap while cached getAllRunningJobs does not', () => {
    // Prime the cache by calling getAllRunningJobs once (returns whatever exists)
    getAllRunningJobs();

    // Now write a new running job to disk directly (simulating reaper starting before any worker)
    const handle = `fresh-orphan-${process.pid}-${seq++}`;
    const jobDir = join(workersDir(), 'default', handle);
    mkdirSync(jobDir, { recursive: true });
    const job = {
      handle,
      backend: 'cmd',
      sid: 'test',
      worker_pid: deadPid(),
      resume_token: '',
      repo: REPO,
      started: new Date().toISOString(),
      status: 'running',
      model: '',
      task: '',
      log_path: join(jobDir, 'run.log'),
      completion_lock: join(jobDir, '.lock'),
      server_pid: deadPid(),
      server_started: new Date().toISOString(),
      server_sid: THIS_SID,
    };
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job));

    // Cached getAllRunningJobs does NOT see it (empty in-memory map from bootstrap)
    expect(getAllRunningJobs().some(j => j.handle === handle)).toBe(false);
    // Fresh scan DOES see it (reads disk)
    expect(getAllRunningJobsFresh().some(j => j.handle === handle)).toBe(true);

    // Cleanup
    try { rmSync(jobDir, { recursive: true, force: true }); } catch {}
  });

  it('sweepStaleJobs({ fresh: true }) reaps orphan created after cache bootstrap', async () => {
    // Prime the cache first
    getAllRunningJobs();

    // Create a git repo for worktree test
    const repo = join(tmpdir(), `fresh-reap-repo-${process.pid}-${seq++}`);
    initGitRepo(repo);

    // Write a running orphan job directly to disk. Use handleDir(handle, repo) —
    // the same path addWorktree resolves — so finalizeJob's write and
    // getJobFresh's read (both via the repo-derived/cached handle dir) agree.
    const handle = `fresh-reap-${process.pid}-${seq++}`;
    const jobDir = handleDir(handle, repo);
    mkdirSync(jobDir, { recursive: true });
    const wt = addWorktree(repo, handle);
    const workerPid = spawnSleep();
    const job = {
      handle,
      backend: 'cmd',
      sid: 'test',
      worker_pid: workerPid,
      resume_token: '',
      repo,
      started: new Date().toISOString(),
      status: 'running',
      model: '',
      task: '',
      log_path: join(jobDir, 'run.log'),
      completion_lock: join(jobDir, '.lock'),
      server_pid: deadPid(),
      server_started: new Date().toISOString(),
      server_sid: THIS_SID,
      worktree_path: wt,
    };
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job));

    // Sweep with fresh=true (simulates what reaper does)
    sweepStaleJobs({ fresh: true });

    await Bun.sleep(100);

    // Assert the orphan job is finalized (use getJobFresh since we wrote directly to disk)
    const orphanedJob = getJobFresh(handle);
    expect(orphanedJob!.status).toBe('failed');
    // Assert worktree was removed
    expect(existsSync(wt)).toBe(false);

    // Cleanup
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('sweepStaleJobs() with no args still uses cached path (existing behavior)', () => {
    // Verify no-arg call still works (uses cached path)
    expect(() => sweepStaleJobs()).not.toThrow();
  });
});
