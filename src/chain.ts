import { spawnSync } from 'child_process';
import { appendLadder, chainLockPath, createChainLock, removeChainLock, getJob } from './state.ts';
import { LADDER, type Backend } from './backends.ts';
import { type RunResult } from './runner.ts';
import { launch, SERVER_STARTED } from './lifecycle.ts';

type LadderResult = { handle: string; status: string } | { status: 'exhausted'; note: string };

export type LadderDrivers = {
  runRung: (backend: Backend) => Promise<RunResult>;
};

export function handleLadder(args: { sid: string; prompt: string; dir: string; timeout?: number }): LadderResult {
  const { sid, prompt, dir } = args;
  const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;

  if (LADDER.length === 0) return { status: 'exhausted', note: 'no workers available' };

  createChainLock(sid, process.pid, SERVER_STARTED);
  const first = launch(LADDER[0], prompt, dir, { sid, timeoutMs, completionLock: chainLockPath(sid) });
  const drivers: LadderDrivers = {
    runRung: (backend) => launch(backend, prompt, dir, { sid, timeoutMs }).promise,
  };

  const chainPromise = runLadderChain(sid, first.promise, drivers)
    .then(result => {
      reparentWinningCommit(dir, first.handle, result);
      return result;
    })
    .catch((): RunResult => ({
      status: 'failed', exit_code: 1, backend: LADDER[0], handle: first.handle,
      resume_token: first.handle, repo: dir, log: '',
    }))
    .finally(() => removeChainLock(sid));

  void chainPromise;
  return { handle: first.handle, status: 'running' };
}

export function reparentWinningCommit(dir: string, firstHandle: string, result: RunResult): void {
  try {
    if (result.status !== 'done' || result.handle === firstHandle) return;
    const winnerWt = getJob(result.handle)?.worktree_path;
    const firstWt = getJob(firstHandle)?.worktree_path;
    if (!winnerWt || !firstWt) {
      console.error(`[chain] reparent skipped for ${firstHandle} in ${dir}: missing worktree path(s)`);
      return;
    }

    const winnerSha = spawnSync('git', ['-C', winnerWt, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
    if (winnerSha.error || winnerSha.status !== 0) {
      console.error(`[chain] failed to read winner SHA for ${result.handle} in ${dir}: ${winnerSha.error?.message ?? winnerSha.stderr?.trim() ?? ''}`);
      return;
    }

    const sha = winnerSha.stdout.trim();
    if (!sha) {
      console.error(`[chain] empty winner SHA for ${result.handle} in ${dir}`);
      return;
    }

    const reset = spawnSync('git', ['-C', firstWt, 'reset', '--hard', sha], { encoding: 'utf8', timeout: 30_000 });
    if (reset.error || reset.status !== 0) {
      console.error(`[chain] failed to reparent ${firstHandle} to ${sha} in ${dir}: ${reset.error?.message ?? reset.stderr?.trim() ?? ''}`);
    }
  } catch (err) {
    console.error(`[chain] reparentWinningCommit failed for ${firstHandle} in ${dir}: ${(err as Error).message}`);
  }
}

export async function runLadderChain(
  sid: string,
  firstPromise: Promise<RunResult>,
  drivers: LadderDrivers,
): Promise<RunResult> {
  let i = 0;
  let turn = 1;
  let result = await firstPromise;
  appendLadder(sid, turn++, LADDER[i], result.status);

  for (;;) {
    // timeout is terminal: deadline+grace expired with no extend → no retry, no climb.
    if (result.status === 'done' || result.status === 'killed' || result.status === 'timeout') return result;

    if (result.status === 'stalled') {
      // one fresh re-run of the SAME backend (new worktree, no resume)
      result = await drivers.runRung(LADDER[i]);
      appendLadder(sid, turn++, LADDER[i], result.status);
      if (result.status === 'done' || result.status === 'killed' || result.status === 'timeout') return result;
    }

    i++;
    if (i >= LADDER.length) return { ...result, status: 'exhausted' };
    result = await drivers.runRung(LADDER[i]);
    appendLadder(sid, turn++, LADDER[i], result.status);
  }
}
