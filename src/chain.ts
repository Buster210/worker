import { appendLadder, chainLockPath, createChainLock, removeChainLock, removeChainMeta, getJob, saveChainMeta, loadChainMeta } from './state.ts';
import { LADDER, type Backend } from './backends.ts';
import { type RunResult } from './runner.ts';
import { launch, SERVER_STARTED } from './lifecycle.ts';
import { defaultTimeoutMs } from './env.ts';
import { type SeedContext } from './seed.ts';

type LadderResult = { handle: string; status: string } | { status: 'exhausted'; note: string };

export type LadderDrivers = {
  // seed carries only the PRIOR rung's context for the continuation preamble — the prior work itself
  // already lives in the shared worktree (reuse), so there is no copy.
  runRung: (backend: Backend, seed?: SeedContext) => Promise<RunResult>;
};

export function handleLadder(args: { sid: string; prompt: string; dir: string; timeout?: number }): LadderResult {
  const { sid, prompt, dir } = args;
  const chainDeadlineAt = Date.now() + (args.timeout ? args.timeout * 1000 : defaultTimeoutMs());

  if (LADDER.length === 0) return { status: 'exhausted', note: 'no workers available' };

  createChainLock(sid, process.pid, SERVER_STARTED);
  saveChainMeta(sid, { deadlineAt: chainDeadlineAt });
  const first = launch(LADDER[0], prompt, dir, { sid, deadlineAt: chainDeadlineAt, completionLock: chainLockPath(sid) });
  const drivers: LadderDrivers = {
    // Every rung after the first reuses the first rung's worktree + base_sha: the prior rung's work
    // already lives in that tree, so the report (anchored to the first handle) surfaces whatever the
    // winning rung leaves — no seed copy, no reparent. The chain completion_lock rides on each rung
    // so worker_extend can detect it; the deadline is re-read fresh so those bumps reach later rungs.
    runRung: (backend, seed) => {
      const firstJob = getJob(first.handle);
      if (!firstJob || !firstJob.worktree_path) {
        console.error(`[ladder] reuse worktree missing for chain ${sid} (first handle ${first.handle}); rung ${backend} runs in a fresh tree, prior work not carried`);
      } else if (!firstJob.base_sha) {
        console.error(`[ladder] reuse base_sha missing for chain ${sid}; report diff for rung ${backend} anchored to current HEAD, may omit committed work`);
      }
      return launch(backend, prompt, dir, {
        sid,
        deadlineAt: effectiveChainDeadline(sid, chainDeadlineAt),
        completionLock: chainLockPath(sid),
        reuseWorktree: firstJob?.worktree_path,
        reuseBaseSha: firstJob?.base_sha,
        seed,
      }).promise;
    },
  };

  const chainPromise = runLadderChain(sid, first.promise, drivers, chainDeadlineAt)
    .catch((): RunResult => ({
      status: 'failed', exit_code: 1, backend: LADDER[0], handle: first.handle,
      resume_token: first.handle, repo: dir, log: '',
    }))
    .finally(() => { removeChainLock(sid); removeChainMeta(sid); });

  void chainPromise;
  return { handle: first.handle, status: 'running' };
}

export async function runLadderChain(
  sid: string,
  firstPromise: Promise<RunResult>,
  drivers: LadderDrivers,
  chainDeadlineAt: number,
): Promise<RunResult> {
  let i = 0;
  let turn = 1;
  let result = await firstPromise;
  appendLadder(sid, turn++, LADDER[i], result.status);

  for (;;) {
    // timeout is terminal: deadline+grace expired with no extend → no retry, no climb.
    if (result.status === 'done' || result.status === 'killed' || result.status === 'timeout') return result;

    if (result.status === 'stalled') {
      // one fresh re-run of the SAME backend, reusing the chain's shared worktree (prior work is
      // already in it — handleLadder threads reuseWorktree/reuseBaseSha into each rung)
      if (Date.now() >= effectiveChainDeadline(sid, chainDeadlineAt)) return { ...result, status: 'timeout' };

      result = await drivers.runRung(LADDER[i], { priorBackend: LADDER[i], priorStatus: result.status });
      appendLadder(sid, turn++, LADDER[i], result.status);
      if (result.status === 'done' || result.status === 'killed' || result.status === 'timeout') return result;
    }

    i++;
    if (i >= LADDER.length) return { ...result, status: 'exhausted' };
    if (Date.now() >= effectiveChainDeadline(sid, chainDeadlineAt)) return { ...result, status: 'timeout' };

    result = await drivers.runRung(LADDER[i], { priorBackend: LADDER[i - 1], priorStatus: result.status });
    appendLadder(sid, turn++, LADDER[i], result.status);
  }
}

// The effective chain deadline reflects worker_extend bumps, which handleExtend writes to the
// .chain.meta sidecar. Fall back to the launch-time value if the sidecar is missing/unreadable.
export function effectiveChainDeadline(sid: string, fallback: number): number {
  return loadChainMeta(sid)?.deadlineAt ?? fallback;
}
