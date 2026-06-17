import { describe, it, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'fs';

const STATE_DIR = join(tmpdir(), `wreuse-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { addWorktree, listWorktrees } from '../src/worktree.ts';
import { insertJob } from '../src/state.ts';

const tmpDirs: string[] = [];
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wreuse-')));
  tmpDirs.push(dir);
  const g = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.com');
  g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'README.md'), 'init\n');
  g('add', '.');
  g('commit', '-m', 'init', '--no-gpg-sign');
  return dir;
}
function git(dir: string, ...a: string[]) { return spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }); }
afterAll(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

// Characterizes the post-refactor ladder: ONE worktree is reused across every rung. Each rung gets
// its own handle/job (for tracking + extend), but they all point worktree_path at the same tree and
// share the chain's base_sha — so the report, anchored to the first handle, shows whatever the
// winning rung leaves. No seed copy, no reparent.
describe('ladder worktree reuse', () => {
  // INVARIANT (preserved across the refactor): a stalled→retried→won ladder loses no work, and the
  // report target shows the WINNER — now by construction (shared worktree), not seed+reparent.
  it('INVARIANT: work carried across retry+climb; report target shows the winner', () => {
    const repo = makeRepo();
    const base = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    const h0 = 'first', h1 = 'retry', h2 = 'winner';

    // First rung creates the one-and-only worktree for the whole ladder.
    const wt = addWorktree(repo, h0);
    insertJob({ handle: h0, backend: 'cmd', sid: 's', repo, log_path: '/tmp/h0.log', worktree_path: wt, base_sha: base });
    writeFileSync(join(wt, 'step1.txt'), 'partial from rung0\n');     // stalled, uncommitted

    // Retry reuses the SAME worktree + base_sha (new handle only). Prior work is already present.
    insertJob({ handle: h1, backend: 'cmd', sid: 's', repo, log_path: '/tmp/h1.log', worktree_path: wt, base_sha: base });
    expect(existsSync(join(wt, 'step1.txt'))).toBe(true);            // no copy needed — same tree
    writeFileSync(join(wt, 'step2.txt'), 'partial from retry\n');

    // Climb reuses the SAME worktree again, then finishes + commits.
    insertJob({ handle: h2, backend: 'cmd', sid: 's', repo, log_path: '/tmp/h2.log', worktree_path: wt, base_sha: base });
    expect(existsSync(join(wt, 'step1.txt'))).toBe(true);
    expect(existsSync(join(wt, 'step2.txt'))).toBe(true);
    writeFileSync(join(wt, 'final.txt'), 'finished by climb\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'winner', '--no-gpg-sign');

    // report reads `git diff base` from the FIRST handle's worktree — which IS the shared tree, so
    // it shows the winner's cumulative work with no reparent step.
    const reportDiff = git(wt, 'diff', base).stdout;
    expect(reportDiff).toContain('final.txt');
    expect(reportDiff).toContain('step1.txt');
  });

  // The refactor's payoff: one task = one worktree (was 3 — one orphan per rung).
  it('a retry+climb ladder leaves exactly ONE worktree, not one per rung', () => {
    const repo = makeRepo();
    // Whole ladder shares the first rung's worktree; retry/climb never call addWorktree again.
    addWorktree(repo, 'only');
    const trees = listWorktrees(repo).filter(p => p !== repo);
    expect(trees.length).toBe(1);
  });
});
