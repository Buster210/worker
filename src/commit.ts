import { spawnSync } from 'child_process';
import { getJob } from './state.ts';
import { FILE_CONFIG } from './config.ts';

function commitMessage(handle: string): string {
  const task = getJob(handle)?.task ?? '';
  const firstLine = task.split('\n')[0].replace(/\n/g, '').trim();
  return firstLine ? `worker: ${firstLine}`.slice(0, 72) : 'worker: automated change';
}

function stageWorktree(worktree: string, handle: string): 'ok' | 'failed:commit' {
  const add = spawnSync('git', ['-C', worktree, 'add', '-A', '--', '.', ':(exclude).codegraph'], { encoding: 'utf8', timeout: 30_000 });
  if (add.error) {
    console.error(`[commit] git add failed for ${handle}: ${add.error.message}`);
    return 'failed:commit';
  }
  if (add.status !== 0) {
    console.error(`[commit] git add failed for ${handle}: ${add.stderr?.trim() ?? ''}`);
    return 'failed:commit';
  }
  return 'ok';
}

function hasStagedChanges(worktree: string): 'yes' | 'no' | 'failed:commit' {
  const diff = spawnSync('git', ['-C', worktree, 'diff', '--cached', '--quiet'], { encoding: 'utf8', timeout: 30_000 });
  if (diff.error) {
    console.error(`[commit] git diff --cached --quiet failed: ${diff.error.message}`);
    return 'failed:commit';
  }
  return diff.status === 0 ? 'no' : 'yes';
}

function commitWork(worktree: string, handle: string): 'done' | 'failed:commit' | 'failed:no-changes' {
  const staged = stageWorktree(worktree, handle);
  if (staged !== 'ok') return staged;
  const stagedChanges = hasStagedChanges(worktree);
  if (stagedChanges === 'failed:commit') return 'failed:commit';
  if (stagedChanges === 'no') return 'failed:no-changes';

  const commit = spawnSync('git', ['-C', worktree, 'commit', '-m', commitMessage(handle)], { encoding: 'utf8', timeout: 60_000 });
  if (commit.error) {
    console.error(`[commit] git commit failed for ${handle}: ${commit.error.message}`);
    return 'failed:commit';
  }
  if (commit.status !== 0) {
    console.error(`[commit] git commit failed for ${handle}: ${commit.stderr?.trim() ?? ''}`);
    return 'failed:commit';
  }
  return 'done';
}

export function maybeVerifyAndCommit(handle: string, worktree: string, natural: string): string {
  if (natural !== 'done') return natural;

  const cmd = process.env.WORKER_VERIFY_CMD ?? FILE_CONFIG.verifyCmd;
  if (cmd && cmd.length > 0) {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const result = spawnSync(shell, ['-c', cmd], { cwd: worktree, timeout: 120_000, stdio: 'ignore' });
    if (result.status !== 0 || result.error) {
      console.error(`[commit] verify gate failed for ${handle}: exit ${result.status ?? 'error'}`);
      return 'failed:verify';
    }
  }

  return commitWork(worktree, handle);
}
