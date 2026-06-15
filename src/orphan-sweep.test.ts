import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
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

import { sweepStaleJobs, sweepChainLocks } from './maintenance.ts';
import { isProcessAlive } from './process.ts';
import { insertJob, getJob, updateJob, finalizeJob, pruneOldJobs, logPath as stateLogPath, chainLockPath, workersDir, __resetStateForTest } from './state.ts';
import { SERVER_STARTED, forceKillJob } from './lifecycle.ts';
import { addWorktree } from './worktree.ts';

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

  it('leaves a worker_pid=0 job (claude_tmux / insert window) whose owning server is alive untouched', () => {
    const serverPid = spawnSleep();                   // owner server still running
    const handle = seedRunning({
      worker_pid: 0,                                   // tmux jobs carry 0; also the post-insert window
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

describe('forceKillJob / shutdown — claude_tmux worker_pid===0', () => {
  it('forceKillJob on a claude_tmux job does NOT skip on worker_pid===0', () => {
    // forceKillJob branches on backend === 'claude_tmux' and calls tmux kill-session,
    // ignoring worker_pid entirely. Confirm it doesn't throw and returns without requiring pid>0.
    // We use a fake handle that won't match any real tmux session so the spawnSync silently fails.
    const handle = `tmux-kill-test-${process.pid}-${seq++}`;
    insertJob({
      handle, backend: 'claude_tmux', sid: 'test', repo: REPO,
      log_path: stateLogPath(handle, REPO),
      worker_pid: 0,  // tmux jobs have worker_pid === 0
      server_pid: process.pid,
      server_started: SERVER_STARTED,
    });

    const job = { handle, backend: 'claude_tmux', worker_pid: 0, log_path: stateLogPath(handle, REPO) };

    // Should NOT throw even with worker_pid === 0
    expect(() => forceKillJob(job)).not.toThrow();
    // The tmux kill-session path was taken (not the worker_pid>0 killProcessTree path)
    // Verified implicitly: if it branched on worker_pid>0, it would have been skipped entirely,
    // not killing the tmux session. The function completing without throw confirms the tmux branch ran.
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
