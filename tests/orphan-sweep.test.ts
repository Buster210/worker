import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { spyOn } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as childProcess from 'child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';


const STATE_DIR = join(tmpdir(), `worphan-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;


const THIS_SID = process.env.CLAUDE_CODE_SESSION_ID ?? `test-sid-${process.pid}`;
process.env.CLAUDE_CODE_SESSION_ID = THIS_SID;

import { sweepStaleJobs, sweepChainLocks, sweepStaleWorkerDirs } from '../src/maintenance.ts';
import { isProcessAlive } from '../src/process.ts';
import { insertJob, getJob, getJobFresh, updateJob, finalizeJob, ownsWorktree, logPath as stateLogPath, chainLockPath, workersDir, handleDirUncached, __resetStateForTest, getAllRunningJobs, getAllRunningJobsFresh } from '../src/state.ts';
import { SERVER_STARTED, forceKillJob, spawnReaper, resetShutdownState } from '../src/lifecycle.ts';
import { addWorktree } from '../src/worktree.ts';
import { reaperPidPath } from '../src/state.ts';

const REPO = join(tmpdir(), `worphan-repo-${process.pid}`);
const livePids: number[] = [];
let seq = 0;


function spawnSleep(): number {
  const proc = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  proc.unref();
  const pid = proc.pid!;
  livePids.push(pid);
  return pid;
}


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
    const workerPid = spawnSleep();                 
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: deadPid(),                          
      server_started: new Date().toISOString(),
      resume_token: 'tok-orphan-1',
    });

    sweepStaleJobs();

    const job = getJob(handle)!;
    expect(job).not.toBeNull();
    expect(job.status).toBe('failed');                
    expect(job.resume_token).toBe('tok-orphan-1');    
    await Bun.sleep(100);                             
    expect(isProcessAlive(workerPid)).toBe(false);    
  });

  it('leaves a job whose owning server is alive untouched', () => {
    const serverPid = spawnSleep();                   
    const workerPid = spawnSleep();
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: serverPid,
      server_started: new Date().toISOString(),
    });

    sweepStaleJobs();

    expect(getJob(handle)!.status).toBe('running');   
    expect(isProcessAlive(workerPid)).toBe(true);     
  });

  it('leaves a worker_pid=0 job (insert window) whose owning server is alive untouched', () => {
    const serverPid = spawnSleep();                   
    const handle = seedRunning({
      worker_pid: 0,
      server_pid: serverPid,
      server_started: new Date().toISOString(),
    });

    sweepStaleJobs();

    
    expect(getJob(handle)!.status).toBe('running');
  });

  it('leaves a legacy job (server_pid 0) with a live worker untouched', () => {
    const workerPid = spawnSleep();
    const handle = seedRunning({ worker_pid: workerPid }); 

    sweepStaleJobs();

    expect(getJob(handle)!.status).toBe('running');   
    expect(isProcessAlive(workerPid)).toBe(true);
  });

  it('cleans a legacy job (server_pid 0) whose worker is dead', () => {
    const handle = seedRunning({
      worker_pid: deadPid(),   
      server_pid: 0,            
    });

    sweepStaleJobs();

    
    expect(getJob(handle)!.status).toBe('failed:server-restart');
  });

  
  it('reaps a cross-session job whose server_pid is DEAD (dead-owner reap, any sid)', async () => {
    const workerPid = spawnSleep();                   
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: deadPid(),                           
      server_started: new Date().toISOString(),
      server_sid: 'some-other-sid',                   
    });

    sweepStaleJobs();

    
    expect(getJob(handle)!.status).toBe('failed');
    await Bun.sleep(100);
    expect(isProcessAlive(workerPid)).toBe(false);
  });

  it('leaves a cross-session job whose server_pid is ALIVE (live-owner guard)', () => {
    const serverPid = spawnSleep();                   
    const workerPid = spawnSleep();
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: serverPid,
      server_started: new Date().toISOString(),
      server_sid: 'some-other-sid',                   
    });

    sweepStaleJobs();

    
    expect(getJob(handle)!.status).toBe('running');
    expect(isProcessAlive(workerPid)).toBe(true);
  });
});

describe('sweepChainLocks', () => {
  let savedStateDir: string | undefined;

  beforeEach(() => {
    
    
    savedStateDir = process.env.WORKER_STATE_DIR;
    process.env.WORKER_STATE_DIR = STATE_DIR;
    __resetStateForTest();
    
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
    
    
    const pid = spawnSleep();
    const path = writeLock(sid, `${pid}\n${new Date().toISOString()}`);

    sweepChainLocks();

    expect(existsSync(path)).toBe(true);
    
    try { unlinkSync(path); } catch {}
  });

  it('leaves a legacy/empty chain lock with a fresh mtime (within TTL)', () => {
    const sid = `test-legacy-fresh-${process.pid}-${seq++}`;
    const path = writeLock(sid, ''); 

    sweepChainLocks();

    
    expect(existsSync(path)).toBe(true);
    
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

describe('worktree reap — sweepStaleWorkerDirs and normal finalize', () => {
  const origRetainMs = process.env.WORKER_RETAIN_MS;
  
  afterEach(() => {
    if (origRetainMs === undefined) delete process.env.WORKER_RETAIN_MS;
    else process.env.WORKER_RETAIN_MS = origRetainMs;
  });

  it('sweepStaleWorkerDirs removes the worktree via removeWorktree before rmSync', () => {
    process.env.WORKER_RETAIN_MS = '0'; // force immediate pruning for test
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

    
    expect(existsSync(wt)).toBe(true);

    sweepStaleWorkerDirs();

    
    expect(existsSync(wt)).toBe(false);

    
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

    
    finalizeJob(handle, 'done');

    
    expect(existsSync(wt)).toBe(true);

    
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
    
    insertJob({ handle: sibling, backend: 'cmd', sid: 'test', repo, log_path: stateLogPath(sibling, repo), worktree_path: wt });

    expect(ownsWorktree(getJob(owner)!)).toBe(true);
    expect(ownsWorktree(getJob(sibling)!)).toBe(false);
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('sweepStaleWorkerDirs on a reuse-sibling does NOT remove the shared worktree (owner gate)', () => {
    process.env.WORKER_RETAIN_MS = '0'; // force immediate pruning for test
    const repo = join(tmpdir(), `wreap-share-${process.pid}-${seq++}`);
    initGitRepo(repo);
    const owner = `wreap-shareowner-${process.pid}-${seq++}`;
    const sibling = `wreap-sharesib-${process.pid}-${seq++}`;

    
    insertJob({ handle: owner, backend: 'cmd', sid: 'test', repo, log_path: stateLogPath(owner, repo) });
    const wt = addWorktree(repo, owner);
    updateJob(owner, { worktree_path: wt, status: 'done', finished: new Date().toISOString() });

    
    insertJob({ handle: sibling, backend: 'cmd', sid: 'test', repo, log_path: stateLogPath(sibling, repo), worktree_path: wt });
    updateJob(sibling, { status: 'failed', finished: new Date(Date.now() - 8 * 86_400_000).toISOString() });

    expect(existsSync(wt)).toBe(true);
    sweepStaleWorkerDirs();

    expect(getJob(sibling)).toBeNull();          
    expect(getJob(owner)).not.toBeNull();        
    expect(existsSync(wt)).toBe(true);           

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
    
    expect(getJob(handle)!.status).toBe('failed');
    
    expect(existsSync(wt)).toBe(false);

    
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });
});

describe('getAllRunningJobsFresh — stale cache regression', () => {
  it('returns jobs created after cache bootstrap while cached getAllRunningJobs does not', () => {
    
    getAllRunningJobs();

    
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

    
    expect(getAllRunningJobs().some(j => j.handle === handle)).toBe(false);
    
    expect(getAllRunningJobsFresh().some(j => j.handle === handle)).toBe(true);

    
    try { rmSync(jobDir, { recursive: true, force: true }); } catch {}
  });

  it('sweepStaleJobs({ fresh: true }) reaps orphan created after cache bootstrap', async () => {
    
    getAllRunningJobs();

    
    const repo = join(tmpdir(), `fresh-reap-repo-${process.pid}-${seq++}`);
    initGitRepo(repo);

    
    const handle = `fresh-reap-${process.pid}-${seq++}`;
    const jobDir = handleDirUncached(handle, repo);
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

    
    sweepStaleJobs({ fresh: true });

    await Bun.sleep(100);

    
    const orphanedJob = getJobFresh(handle);
    expect(orphanedJob!.status).toBe('failed');
    
    expect(existsSync(wt)).toBe(false);

    
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
  });

  it('sweepStaleJobs() with no args still uses cached path (existing behavior)', () => {
    
    expect(() => sweepStaleJobs()).not.toThrow();
  });
});
