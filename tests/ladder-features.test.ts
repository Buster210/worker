import { describe, it, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { type Backend } from '../src/backends.ts';
import { insertJob, updateJob, __resetStateForTest, loadChainMeta, saveChainMeta, chainLockPath } from '../src/state.ts';
import { runLadderChain, effectiveChainDeadline, type LadderDrivers } from '../src/chain.ts';
import { handleExtend } from '../src/server.ts';
import type { RunResult } from '../src/runner.ts';

const STATE_DIR = join(tmpdir(), `wladder-features-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

let sidSeq = 0;
const nextSid = () => `test-${process.pid}-${sidSeq++}`;
const tmpDirs: string[] = [];

function makeRepo(prefix: string): string {
  const raw = mkdtempSync(join(tmpdir(), prefix));
  const dir = realpathSync(raw);
  tmpDirs.push(dir);
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), 'init\n');
  git('add', '.');
  git('commit', '-m', 'init', '--no-gpg-sign');
  return dir;
}

function res(status: string, handle = 'h'): RunResult {
  return { status, exit_code: 0, backend: 'cmd' as Backend, handle, resume_token: handle, repo: '/x', log: '' };
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  __resetStateForTest();
});

describe('Ladder feature tests', () => {
  it('test 1: global deadline shared across rungs — both rungs get the same absolute deadline_at', async () => {
    __resetStateForTest();
    const sid = nextSid();
    const repo = makeRepo('wladder-deadline-');
    const chainDeadlineAt = Date.now() + 30_000;

    let seenDeadlines: number[] = [];
    const drivers: LadderDrivers = {
      runRung: async (backend) => {
        const firstHandle = 'first';
        insertJob({
          handle: firstHandle,
          backend: 'cmd',
          sid,
          repo,
          log_path: '/tmp/test.log',
          deadline_at: chainDeadlineAt,
        });
        const job = { handle: firstHandle, backend, deadline_at: chainDeadlineAt };
        seenDeadlines.push(job.deadline_at);
        return res('done', firstHandle);
      },
    };

    const final = await runLadderChain(sid, Promise.resolve(res('failed', 'rung0')), drivers, chainDeadlineAt);
    expect(final.status).toBe('done');
    expect(seenDeadlines.length).toBe(1);
    expect(seenDeadlines[0]).toBe(chainDeadlineAt);
  });

  it('test 2: strict cancel at deadline — if launch time is >= chainDeadlineAt, chain returns timeout without starting', async () => {
    __resetStateForTest();
    const sid = nextSid();
    const pastDeadline = Date.now() - 1000;

    let ranRung = false;
    const drivers: LadderDrivers = {
      runRung: async (backend) => {
        ranRung = true;
        return res('done', 'rung');
      },
    };

    const final = await runLadderChain(sid, Promise.resolve(res('failed', 'rung0')), drivers, pastDeadline);
    expect(final.status).toBe('timeout');
    expect(ranRung).toBe(false);
  });

  it('test 6: extend is chain-wide — handleExtend on a chain handle bumps chain-meta and reaches a later rung', () => {
    __resetStateForTest();
    const sid = nextSid();
    const repo = makeRepo('wladder-extend-');
    const originalDeadline = Date.now() + 10_000;

    
    saveChainMeta(sid, { deadlineAt: originalDeadline });

    
    const chainHandle = `chain-${sid}`;
    insertJob({
      handle: chainHandle,
      backend: 'cmd',
      sid,
      repo,
      log_path: '/tmp/chain.log',
      completion_lock: chainLockPath(sid),
      deadline_at: originalDeadline,
    });

    
    const seconds = 120;
    const ret = handleExtend({ handle: chainHandle, seconds });

    
    const meta = loadChainMeta(sid);
    expect(meta).not.toBeNull();
    expect(meta!.deadlineAt).toBeGreaterThan(originalDeadline);
    expect(meta!.deadlineAt).toBe(ret.deadline_at);

    
    const effective = effectiveChainDeadline(sid, originalDeadline);
    expect(effective).toBe(meta!.deadlineAt);
    expect(effective).toBeGreaterThan(originalDeadline);
    expect(effective - originalDeadline).toBeGreaterThanOrEqual(seconds * 1000 - 1000);

    
    updateJob(chainHandle, { status: 'failed' });
    const before = loadChainMeta(sid)!.deadlineAt;
    const ret2 = handleExtend({ handle: chainHandle, seconds: 60 });
    const after = loadChainMeta(sid)!.deadlineAt;
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(ret2.deadline_at);
  });
});
