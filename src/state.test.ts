import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import { rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Throwaway store set BEFORE importing state (resolution is lazy). Without this the tests would
// read/write the real ~/.claude/workers and the cache test below would delete live job dirs.
const STATE_DIR = join(tmpdir(), `wstate-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { finalizeJob, insertJob, getJob, getJobFresh, updateJob, workersDir, handleDir, resolveHandleDir } from './state.ts';

afterAll(() => {
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
});

describe('finalizeJob', () => {
  const testHandles: string[] = [];

  afterEach(() => {
    for (const handle of testHandles) {
      // Clean up job directory
      const jobDir = join(workersDir(), 'finalizetest', handle);
      try { rmSync(jobDir, { recursive: true, force: true }); } catch {}
    }
    testHandles.length = 0;
  });

  it('returns "killed" and persists status "killed" when kill_requested set with failed status', () => {
    const handle = `finalize-test-${process.pid}-${Date.now()}-1`;
    const logPath = `/tmp/${handle}.log`;
    testHandles.push(handle);

    // Insert a throwaway job
    insertJob({
      handle,
      backend: 'cmd',
      sid: 'test-sid',
      repo: '/tmp/finalizetest',
      log_path: logPath,
    });
    
    // Set kill_requested
    updateJob(handle, { kill_requested: true });

    // Finalize with 'failed' status - should return 'killed'
    const result = finalizeJob(handle, 'failed');
    expect(result).toBe('killed');

    // Verify status persisted
    const persistedJob = getJob(handle);
    expect(persistedJob?.status).toBe('killed');
  });

  it('returns "done" (completion wins over kill) when kill_requested set with done status', () => {
    const handle = `finalize-test-${process.pid}-${Date.now()}-2`;
    const logPath = `/tmp/${handle}.log`;
    testHandles.push(handle);

    // Insert a throwaway job with kill_requested set
    insertJob({
      handle,
      backend: 'cmd',
      sid: 'test-sid',
      repo: '/tmp/finalizetest',
      log_path: logPath,
    });
    
    // Set kill_requested
    updateJob(handle, { kill_requested: true });

    // Finalize with 'done' status - should return 'done' (completion wins)
    const result = finalizeJob(handle, 'done');
    expect(result).toBe('done');

    // Verify status persisted
    const persistedJob = getJob(handle);
    expect(persistedJob?.status).toBe('done');
  });
});

describe('handleDir cache (#5)', () => {
  it('resolves a known handle from cache, not a WORKERS_DIR walk', () => {
    const handle = `cache-${process.pid}-${Date.now()}`;
    insertJob({ handle, backend: 'cmd', sid: 't', repo: '/tmp/wcache-proj', log_path: 'x' });

    // No-repo lookup hits the cache seeded by insertJob → the project-scoped dir, not the flat fallback.
    const cachedDir = handleDir(handle);
    expect(cachedDir).toBe(join(workersDir(), 'tmp-wcache-proj', handle));

    // Wipe the on-disk job so a cold walk would find nothing...
    rmSync(join(workersDir(), 'tmp-wcache-proj'), { recursive: true, force: true });
    expect(resolveHandleDir(handle)).toBeNull();   // the scan now yields nothing
    expect(handleDir(handle)).toBe(cachedDir);      // ...yet handleDir still returns it → served from cache
  });
});

describe('getJobFresh bypasses in-memory cache', () => {
  it('reads the latest disk state while getJob returns stale cache', () => {
    const handle = `fresh-test-${process.pid}-${Date.now()}`;
    insertJob({ handle, backend: 'cmd', sid: 't', repo: '/tmp/fresh-test', log_path: 'x' });

    // Both agree on 'running' initially
    expect(getJob(handle)?.status).toBe('running');
    expect(getJobFresh(handle)?.status).toBe('running');

    const jobPath = join(handleDir(handle), 'job.json');
    const disk = JSON.parse(readFileSync(jobPath, 'utf8'));
    disk.status = 'done';
    writeFileSync(jobPath, JSON.stringify(disk, null, 2));

    // getJob still returns the stale in-memory 'running'
    expect(getJob(handle)?.status).toBe('running');
    // getJobFresh reads disk and returns the updated 'done'
    expect(getJobFresh(handle)?.status).toBe('done');
  });
});