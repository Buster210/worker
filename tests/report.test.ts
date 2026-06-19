import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';

// Throwaway state store, set BEFORE importing report/state (resolution is lazy). A tiny report poll
// interval keeps the waitForUnlock anti-hang test fast (reportPollMs() reads the env lazily per tick).
const STATE_DIR = join(tmpdir(), `wreport-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
process.env.WORKER_REPORT_POLL_MS = '20';
process.env.WORKER_NEAR_EXPIRY_MS = '30000'; // pin the band so isNearTimeout boundary asserts are deterministic

import { terminalStatus, statusLine, wantsDiff, renderReport, waitForUnlock, isNearTimeout } from '../src/report.ts';
import { insertJob, updateJob, appendLadder, chainLockPath } from '../src/state.ts';

let seq = 0;
const uniq = (p: string) => `${p}-${process.pid}-${seq++}`;

// Seed a single-run job at the given terminal status; return its handle + a (non-chain) lock path.
function seedRun(status: string): { handle: string; lockPath: string } {
  const handle = uniq('h');
  insertJob({ handle, backend: 'cmd', sid: uniq('s'), repo: '/repo/x', log_path: '/tmp/x.log' });
  updateJob(handle, { status });
  return { handle, lockPath: `/any/${handle}/.lock` };
}

// Seed a ladder audit trail whose last row carries `lastResult`; return a handle + the chain lock path.
function seedLadder(lastResult: string): { handle: string; lockPath: string; sid: string } {
  const sid = uniq('sid');
  const handle = uniq('h');
  insertJob({ handle, backend: 'omp', sid, repo: '/repo/y', log_path: '/tmp/y.log' });
  appendLadder(sid, 1, 'omp', 'failed');
  appendLadder(sid, 2, 'opencode', lastResult);
  return { handle, lockPath: chainLockPath(sid), sid };
}

describe('terminalStatus — run (per-handle lock → job.json is terminal)', () => {
  for (const s of ['done', 'failed:max-turns', 'timeout', 'stopped', 'killed']) {
    it(`reports a run's ${s} verbatim`, () => {
      const { handle, lockPath } = seedRun(s);
      expect(terminalStatus(handle, lockPath)).toBe(s);
    });
  }
  it('falls back to failed when the handle is unknown', () => {
    expect(terminalStatus('nope', '/any/nope/.lock')).toBe('failed');
  });
});

describe('terminalStatus — ladder (chain lock → audit trail, not rung-0 job.json)', () => {
  it('maps a done last row to done', () => {
    const { handle, lockPath } = seedLadder('done');
    expect(terminalStatus(handle, lockPath)).toBe('done');
  });
  it('maps a killed last row to killed', () => {
    const { handle, lockPath } = seedLadder('killed');
    expect(terminalStatus(handle, lockPath)).toBe('killed');
  });
  it('surfaces a timeout last row as timeout — it is terminal in the chain (no resume/climb)', () => {
    const { handle, lockPath } = seedLadder('timeout');
    expect(terminalStatus(handle, lockPath)).toBe('timeout');
  });
  it('maps any other last row (failed/stopped) to exhausted — chain absorbs those internally', () => {
    for (const last of ['failed', 'stopped']) {
      const { handle, lockPath } = seedLadder(last);
      expect(terminalStatus(handle, lockPath)).toBe('exhausted');
    }
  });
});

describe('statusLine', () => {
  it('collapses done to pointer wording', () => {
    expect(statusLine('done')).toBe('completed — worker committed changes to branch current branch. Review the diff below and merge; nothing else to run.');
    expect(statusLine('done', 'worker/h1', 'abc123')).toBe('completed — worker committed changes to branch worker/h1 (base abc123). Review the diff below and merge; nothing else to run.');
  });
  it('reports every other status verbatim (preserving the failed:reason family)', () => {
    expect(statusLine('failed:max-turns')).toBe('failed:max-turns');
    expect(statusLine('timeout')).toBe('timeout');
    expect(statusLine('exhausted')).toBe('exhausted');
    expect(statusLine('stopped')).toBe('stopped');
    expect(statusLine('killed')).toBe('killed');
  });
});

