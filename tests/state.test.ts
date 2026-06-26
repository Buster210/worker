import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import { rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';


const STATE_DIR = join(tmpdir(), `wstate-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
const PLANS_DIR = join(tmpdir(), `wstate-plans-${process.pid}`);
process.env.WORKER_PLANS_DIR = PLANS_DIR;
mkdirSync(PLANS_DIR, { recursive: true });

import { finalizeJob, insertJob, getJob, getJobFresh, updateJob, workersDir, handleDirUncached, lockPath, resolveHandleDir, readSpec, plansDir, saveChainMeta, removeChainMeta, chainMetaPath, pruneTranscript } from '../src/state.ts';
import { sweepStaleWorkerDirs } from '../src/maintenance.ts';

afterAll(() => {
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(PLANS_DIR, { recursive: true, force: true }); } catch {}
});

describe('finalizeJob', () => {
  const testHandles: string[] = [];

  afterEach(() => {
    for (const handle of testHandles) {
      
      const jobDir = join(workersDir(), 'finalizetest', handle);
      try { rmSync(jobDir, { recursive: true, force: true }); } catch {}
    }
    testHandles.length = 0;
  });

  it('returns "killed" and persists status "killed" when kill_requested set with failed status', () => {
    const handle = `finalize-test-${process.pid}-${Date.now()}-1`;
    const logPath = `/tmp/${handle}.log`;
    testHandles.push(handle);

    
    insertJob({
      handle,
      backend: 'cmd',
      sid: 'test-sid',
      repo: '/tmp/finalizetest',
      log_path: logPath,
    });
    
    
    updateJob(handle, { kill_requested: true });

    
    const result = finalizeJob(handle, 'failed');
    expect(result).toBe('killed');

    
    const persistedJob = getJob(handle);
    expect(persistedJob?.status).toBe('killed');
  });

  it('returns "done" (completion wins over kill) when kill_requested set with done status', () => {
    const handle = `finalize-test-${process.pid}-${Date.now()}-2`;
    const logPath = `/tmp/${handle}.log`;
    testHandles.push(handle);

    
    insertJob({
      handle,
      backend: 'cmd',
      sid: 'test-sid',
      repo: '/tmp/finalizetest',
      log_path: logPath,
    });
    
    
    updateJob(handle, { kill_requested: true });

    
    const result = finalizeJob(handle, 'done');
    expect(result).toBe('done');

    
    const persistedJob = getJob(handle);
    expect(persistedJob?.status).toBe('done');
  });

  it('is idempotent: second finalize on an already-terminal job returns first result without updating finished', () => {
    const handle = `finalize-idem-${process.pid}-${Date.now()}`;
    const logPath = `/tmp/${handle}.log`;
    testHandles.push(handle);

    insertJob({ handle, backend: 'cmd', sid: 't', repo: '/tmp/finalizetest', log_path: logPath });
    const first = finalizeJob(handle, 'done');
    expect(first).toBe('done');

    const firstFinished = getJob(handle)!.finished;
    
    const start = Date.now();
    const second = finalizeJob(handle, 'failed'); 
    expect(second).toBe('done'); 

    const job = getJob(handle)!;
    expect(job.status).toBe('done'); 
    expect(job.finished).toBe(firstFinished); 
  });
});


describe('getJobFresh bypasses in-memory cache', () => {
  it('reads the latest disk state while getJob returns stale cache', () => {
    const handle = `fresh-test-${process.pid}-${Date.now()}`;
    insertJob({ handle, backend: 'cmd', sid: 't', repo: '/tmp/fresh-test', log_path: 'x' });

    
    expect(getJob(handle)?.status).toBe('running');
    expect(getJobFresh(handle)?.status).toBe('running');

    const jobPath = join(handleDirUncached(handle, '/tmp/fresh-test'), 'job.json');
    const disk = JSON.parse(readFileSync(jobPath, 'utf8'));
    disk.status = 'done';
    writeFileSync(jobPath, JSON.stringify(disk, null, 2));

    
    expect(getJob(handle)?.status).toBe('running');
    
    expect(getJobFresh(handle)?.status).toBe('done');
  });
});

describe('sweepStaleWorkerDirs (retention)', () => {
  const origRetainMs = process.env.WORKER_RETAIN_MS;
  
  afterEach(() => {
    if (origRetainMs === undefined) delete process.env.WORKER_RETAIN_MS;
    else process.env.WORKER_RETAIN_MS = origRetainMs;
  });

  it('removes terminal jobs past retention, keeps fresh + running', () => {
    process.env.WORKER_RETAIN_MS = '0'; // force immediate pruning for test
    const mk = (handle: string, status: string, finishedAgoMs?: number) => {
      insertJob({ handle, backend: 'cmd', sid: 's', repo: '/tmp/prune-repo', log_path: '/tmp/x' });
      if (status !== 'running') {
        updateJob(handle, { status, finished: new Date(Date.now() - (finishedAgoMs ?? 0)).toISOString() });
      }
    };
    mk('old-term', 'done', 8 * 86_400_000);  
    mk('fresh-term', 'done', 1000);          
    mk('run', 'running');                    
    const oldDir = handleDirUncached('old-term', '/tmp/prune-repo');
    sweepStaleWorkerDirs();
    expect(getJob('old-term')).toBeNull();
    expect(existsSync(oldDir)).toBe(false);
    expect(getJob('fresh-term')).not.toBeNull();
    expect(getJob('run')).not.toBeNull();
  });

  it('keeps terminal jobs without finished field (no finished = not stale)', () => {
    process.env.WORKER_RETAIN_MS = '0';
    const handle = `prune-nofinish-${process.pid}-${Date.now()}`;
    insertJob({ handle, backend: 'cmd', sid: 's', repo: '/tmp/prune-nofinish', log_path: '/tmp/x' });
    updateJob(handle, { status: 'done' }); 
    sweepStaleWorkerDirs();
    expect(getJob(handle)).not.toBeNull();
    
    rmSync(handleDirUncached(handle, '/tmp/prune-nofinish'), { recursive: true, force: true });
  });

  it('keeps terminal jobs with invalid finished timestamp', () => {
    process.env.WORKER_RETAIN_MS = '0';
    const handle = `prune-invalid-finished-${process.pid}-${Date.now()}`;
    insertJob({ handle, backend: 'cmd', sid: 's', repo: '/tmp/prune-invalid', log_path: '/tmp/x' });
    updateJob(handle, { status: 'done', finished: 'not-a-timestamp' });
    sweepStaleWorkerDirs();
    expect(getJob(handle)).not.toBeNull();
    
    rmSync(handleDirUncached(handle, '/tmp/prune-invalid'), { recursive: true, force: true });
  });
});

describe('plansDir + readSpec', () => {
  it('plansDir() returns WORKER_PLANS_DIR when set', () => {
    expect(plansDir()).toBe(PLANS_DIR);
  });

  it('reads a valid spec file by bare filename', () => {
    writeFileSync(join(PLANS_DIR, 'my-spec.md'), 'hello world');
    expect(readSpec('my-spec.md')).toBe('hello world');
  });

  it('throws for a missing file with path in the error message', () => {
    expect(() => readSpec('does-not-exist.md')).toThrow(/spec not found:/);
    expect(() => readSpec('does-not-exist.md')).toThrow(join(PLANS_DIR, 'does-not-exist.md'));
  });

  it('rejects empty string', () => {
    expect(() => readSpec('')).toThrow(/empty/);
  });

  it('rejects whitespace-only string', () => {
    expect(() => readSpec('   ')).toThrow(/empty/);
  });

  it('rejects filenames with forward slash (path traversal)', () => {
    expect(() => readSpec('a/b')).toThrow(/bare filename/);
  });

  it('rejects filenames with backslash', () => {
    expect(() => readSpec('a\\b')).toThrow(/bare filename/);
  });

  it('rejects ".."', () => {
    expect(() => readSpec('..')).toThrow(/path traversal/);
  });

  it('rejects "."', () => {
    expect(() => readSpec('.')).toThrow(/path traversal/);
  });

  it('rejects filenames containing ".." segment', () => {
    expect(() => readSpec('../escape')).toThrow();
  });

  
  it('rejects a bare filename containing ".." (no separator)', () => {
    expect(() => readSpec('foo..bar')).toThrow(/path traversal/);
    expect(() => readSpec('..foo')).toThrow(/path traversal/);
  });
});

describe('removeChainMeta', () => {
  it('deletes the .chain.meta file written by saveChainMeta', () => {
    const sid = `test-chain-meta-${process.pid}-${Date.now()}`;
    saveChainMeta(sid, { deadlineAt: Date.now() + 60_000 });
    expect(existsSync(chainMetaPath(sid))).toBe(true);
    removeChainMeta(sid);
    expect(existsSync(chainMetaPath(sid))).toBe(false);
  });
});
describe('handleDirUncached does not poison the handle-dir cache', () => {
  it('finalizeJob writes to canonical dir even after handleDirUncached with foreign repo', () => {
    const handle = `uncached-${process.pid}-${Date.now()}`;
    const repo = `/tmp/wstate-cache-${process.pid}-${Date.now()}`;
    insertJob({ handle, backend: 'omp', sid: 's', repo, log_path: join(STATE_DIR, 'logs', handle, 'run.log') });

    
    const wt = join(handleDirUncached(handle, repo), 'tree');
    handleDirUncached(handle, wt);

    finalizeJob(handle, 'done');
    expect(getJobFresh(handle)?.status).toBe('done');
    expect(existsSync(lockPath(handle, repo))).toBe(false);
  });
});
describe('pruneTranscript', () => {
  it('prunes run.log when status is done; keeps job.json', () => {
    const handle = `pt-done-${process.pid}-${Date.now()}`;
    const repo = `/tmp/wstate-pt-${process.pid}`;
    const dir = handleDirUncached(handle, repo);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'run.log');
    writeFileSync(log, 'agent output');
    insertJob({ handle, backend: 'cmd', sid: 's', repo, log_path: log });
    updateJob(handle, { status: 'done' });
    expect(pruneTranscript(handle)).toBe('pruned');
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(dir, 'job.json'))).toBe(true);
  });
  it('keeps run.log when status is not done', () => {
    const handle = `pt-stall-${process.pid}-${Date.now()}`;
    const repo = `/tmp/wstate-pt-${process.pid}`;
    const dir = handleDirUncached(handle, repo);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'run.log');
    writeFileSync(log, 'agent output');
    insertJob({ handle, backend: 'cmd', sid: 's', repo, log_path: log });
    updateJob(handle, { status: 'stalled' });
    expect(pruneTranscript(handle)).toBe('kept:not-done');
    expect(existsSync(log)).toBe(true);
  });
  it('returns kept:no-job for unknown handle', () => {
    expect(pruneTranscript(`nonexistent-${process.pid}`)).toBe('kept:no-job');
  });
  it('is idempotent: re-prune of an already-gone log still returns pruned', () => {
    const handle = `pt-twice-${process.pid}-${Date.now()}`;
    const repo = `/tmp/wstate-pt-${process.pid}`;
    const dir = handleDirUncached(handle, repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.log'), 'agent output');
    insertJob({ handle, backend: 'cmd', sid: 's', repo, log_path: join(dir, 'run.log') });
    updateJob(handle, { status: 'done' });
    expect(pruneTranscript(handle)).toBe('pruned');
    expect(pruneTranscript(handle)).toBe('pruned'); 
  });
});
