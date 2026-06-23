import { describe, it, expect, afterAll, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Hermetic state dir — set BEFORE any state.ts import (lazy resolution).
const STATE_DIR_RAW = join(tmpdir(), `wcommit-state-${process.pid}`);
mkdirSync(STATE_DIR_RAW, { recursive: true });
const STATE_DIR = realpathSync(STATE_DIR_RAW);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { maybeVerifyAndCommit } from '../src/commit.ts';
import { insertJob, updateJob, finalizeJob, getJobFresh } from '../src/state.ts';
import { resolveStatus } from '../src/status.ts';
import { renderReport } from '../src/report.ts';

// ---------------------------------------------------------------------------
// Shared real git repo: init + initial commit so HEAD exists.
// realpathSync resolves /var → /private/var on macOS so paths match git output.
// ---------------------------------------------------------------------------
const REPO_RAW = mkdtempSync(join(tmpdir(), 'wcommit-repo-'));
const REPO = realpathSync(REPO_RAW);

function git(...args: string[]) {
  return spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
}

git('init', '-q');
git('config', 'user.email', 'test@test.com');
git('config', 'user.name', 'Test');
writeFileSync(join(REPO, 'README.md'), 'init\n');
git('add', '.');
git('commit', '-m', 'init', '--no-gpg-sign');

const tmpDirs: string[] = [REPO, STATE_DIR];

afterAll(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

// ---------------------------------------------------------------------------
// Helper: seed a job in the state store
// ---------------------------------------------------------------------------
let seq = 0;
function seedJob(task = 'test task'): string {
  const handle = `commit-${process.pid}-${seq++}`;
  insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: '/tmp/commit-test.log', task });
  return handle;
}

// ---------------------------------------------------------------------------
// Helper: count git commits in REPO
// ---------------------------------------------------------------------------
function commitCount(dir: string = REPO): number {
  const r = spawnSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' });
  return parseInt(r.stdout.trim(), 10);
}

// ---------------------------------------------------------------------------
// Helper: check working tree is clean
// ---------------------------------------------------------------------------
function isClean(dir: string = REPO): boolean {
  const r = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  return r.stdout.trim() === '';
}

// ---------------------------------------------------------------------------
// Capture base SHA before each test that mutates the repo
// ---------------------------------------------------------------------------
function baseSha(dir: string = REPO): string {
  return spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('maybeVerifyAndCommit — pass-through on non-done', () => {
  it('returns "failed" unchanged, makes no commit', () => {
    const handle = seedJob();
    const before = commitCount();
    // Dirty the tree
    writeFileSync(join(REPO, `dirty-${seq}.txt`), 'x\n');
    const result = maybeVerifyAndCommit(handle, REPO, 'failed');
    expect(result).toBe('failed');
    expect(commitCount()).toBe(before);
  });

  it('returns "timeout" unchanged, makes no commit', () => {
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `dirty-${seq}.txt`), 'x\n');
    const result = maybeVerifyAndCommit(handle, REPO, 'timeout');
    expect(result).toBe('timeout');
    expect(commitCount()).toBe(before);
  });
});

describe('maybeVerifyAndCommit — commits on done', () => {
  it('with a dirty tree: makes exactly ONE commit, returns "done", working tree is clean', () => {
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `change-${seq}.txt`), 'hello\n');
    const result = maybeVerifyAndCommit(handle, REPO, 'done');
    expect(result).toBe('done');
    expect(commitCount()).toBe(before + 1);
    expect(isClean()).toBe(true);
  });

  it('with nothing to commit (already clean): returns "failed:no-changes" and makes no commit', () => {
    const before = commitCount();
    const handle = seedJob();
    const result = maybeVerifyAndCommit(handle, REPO, 'done');
    expect(result).toBe('failed:no-changes');
    expect(commitCount()).toBe(before);
  });
});

describe('maybeVerifyAndCommit — WORKER_VERIFY_CMD gate', () => {
  let origVerifyCmd: string | undefined;

  beforeEach(() => { origVerifyCmd = process.env.WORKER_VERIFY_CMD; });
  afterEach(() => {
    if (origVerifyCmd === undefined) delete process.env.WORKER_VERIFY_CMD;
    else process.env.WORKER_VERIFY_CMD = origVerifyCmd;
  });

  it('WORKER_VERIFY_CMD="exit 1" on done → returns "failed:verify", NO commit', () => {
    process.env.WORKER_VERIFY_CMD = 'exit 1';
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `verify-fail-${seq}.txt`), 'x\n');
    const result = maybeVerifyAndCommit(handle, REPO, 'done');
    expect(result).toBe('failed:verify');
    expect(commitCount()).toBe(before);
  });

  it('WORKER_VERIFY_CMD="true" on done → commits, returns "done"', () => {
    process.env.WORKER_VERIFY_CMD = 'true';
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `verify-pass-${seq}.txt`), 'y\n');
    const result = maybeVerifyAndCommit(handle, REPO, 'done');
    expect(result).toBe('done');
    expect(commitCount()).toBe(before + 1);
  });

  it('unset WORKER_VERIFY_CMD on done → skips verify, commits, returns "done"', () => {
    delete process.env.WORKER_VERIFY_CMD;
    const handle = seedJob();
    const before = commitCount();
    writeFileSync(join(REPO, `verify-unset-${seq}.txt`), 'z\n');
    const result = maybeVerifyAndCommit(handle, REPO, 'done');
    expect(result).toBe('done');
    expect(commitCount()).toBe(before + 1);
  });
});

