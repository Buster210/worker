import { spawnSync } from 'child_process';
import { getJob } from './state.ts';

function commitWork(worktree: string, handle: string): void {
  const task = getJob(handle)?.task ?? '';
  const firstLine = task.split('\n')[0].replace(/\n/g, '').trim();
  const msg = firstLine ? `worker: ${firstLine}`.slice(0, 72) : 'worker: automated change';

  const add = spawnSync('git', ['-C', worktree, 'add', '-A'], { encoding: 'utf8', timeout: 30_000 });
  if (add.error) {
    console.error(`[commit] git add -A failed for ${handle}: ${add.error.message}`);
    return;
  }

  const commit = spawnSync('git', ['-C', worktree, 'commit', '-m', msg], { encoding: 'utf8', timeout: 60_000 });
  if (commit.status !== 0) {
    // Best-effort: nothing to commit (already committed, no changes, hook rejected) → swallow.
    console.error(`[commit] git commit no-op or failed for ${handle}: ${commit.stderr?.trim() ?? ''}`);
  }
}

export function maybeVerifyAndCommit(handle: string, worktree: string, natural: string): string {
  if (natural !== 'done') return natural;

  const cmd = process.env.WORKER_VERIFY_CMD;
  if (cmd && cmd.length > 0) {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const result = spawnSync(shell, ['-c', cmd], { cwd: worktree, timeout: 120_000, stdio: 'ignore' });
    if (result.status !== 0 || result.error) {
      console.error(`[commit] verify gate failed for ${handle}: exit ${result.status ?? 'error'}`);
      return 'failed:verify';
    }
  }

  commitWork(worktree, handle);
  return 'done';
}
