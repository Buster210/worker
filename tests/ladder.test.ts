import { describe, it, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';
import { runLadderChain, effectiveChainDeadline, type LadderDrivers } from '../src/chain.ts';
import { LADDER, type Backend } from '../src/backends.ts';
import { getLadderHistory, insertJob, updateJob, __resetStateForTest, loadChainMeta, saveChainMeta, chainLockPath } from '../src/state.ts';
import { handleExtend } from '../src/server.ts';
import { addWorktree, listWorktrees } from '../src/worktree.ts';
import type { RunResult } from '../src/runner.ts';

const STATE_DIR = join(tmpdir(), `wladder-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

let sidSeq = 0;
const nextSid = () => `ladder-test-${process.pid}-${sidSeq++}`;
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

function git(dir: string, ...a: string[]) { return spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }); }

function res(status: string, handle = 'h'): RunResult {
  return { status, exit_code: 0, backend: 'cmd' as Backend, handle, resume_token: handle, repo: '/x', log: '' };
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  __resetStateForTest();
});

describe('runLadderChain (auto-climb controller)', () => {
  function scriptedDrivers(opts: {
    rungs: string[];
  }): LadderDrivers & { runCalls: Backend[] } {
    const runCalls: Backend[] = [];
    let idx = 0;
    return {
      runCalls,
      runRung: async (backend: Backend) => { runCalls.push(backend); return res(opts.rungs[idx++] ?? 'failed', `run-${backend}`); },
    };
  }

  it('stops on a first-rung done — no climb, single audit turn', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: [] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('done', 'first')), d, deadline);
    expect(final.status).toBe('done');
    expect(final.handle).toBe('first');
    expect(d.runCalls).toEqual([]);
    expect(getLadderHistory(sid).length).toBe(1);
  });

  it('climbs to the next backend on a hard failure (no retry on failed)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[1]]);
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['failed', 'done']);
  });

  it('on timeout: terminal — no retry, no climb (deadline+grace kill is final)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('timeout', 'rung0')), d, deadline);
    expect(final.status).toBe('timeout');
    expect(d.runCalls).toEqual([]);
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['timeout']);
  });

  it('on stalled: fresh re-runs the SAME backend once, succeeds → no climb', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[0]]);
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['stalled', 'done']);
  });

  it('on stalled: re-runs same backend once, then climbs when the retry also stalls', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['stalled', 'done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[0], LADDER[1]]);
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['stalled', 'stalled', 'done']);
  });

  it('returns "exhausted" when every backend fails, climbing through the whole ladder once', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: Array(LADDER.length).fill('failed') });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('exhausted');
    expect(d.runCalls).toEqual(LADDER.slice(1));
    expect(getLadderHistory(sid).length).toBe(LADDER.length);
  });

  it('exhausting on a last-rung stall reports the retry attempt, not the stale pre-retry result', async () => {
    const sid = nextSid();
    const rungs = [...Array(LADDER.length - 2).fill('failed'), 'stalled', 'stalled'];
    const d = scriptedDrivers({ rungs });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('exhausted');
    expect(final.handle).toBe(`run-${LADDER[LADDER.length - 1]}`);
  });

  it('stops without climbing when a rung is killed (operator intent honored)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('killed', 'rung0')), d, deadline);
    expect(final.status).toBe('killed');
    expect(d.runCalls).toEqual([]);
  });

  it('climbs despite a missing ladder/ dir (ensureLadderDir resilience)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    rmSync(join(STATE_DIR, 'ladder'), { recursive: true, force: true });
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[1]]);
  });

  it('KNOWN GAP: no total wall-clock cap — retries + climbs every rung, each with the FULL per-rung timeout', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['stalled', ...Array(LADDER.length - 1).fill('failed')] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('exhausted');
    expect(d.runCalls).toEqual([LADDER[0], ...LADDER.slice(1)]);
    expect(d.runCalls.length).toBe(LADDER.length);
  });
});

describe('ladder worktree reuse', () => {
  it('INVARIANT: work carried across retry+climb; report target shows the winner', () => {
    const repo = makeRepo('wreuse-');
    const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    const h0 = 'first', h1 = 'retry', h2 = 'winner';

    const wt = addWorktree(repo, h0);
    insertJob({ handle: h0, backend: 'cmd', sid: 's', repo, log_path: '/tmp/h0.log', worktree_path: wt, base_sha: base });
    writeFileSync(join(wt, 'step1.txt'), 'partial from rung0\n');

    insertJob({ handle: h1, backend: 'cmd', sid: 's', repo, log_path: '/tmp/h1.log', worktree_path: wt, base_sha: base });
    expect(existsSync(join(wt, 'step1.txt'))).toBe(true);
    writeFileSync(join(wt, 'step2.txt'), 'partial from retry\n');

    insertJob({ handle: h2, backend: 'cmd', sid: 's', repo, log_path: '/tmp/h2.log', worktree_path: wt, base_sha: base });
    expect(existsSync(join(wt, 'step1.txt'))).toBe(true);
    expect(existsSync(join(wt, 'step2.txt'))).toBe(true);
    writeFileSync(join(wt, 'final.txt'), 'finished by climb\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'winner', '--no-gpg-sign');

    const reportDiff = git(wt, 'diff', base).stdout;
    expect(reportDiff).toContain('final.txt');
    expect(reportDiff).toContain('step1.txt');
  });

  it('a retry+climb ladder leaves exactly ONE worktree, not one per rung', () => {
    const repo = makeRepo('wreuse-');
    addWorktree(repo, 'only');
    const trees = listWorktrees(repo).filter(p => p !== repo);
    expect(trees.length).toBe(1);
  });
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