describe('maybeVerifyAndCommit — excludes .codegraph', () => {
  it('does not commit the .codegraph symlink when real changes exist', () => {
    const handle = seedJob('codegraph exclusion test');
    const before = commitCount();
    const fileName = `codegraph-${seq}.txt`;
    writeFileSync(join(REPO, fileName), 'real change\n');
    symlinkSync(REPO, join(REPO, '.codegraph'));

    const result = maybeVerifyAndCommit(handle, REPO, 'done');
    expect(result).toBe('done');
    expect(commitCount()).toBe(before + 1);

    const show = spawnSync('git', ['-C', REPO, 'show', '--pretty=format:', '--name-only', 'HEAD'], { encoding: 'utf8' });
    expect(show.stdout).toContain(fileName);
    expect(show.stdout).not.toContain('.codegraph');

    unlinkSync(join(REPO, '.codegraph'));
  });
});

describe('base-ref diff — committed work still surfaces', () => {
  it('plain git diff is empty after commit but base-ref diff shows the change', () => {
    // Capture base before making a change
    const base = baseSha();
    const handle = seedJob('base-ref test');
    // Make a change and commit it via maybeVerifyAndCommit
    const fileName = `base-ref-${seq}.txt`;
    writeFileSync(join(REPO, fileName), 'committed content\n');
    const result = maybeVerifyAndCommit(handle, REPO, 'done');
    expect(result).toBe('done');
    expect(isClean()).toBe(true);

    // Plain git diff of working tree → empty
    const plainDiff = spawnSync('git', ['-C', REPO, 'diff'], { encoding: 'utf8' });
    expect(plainDiff.stdout.trim()).toBe('');

    // Base-ref diff → shows the committed change
    const baseDiff = spawnSync('git', ['-C', REPO, 'diff', base], { encoding: 'utf8' });
    expect(baseDiff.stdout).toContain(fileName);
    expect(baseDiff.stdout).toContain('committed content');
  });

  it('renderReport with base_sha on a done job passes base_sha to the diff fn', () => {
    const base = baseSha();

    // Seed a job with base_sha so renderReport picks it up via getJobFresh
    const handle = `commit-render-${process.pid}-${seq++}`;
    insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: '/tmp/x.log', task: 'render base_sha test', base_sha: base });
    updateJob(handle, { status: 'done', finished: new Date().toISOString(), worktree_path: REPO, base_sha: base });

    // Inject a spy diff fn; renderReport should forward base_sha as the second argument
    let capturedBaseSha: string | undefined = 'NOT_CALLED';
    renderReport(handle, `/any/${handle}/.lock`, (_repo, sha) => {
      capturedBaseSha = sha;
      return 'DIFFBODY';
    });
    expect(capturedBaseSha).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Integration: the REAL wired completion sequence against a REAL git worktree.
// Drives the exact path lifecycle.launch() uses on a green clean exit —
//   finalizeJob(handle, maybeVerifyAndCommit(handle, wt, resolveStatus(...)), ...)
// — through resolveStatus (empty log + rc 0 → 'done'), and asserts the commit
// actually lands on the worktree and the base-ref diff surfaces the committed work.
// Self-contained temp repo so no other test's shared REPO is touched.
// ---------------------------------------------------------------------------
describe('integration — wired completion sequence commits on a real worktree', () => {
  it('resolveStatus done → maybeVerifyAndCommit → finalizeJob lands one commit, base-ref diff shows it', () => {
    // Dedicated real git repo used directly as the worker's worktree dir.
    const WT = realpathSync(mkdtempSync(join(tmpdir(), 'wcommit-wt-')));
    tmpDirs.push(WT);
    const g = (...a: string[]) => spawnSync('git', ['-C', WT, ...a], { encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'test@test.com');
    g('config', 'user.name', 'Test');
    writeFileSync(join(WT, 'README.md'), 'init\n');
    g('add', '.');
    g('commit', '-m', 'init', '--no-gpg-sign');

    // Mirror lifecycle.launch(): capture base_sha at worktree creation.
    const base = g('rev-parse', 'HEAD').stdout.trim();

    // An empty log → readSentinel returns null → resolveStatus('cmd', 0, ..., false) === 'done'.
    const emptyLog = join(WT, 'run.log');
    writeFileSync(emptyLog, '');

    const handle = `commit-integ-${process.pid}-${seq++}`;
    insertJob({ handle, backend: 'cmd', sid: 'test', repo: WT, worktree_path: WT, base_sha: base, log_path: emptyLog, task: 'integration wired commit' });

    // Dirty the worktree as a real worker would.
    writeFileSync(join(WT, 'feature.txt'), 'real work product\n');
    // EXACT wired completion sequence (lifecycle.launch non-stopped branch).
    const before = commitCount(WT);

    const natural = resolveStatus('cmd', 0, emptyLog, false);
    expect(natural).toBe('done');
    const gated = maybeVerifyAndCommit(handle, WT, natural);
    const status = finalizeJob(handle, gated, { resume_token: '' });

    // The harness committed exactly one revertable commit, tree is clean, status stays done.
    expect(status).toBe('done');
    expect(commitCount(WT)).toBe(before + 1);
    expect(isClean(WT)).toBe(true);

    // Plain working-tree diff is empty post-commit; base-ref diff still surfaces the work.
    expect(spawnSync('git', ['-C', WT, 'diff'], { encoding: 'utf8' }).stdout.trim()).toBe('');
    const baseDiff = spawnSync('git', ['-C', WT, 'diff', base], { encoding: 'utf8' });
    expect(baseDiff.stdout).toContain('feature.txt');
    expect(baseDiff.stdout).toContain('real work product');

    // And the job record carries the base_sha that renderReport diffs against.
    expect(getJobFresh(handle)?.base_sha).toBe(base);
  });
});
