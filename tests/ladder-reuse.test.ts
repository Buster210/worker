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


describe('ladder worktree reuse', () => {
  
  
  it('INVARIANT: work carried across retry+climb; report target shows the winner', () => {
    const repo = makeRepo();
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
    const repo = makeRepo();
    
    addWorktree(repo, 'only');
    const trees = listWorktrees(repo).filter(p => p !== repo);
    expect(trees.length).toBe(1);
  });
});
