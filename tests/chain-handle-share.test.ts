import { describe, it, expect, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

const STATE_DIR = join(tmpdir(), `wchain-handle-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { insertJob, getJobFresh, updateJob, finalizeJob, appendLadder, chainLockPath, __resetStateForTest } from '../src/state.ts';
import { terminalStatus } from '../src/report.ts';

afterAll(() => {
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
});

describe('chain handle share — one handle, one job.json, live reconciliation', () => {
  it('rung1 fails → rung2 done: getJobFresh(handle) returns done, terminalStatus returns done', () => {
    __resetStateForTest();
    // Simulate a shared chain handle — always a full UUID (claude-safe)
    const chainHandle = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sid = `chain-share-${process.pid}`;
    const repo = '/tmp/test-repo';

    // Rung 1: insert as running, then finalize as failed (rung crashed)
    insertJob({ handle: chainHandle, backend: 'cmd', sid, repo, log_path: '/tmp/run1.log' });
    finalizeJob(chainHandle, 'failed');
    appendLadder(sid, 1, 'cmd', 'failed');

    // Rung 2: insertJob overwrites the shared handle's job.json (failed → running)
    insertJob({ handle: chainHandle, backend: 'omp', sid, repo, log_path: '/tmp/run2.log' });
    finalizeJob(chainHandle, 'done');
    appendLadder(sid, 2, 'omp', 'done');

    // The shared handle's job.json reflects the WINNING rung's live status
    const job = getJobFresh(chainHandle);
    expect(job).not.toBeNull();
    expect(job!.status).toBe('done');

    // terminalStatus reconciles off the live job for chains
    expect(terminalStatus(chainHandle, chainLockPath(sid))).toBe('done');
  });

  it('all rungs failed: terminalStatus returns exhausted', () => {
    __resetStateForTest();
    const chainHandle = '11111111-2222-3333-4444-555555555555';
    const sid = `chain-exhausted-${process.pid}`;
    const repo = '/tmp/test-repo';

    // Rung 1 fails
    insertJob({ handle: chainHandle, backend: 'cmd', sid, repo, log_path: '/tmp/e1.log' });
    finalizeJob(chainHandle, 'failed');
    appendLadder(sid, 1, 'cmd', 'failed');

    // Rung 2 also fails
    insertJob({ handle: chainHandle, backend: 'omp', sid, repo, log_path: '/tmp/e2.log' });
    finalizeJob(chainHandle, 'failed');
    appendLadder(sid, 2, 'omp', 'failed');

    // Live job shows failed — terminalStatus maps to exhausted for chains
    expect(getJobFresh(chainHandle)!.status).toBe('failed');
    expect(terminalStatus(chainHandle, chainLockPath(sid))).toBe('exhausted');
  });

  it('killed rung is terminal — not collapsed to exhausted', () => {
    __resetStateForTest();
    const chainHandle = 'cccccccc-dddd-eeee-ffff-000000000000';
    const sid = `chain-killed-${process.pid}`;
    const repo = '/tmp/test-repo';

    insertJob({ handle: chainHandle, backend: 'cmd', sid, repo, log_path: '/tmp/k1.log' });
    finalizeJob(chainHandle, 'failed');
    appendLadder(sid, 1, 'cmd', 'failed');

    insertJob({ handle: chainHandle, backend: 'omp', sid, repo, log_path: '/tmp/k2.log' });
    updateJob(chainHandle, { kill_requested: true });
    finalizeJob(chainHandle, 'killed');
    appendLadder(sid, 2, 'omp', 'killed');

    expect(getJobFresh(chainHandle)!.status).toBe('killed');
    expect(terminalStatus(chainHandle, chainLockPath(sid))).toBe('killed');
  });
});
