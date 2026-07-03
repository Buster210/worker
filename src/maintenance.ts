import { reapAgeMs } from "./env.ts";
import { FILE_CONFIG } from "./config.ts";
import {
  getAllRunningJobs,
  getAllRunningJobsFresh,
  getAllStoppedJobs,
  finalizeJob,
  workersDir,
  ownsWorktree,
  plansWorkerDir,
  isBareSpecName,
  retainMs,
  removeJobFromCache,
  readJobFileCached,
  pruneJobFileCache,
} from "./state.ts";
import { isProcessAlive, killProcessTree } from "./process.ts";
import { resolveStatus } from "./runner.ts";
import { removeWorktree } from "./worktree.ts";
import { SERVER_STARTED } from "./lifecycle.ts";
import { readFileSync, readdirSync, unlinkSync, statSync, rmSync } from "fs";
import { join } from "path";

const SELF_PID = process.pid;
const SELF_STARTED = SERVER_STARTED;

function reapWorktree(job: {
  handle: string;
  repo: string;
  worktree_path?: string;
}): void {
  // Owner-only: a ladder's retry/climb handles share the first rung's worktree — only its creator
  // may remove it (see ownsWorktree).
  if (ownsWorktree(job)) {
    try {
      removeWorktree(job.repo, job.worktree_path!);
    } catch {}
  }
}

export function sweepStaleJobs(opts?: { fresh?: boolean }) {
  const jobs = opts?.fresh ? getAllRunningJobsFresh() : getAllRunningJobs();
  for (const job of jobs) {
    const selfOwner =
      job.server_pid > 0 &&
      job.server_pid === SELF_PID &&
      job.server_started === SELF_STARTED;
    if (selfOwner) continue;
    // Never reap a job whose owning server is alive (live-owner guard — cross-session safety invariant)
    if (
      job.server_pid > 0 &&
      isProcessAlive(job.server_pid, job.server_started)
    )
      continue;

    if (job.server_pid > 0) {
      const workerAlive =
        job.worker_pid > 0 && isProcessAlive(job.worker_pid, job.started);
      if (workerAlive) {
        killProcessTree(job.worker_pid, "SIGKILL");
        finalizeJob(job.handle, "failed", { resume_token: job.resume_token });
      } else {
        // No stash restore here: sentinel "done" doesn't prove the commit
        // landed (server may have died pre-commit) — keep + surface instead.
        const status = resolveStatus(job.backend, 0, job.log_path, false);
        finalizeJob(
          job.handle,
          status === "done" ? status : "failed:server-restart",
        );
      }
      reapWorktree(job);
    } else {
      // Unknown owner (server_pid unset) — conservative: only clean if worker is dead
      const workerAlive =
        job.worker_pid > 0 && isProcessAlive(job.worker_pid, job.started);
      if (!workerAlive) {
        finalizeJob(job.handle, "failed:server-restart");
        reapWorktree(job);
      }
    }
  }
  if (jobs.length > 0) console.error(`[maintenance] sweep: ${jobs.length} stale job(s) scanned`);
}

export function reapStoppedJobs() {
  const now = Date.now();
  const maxAgeMs = reapAgeMs();
  for (const job of getAllStoppedJobs()) {
    if (!job.worker_pid) continue;
    if (!isProcessAlive(job.worker_pid, job.started)) {
      finalizeJob(job.handle, "failed:server-restart");
      continue;
    }
    const stoppedAt = Date.parse(job.stopped_at ?? "");
    if (!Number.isFinite(stoppedAt) || now - stoppedAt < maxAgeMs) continue;
    killProcessTree(job.worker_pid, "SIGKILL");
    // Deferred backstop re-kill. Guard with a pid-reuse-safe liveness check: if the
    // original worker already died (pid freed/recycled in the 5s window), skip — else
    // we could SIGKILL an unrelated process tree that inherited the pid.
    setTimeout(() => {
      if (isProcessAlive(job.worker_pid, job.started))
        killProcessTree(job.worker_pid, "SIGKILL");
    }, 5_000).unref?.();
    finalizeJob(job.handle, "timeout");
    reapWorktree(job);
  }
}

