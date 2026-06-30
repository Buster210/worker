import {
  appendLadder,
  chainLockPath,
  createChainLock,
  removeChainLock,
  removeChainMeta,
  getJob,
  archiveSpec,
  saveChainMeta,
  loadChainMeta,
  restoreJobStash,
} from "./state.ts";
import { LADDER, type Backend } from "./backends.ts";
import { type RunResult } from "./runner.ts";
import { launch, SERVER_STARTED } from "./lifecycle.ts";
import { defaultTimeoutMs } from "./env.ts";
import { type SeedContext } from "./backends.ts";
import { randomUUID } from "crypto";

type LadderResult =
  | { handle: string; status: string; workdir: string }
  | { status: "exhausted"; note: string };

type LadderDrivers = {
  runRung: (backend: Backend, seed?: SeedContext) => Promise<RunResult>;
};

export function handleLadder(
  args: {
    mcpSid: string;
    prompt: string;
    dir: string;
    timeout?: number;
    complex?: boolean;
    specFile?: string;
  },
  deps: { launch?: typeof launch } = {},
): LadderResult {
  const { mcpSid, prompt, dir, complex, specFile } = args;
  const launchFn = deps.launch ?? launch;
  const chainId = randomUUID();
  const chainDeadlineAt =
    Date.now() + (args.timeout ? args.timeout * 1000 : defaultTimeoutMs());

  if (LADDER.length === 0) {
    console.error("[ladder] exhausted: no backends available");
    return { status: "exhausted", note: "no workers available" };
  }

  createChainLock(chainId, process.pid, SERVER_STARTED);
  saveChainMeta(chainId, { deadlineAt: chainDeadlineAt });
  const chainHandle = randomUUID();
  const first = launchFn(LADDER[0], prompt, dir, {
    mcpSid,
    complex,
    deadlineAt: chainDeadlineAt,
    completionLock: chainLockPath(chainId),
    handle: chainHandle,
    specFile,
  });
  const drivers: LadderDrivers = {
    // Every rung after the first reuses the shared chain handle (one job.json) and the first rung's
    // worktree + base_sha: the prior rung's work already lives in that tree, so the report
    // (anchored to the chain handle) surfaces whatever the winning rung leaves — no seed copy, no
    // reparent. insertJob overwrites the shared job.json on each rung start (failed→running),
    // so getJobFresh(handle) always reflects the active or terminal rung. The chain completion_lock
    // rides on each rung so worker_extend can detect it; the deadline is re-read fresh so those
    // bumps reach later rungs.
    runRung: (backend, seed) => {
      const firstJob = getJob(first.handle);
      if (!firstJob || !firstJob.worktree_path) {
        console.error(
          `[ladder] reuse worktree missing for chain ${chainId} (first handle ${first.handle}); rung ${backend} runs in a fresh tree, prior work not carried`,
        );
      } else if (!firstJob.base_sha) {
        console.error(
          `[ladder] reuse base_sha missing for chain ${chainId}; report diff for rung ${backend} anchored to current HEAD, may omit committed work`,
        );
      }
      return launchFn(backend, prompt, dir, {
        mcpSid,
        complex,
        handle: chainHandle,
        deadlineAt: effectiveChainDeadline(chainId, chainDeadlineAt),
        completionLock: chainLockPath(chainId),
        reuseWorktree: firstJob?.worktree_path,
        reuseBaseSha: firstJob?.base_sha,
        stashSha: firstJob?.stash_sha,
        stashState: firstJob?.stash_state,
        seed,
        specFile,
      }).promise;
    },
  };

  const chainPromise = runLadderChain(
    chainId,
    first.promise,
    drivers,
    chainDeadlineAt,
    chainHandle,
  )
    .catch((err: unknown): RunResult => {
      console.error(`[ladder] chain error: ${err instanceof Error ? err.message : err}`);
      return {
        status: "failed",
        exit_code: 1,
        backend: LADDER[0],
        handle: chainHandle,
        resume_token: chainHandle,
        repo: dir,
        log: "",
      };
    })
    .finally(() => {
      removeChainLock(chainId);
      removeChainMeta(chainId);
    });

  void chainPromise;
  return { handle: chainHandle, status: "running", workdir: first.workdir };
}

export async function runLadderChain(
  chainId: string,
  firstPromise: Promise<RunResult>,
  drivers: LadderDrivers,
  chainDeadlineAt: number,
  chainHandle = chainId,
): Promise<RunResult> {
  let i = 0;
  let turn = 1;
  let result = await firstPromise;
  appendLadder(chainId, turn++, LADDER[i], result.status);

  for (;;) {
    if (
      result.status === "done" ||
      result.status === "killed" ||
      result.status === "timeout"
    ) {
      if (result.status === "done") {
        archiveSpec(chainHandle);
        await restoreJobStash(chainHandle);
      }
      return result;
    }

    if (result.status === "stalled") {
      if (Date.now() >= effectiveChainDeadline(chainId, chainDeadlineAt))
        return { ...result, status: "timeout" };

      result = await drivers.runRung(LADDER[i], {
        priorBackend: LADDER[i],
        priorStatus: result.status,
      });
      appendLadder(chainId, turn++, LADDER[i], result.status);
      if (
        result.status === "done" ||
        result.status === "killed" ||
        result.status === "timeout"
      ) {
        if (result.status === "done") {
          archiveSpec(chainHandle);
          await restoreJobStash(chainHandle);
        }
        return result;
      }
    }

    i++;
    if (i >= LADDER.length) return { ...result, status: "exhausted" };
    if (Date.now() >= effectiveChainDeadline(chainId, chainDeadlineAt))
      return { ...result, status: "timeout" };

    result = await drivers.runRung(LADDER[i], {
      priorBackend: LADDER[i - 1],
      priorStatus: result.status,
    });
    appendLadder(chainId, turn++, LADDER[i], result.status);
    if (result.status === "done") {
      archiveSpec(chainHandle);
      await restoreJobStash(chainHandle);
      return result;
    }
  }
}

// The effective chain deadline reflects worker_extend bumps, which handleExtend writes to the
// .chain.meta sidecar. Fall back to the launch-time value if the sidecar is missing/unreadable.
export function effectiveChainDeadline(
  chainId: string,
  fallback: number,
): number {
  return loadChainMeta(chainId)?.deadlineAt ?? fallback;
}