describe('wantsDiff', () => {
  it('omits the diff only for stopped/killed', () => {
    expect(wantsDiff('stopped')).toBe(false);
    expect(wantsDiff('killed')).toBe(false);
    for (const s of ['done', 'failed:max-turns', 'timeout', 'exhausted']) expect(wantsDiff(s)).toBe(true);
  });
  it('done → pointer wording + worktree + branch + full diff', () => {
    const { handle, lockPath } = seedRun('done');
    const ptr = 'completed — worker committed changes to branch current branch. Review the diff below and merge; nothing else to run.';
    expect(renderReport(handle, lockPath, () => 'DIFFBODY')).toBe(`${ptr}\nworktree: /repo/x\nbranch: worker/${handle}\n\nDIFFBODY`);
  });
  it('exhausted ladder → "exhausted" + diff', () => {
    const { handle, lockPath } = seedLadder('failed');
    expect(renderReport(handle, lockPath, () => 'DIFFBODY')).toBe(`exhausted\nworktree: /repo/y\nbranch: worker/${handle}\n\nDIFFBODY`);
  });
  it('done with empty diff emits a warning', () => {
    const { handle, lockPath } = seedRun('done');
    const ptr = 'completed — worker committed changes to branch current branch. Review the diff below and merge; nothing else to run.';
    expect(renderReport(handle, lockPath, () => '(no tracked changes)')).toBe(`${ptr}\nworktree: /repo/x\nbranch: worker/${handle}\n\n(no tracked changes)\n\nWARNING: completed but worktree has no changes vs base — work may be missing.`);
  });
  it('stopped → single line, diff fn never invoked', () => {
    const { handle, lockPath } = seedRun('stopped');
    let called = false;
    expect(renderReport(handle, lockPath, () => { called = true; return 'X'; })).toBe('stopped');
    expect(called).toBe(false);
  });
  it('killed → single line, no diff', () => {
    const { handle, lockPath } = seedRun('killed');
    expect(renderReport(handle, lockPath, () => 'X')).toBe('killed');
  });
  it('unknown handle on a diff status → sentinel, never a wrong-repo diff (diff fn not invoked)', () => {
    let called = false;
    const r = renderReport('ghost', '/any/ghost/.lock', () => { called = true; return 'WRONGDIFF'; });
    expect(r).toBe('failed\n\n(diff unavailable: unknown handle ghost)');
    expect(called).toBe(false);
  });
});

describe('waitForUnlock — anti-hang', () => {
  mkdirSync(STATE_DIR, { recursive: true });

  it('resolves promptly when the lock is removed (owner alive)', async () => {
    const lock = join(STATE_DIR, `${uniq('lk')}.lock`);
    writeFileSync(lock, '');
    const p = waitForUnlock(lock, process.pid); // own pid = a live owner
    setTimeout(() => { try { unlinkSync(lock); } catch {} }, 30);
    await p; // must resolve once the lock clears, not hang
    expect(existsSync(lock)).toBe(false);
  });

  it('returns immediately when the lock is already gone', async () => {
    await waitForUnlock(join(STATE_DIR, `${uniq('lk')}.missing.lock`), process.pid);
    expect(true).toBe(true); // resolved without throwing/hanging
  });

  it('bails when the owning server is dead even though the lock persists', async () => {
    const lock = join(STATE_DIR, `${uniq('lk')}.lock`);
    writeFileSync(lock, '');
    // PID space well above anything a fresh box allocated → process.kill(pid,0) throws → dead owner.
    await waitForUnlock(lock, 42_000_321); // must resolve despite the lock still being held
    expect(existsSync(lock)).toBe(true); // we bailed on the dead owner; lock was never cleared
  });

  it('legacy/unknown owner (serverPid 0) does NOT bail — only the lock removal resolves it', async () => {
    const lock = join(STATE_DIR, `${uniq('lk')}.lock`);
    writeFileSync(lock, '');
    let resolved = false;
    const p = waitForUnlock(lock, 0).then(() => { resolved = true; });
    await Bun.sleep(80); // several poll ticks — must NOT have bailed
    expect(resolved).toBe(false);
    unlinkSync(lock);
    await p;
    expect(resolved).toBe(true);
  });

  it('breaks out with near_timeout when a watched running job crosses into the deadline band mid-wait', async () => {
    const lock = join(STATE_DIR, `${uniq('lk')}.lock`);
    writeFileSync(lock, ''); // lock never clears — only the deadline watch can end this wait
    const handle = uniq('h');
    insertJob({ handle, backend: 'cmd', sid: uniq('s'), repo: '/repo/z', log_path: '/tmp/z.log' });
    updateJob(handle, { status: 'running', deadline_at: Date.now() + 60 }); // ~60ms out, well inside NEAR
    const why = await waitForUnlock(lock, 0, handle);
    expect(why).toBe('near_timeout');
    expect(existsSync(lock)).toBe(true); // we bailed on the deadline, never cleared the lock
    unlinkSync(lock);
  });
});

describe('isNearTimeout — band predicate', () => {
  const near = 30_000; // WORKER_NEAR_EXPIRY_MS default
  const run = (deadline_at?: number, status = 'running') => ({ status, deadline_at });
  it('fires inside [deadline-NEAR, deadline+NEAR] for a running job', () => {
    const now = 1_000_000;
    expect(isNearTimeout(run(now + near - 1), now)).toBe(true);
    expect(isNearTimeout(run(now - near + 1), now)).toBe(true);
  });
  it('stays quiet outside the band', () => {
    const now = 1_000_000;
    expect(isNearTimeout(run(now + near + 1), now)).toBe(false); // too early
    expect(isNearTimeout(run(now - near - 1), now)).toBe(false); // long past — grace/kill territory
  });
  it('ignores non-running jobs and missing/zero deadlines', () => {
    const now = 1_000_000;
    expect(isNearTimeout(run(now, 'done'), now)).toBe(false);
    expect(isNearTimeout(run(undefined), now)).toBe(false);
    expect(isNearTimeout(run(0), now)).toBe(false);
    expect(isNearTimeout(null, now)).toBe(false);
  });
});