export function sweepChainLocks(): void {
  const ladderDir = join(workersDir(), "ladder");
  const removeChainPair = (lf: string) => {
    unlinkSync(lf);
    try {
      unlinkSync(lf.replace(/\.chain\.lock$/, ".chain.meta"));
    } catch {}
  };
  let entries: string[];
  try {
    entries = readdirSync(ladderDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".chain.lock")) continue;
    const lockFile = join(ladderDir, name);
    try {
      const content = readFileSync(lockFile, "utf8").trim();
      if (content) {
        const [pidStr, started] = content.split("\n");
        const pid = Number(pidStr);
        if (Number.isFinite(pid) && pid > 0) {
          if (!isProcessAlive(pid, started || undefined)) {
            removeChainPair(lockFile);
          }
          continue;
        }
      }
      const mtime = statSync(lockFile).mtimeMs;
      if (Date.now() - mtime > reapAgeMs()) {
        removeChainPair(lockFile);
      }
    } catch {}
  }
}

const TERMINAL_SWEEP_RE = /^(done|failed|timeout|killed|stalled)/;

export function sweepStaleWorkerDirs(): void {
  const root = workersDir();
  const skipSet = new Set(FILE_CONFIG.skip ?? []);
  const visited = new Set<string>();
  let cleaned = 0;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && d.name !== "ladder" && d.name !== "tmux",
      )
      .map((d) => d.name);
  } catch {
    return;
  }

  for (const proj of projectDirs) {
    let handleDirs: string[];
    try {
      handleDirs = readdirSync(join(root, proj), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const handle of handleDirs) {
      const dirPath = join(root, proj, handle);
      // Stat-keyed memo: unchanged job.json (the common case — terminal jobs
      // never rewrite) skips the read+parse entirely. Missing/unparsable → null,
      // same as the old catch path.
      const jobJsonPath = join(dirPath, "job.json");
      visited.add(jobJsonPath);
      const jobJson = readJobFileCached(jobJsonPath);

      const status = jobJson?.status ?? "";

      if (status && TERMINAL_SWEEP_RE.test(status)) {
        // User-inspectable mid-flight kills — preserve for debugging.
        if (status.startsWith("killed:")) continue;
        const backend = jobJson?.backend ?? "";
        if (skipSet.has(handle) || skipSet.has(backend)) continue;
        const ownerPid = jobJson?.server_pid ?? 0;
        const ownerStarted = jobJson?.server_started ?? "";
        if (
          ownerPid > 0 &&
          ownerPid !== SELF_PID &&
          isProcessAlive(ownerPid, ownerStarted)
        )
          continue;
        const finishedAt = Date.parse(jobJson?.finished ?? "");
        if (!Number.isFinite(finishedAt)) continue;
        if (Date.now() - finishedAt < retainMs()) continue;
        const specFile = jobJson?.spec_file ?? "";
        if (specFile && isBareSpecName(specFile)) {
          try {
            unlinkSync(join(plansWorkerDir(), specFile));
          } catch {}
        }
      } else if (!jobJson) {
        try {
          if (statSync(join(dirPath, ".lock")).isFile()) continue;
        } catch {}
      } else {
        continue;
      }

      try {
        rmSync(dirPath, { recursive: true, force: true });
      } catch {}
      removeJobFromCache(handle);
      cleaned++;
    }
  }

  // This sweep is the daemon's only periodic full scan, so it must also drop
  // memo entries for dirs that no longer exist (including ones it just removed).
  pruneJobFileCache(visited);

  if (cleaned > 0)
    console.error(
      `[worker] sweepStaleWorkerDirs: cleaned ${cleaned} stale dir(s)`,
    );
}
