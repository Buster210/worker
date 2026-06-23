import { describe, it, expect, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';


const STATE_DIR_RAW = join(tmpdir(), `wworktree-state-${process.pid}`);
mkdirSync(STATE_DIR_RAW, { recursive: true });
const STATE_DIR = realpathSync(STATE_DIR_RAW);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { existsSync } from 'fs';
import { addWorktree, addWorktreeAsync, removeWorktree, listWorktrees, clearStaleIndexLock } from '../src/worktree.ts';


const REPO = realpathSync(mkdtempSync(join(tmpdir(), 'wworktree-repo-')));
spawnSync('git', ['init', '-q'], { cwd: REPO });
spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: REPO });
spawnSync('git', ['config', 'user.name', 'Test'], { cwd: REPO });
writeFileSync(join(REPO, 'README.md'), 'init\n');
spawnSync('git', ['add', '.'], { cwd: REPO });
spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: REPO });

const tmpDirs: string[] = [REPO, STATE_DIR];

afterAll(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

describe('addWorktree', () => {
  it('creates the worktree directory and registers it on the branch worker/<handle>', () => {
    const handle = 'test-handle-add';
    const path = addWorktree(REPO, handle);

    
    const listResult = spawnSync('git', ['-C', REPO, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    expect(listResult.stdout).toContain(path);
    expect(listResult.stdout).toContain(`worker/${handle}`);

    
    const statResult = spawnSync('test', ['-d', path]);
    expect(statResult.status).toBe(0);
  });

  it('throws if addWorktree is called twice with the same handle (branch conflict)', () => {
    const handle = 'test-handle-dupe';
    addWorktree(REPO, handle);
    expect(() => addWorktree(REPO, handle)).toThrow(/worktree add failed/);
  });
});

describe('addWorktreeAsync', () => {
  it('creates the worktree directory and registers it on the branch worker/<handle>', async () => {
    const handle = 'test-handle-async';
    const path = await addWorktreeAsync(REPO, handle);

    const listResult = spawnSync('git', ['-C', REPO, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    expect(listResult.stdout).toContain(path);
    expect(listResult.stdout).toContain(`worker/${handle}`);
  });

  it('rejects if called twice with the same handle (branch conflict)', async () => {
    const handle = 'test-handle-async-dupe';
    await addWorktreeAsync(REPO, handle);
    await expect(addWorktreeAsync(REPO, handle)).rejects.toThrow(/worktree add failed/);
  });
});

describe('listWorktrees', () => {
  it('returns at least the main worktree path', () => {
    const paths = listWorktrees(REPO);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    
    expect(paths.some(p => p === REPO)).toBe(true);
  });

  it('includes the worktree path after addWorktree', () => {
    const handle = 'test-handle-list';
    const wtPath = addWorktree(REPO, handle);
    const paths = listWorktrees(REPO);
    expect(paths).toContain(wtPath);
  });
});

describe('removeWorktree', () => {
  it('removes a worktree so it no longer appears in the list', () => {
    const handle = 'test-handle-remove';
    const wtPath = addWorktree(REPO, handle);

    
    let paths = listWorktrees(REPO);
    expect(paths).toContain(wtPath);

    removeWorktree(REPO, wtPath);

    
    paths = listWorktrees(REPO);
    expect(paths).not.toContain(wtPath);
  });

  it('is idempotent (swallows errors on double remove)', () => {
    const handle = 'test-handle-remove2';
    const wtPath = addWorktree(REPO, handle);
    removeWorktree(REPO, wtPath);
    
    expect(() => removeWorktree(REPO, wtPath)).not.toThrow();
  });
});

describe('clearStaleIndexLock', () => {
  it('removes a leftover index.lock from a worktree so the next rung can reuse it', () => {
    const handle = 'test-handle-lock';
    const wtPath = addWorktree(REPO, handle);
    
    const r = spawnSync('git', ['-C', wtPath, 'rev-parse', '--git-path', 'index.lock'], { encoding: 'utf8' });
    const rel = r.stdout.trim();
    const lock = rel.startsWith('/') ? rel : join(wtPath, rel);
    writeFileSync(lock, '');                    
    expect(existsSync(lock)).toBe(true);

    clearStaleIndexLock(wtPath);
    expect(existsSync(lock)).toBe(false);
  });

  it('is a no-op when there is no lock', () => {
    const handle = 'test-handle-nolock';
    const wtPath = addWorktree(REPO, handle);
    expect(() => clearStaleIndexLock(wtPath)).not.toThrow();
  });

  it('is a no-op when the path is not a git worktree', () => {
    expect(() => clearStaleIndexLock(join(tmpdir(), `not-a-repo-${process.pid}`))).not.toThrow();
  });
});
