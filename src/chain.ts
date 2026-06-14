import { appendLadder, chainLockPath, createChainLock, removeChainLock } from './state.ts';
import { LADDER, type Backend } from './backends.ts';
import { type RunResult } from './runner.ts';
import { launch, resumeLaunch } from './lifecycle.ts';

type LadderResult = { handle: string; status: string } | { status: 'exhausted'; note: string };

export type LadderDrivers = {
  runRung: (backend: Backend) => Promise<RunResult>;
  resumeRung: (handle: string) => Promise<RunResult>;
};

export function handleLadder(args: { sid: string; prompt: string; dir: string; timeout?: number }): LadderResult {
  const { sid, prompt, dir } = args;
  const timeoutMs = args.timeout ? args.timeout * 1000 : undefined;

  if (LADDER.length === 0) return { status: 'exhausted', note: 'no workers available' };

  createChainLock(sid);
  const timeoutSec = args.timeout;
  const first = launch(LADDER[0], prompt, dir, { sid, timeoutMs, completionLock: chainLockPath(sid) });
  const drivers: LadderDrivers = {
    runRung: (backend) => launch(backend, prompt, dir, { sid, timeoutMs }).promise,
    resumeRung: (handle) => resumeLaunch({ handle, prompt, dir, timeout: timeoutSec }).promise,
  };

  const chainPromise = runLadderChain(sid, first.promise, drivers)
    .catch((): RunResult => ({
      status: 'failed', exit_code: 1, backend: LADDER[0], handle: first.handle,
      resume_token: first.handle, repo: dir, log: '',
    }))
    .finally(() => removeChainLock(sid));

  void chainPromise;
  return { handle: first.handle, status: 'running' };
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
    if (result.status === 'done' || result.status === 'killed') return result;

    if (result.status === 'stopped' || result.status === 'timeout') {
      const r2 = await drivers.resumeRung(result.handle);
      appendLadder(sid, turn++, LADDER[i], r2.status);
      if (r2.status === 'done' || r2.status === 'killed') return r2;
      result = r2;
    }

    i++;
    if (i >= LADDER.length) return { ...result, status: 'exhausted' };
    result = await drivers.runRung(LADDER[i]);
    appendLadder(sid, turn++, LADDER[i], result.status);
  }
}