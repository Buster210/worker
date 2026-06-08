import { describe, it, expect, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { finalizeJob, insertJob, getJob, updateJob, workersDir } from './state.ts';

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