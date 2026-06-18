import { reapAgeMs } from './env.ts';
import { getAllRunningJobs, getAllRunningJobsFresh, getAllStoppedJobs, finalizeJob, workersDir, ownsWorktree } from './state.ts';
import { isProcessAlive, killProcessTree } from './process.ts'
import { resolveStatus } from './status.ts'
import { removeWorktree } from './worktree.ts';
import { SERVER_STARTED } from './lifecycle.ts';
import { readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

const SELF_PID = process.pid;
const SELF_STARTED = SERVER_STARTED;

function reapWorktree(job: { handle: string; repo: string; worktree_path?: string }): void {
  // Owner-only: a ladder's retry/climb handles share the first rung's worktree — only its creator
  // may remove it (see ownsWorktree).
  if (ownsWorktree(job)) {
    try { removeWorktree(job.repo, job.worktree_path!); } catch {}
  }
}

export function sweepStaleJobs(opts?: { fresh?: boolean }) {
  const jobs = opts?.fresh ? getAllRunningJobsFresh() : getAllRunningJobs();
  for (const job of jobs) {
    // Never reap a job we ourselves own (self-server guard)
    const selfOwner = job.server_pid > 0 && job.server_pid === SELF_PID && job.server_started === SELF_STARTED;
    if (selfOwner) continue;
    // Never reap a job whose owning server is alive (live-owner guard — cross-session safety invariant)
    if (job.server_pid > 0 && isProcessAlive(job.server_pid, job.server_started)) continue;

    if (job.server_pid > 0) {
      // Known dead owner — true orphan
      const workerAlive = job.worker_pid > 0 && isProcessAlive(job.worker_pid, job.started);
      if (workerAlive) {
        killProcessTree(job.worker_pid, 'SIGKILL');
        finalizeJob(job.handle, 'failed', { resume_token: job.resume_token });
      } else {
        const status = resolveStatus(job.backend, 0, job.log_path, false);
        finalizeJob(job.handle, status === 'done' ? status : 'failed:server-restart');
      }
      reapWorktree(job);
    } else {
      // Legacy / unknown owner (server_pid === 0) — conservative: only clean if worker is dead
      const workerAlive = job.worker_pid > 0 && isProcessAlive(job.worker_pid, job.started);
      if (!workerAlive) {
        finalizeJob(job.handle, 'failed:server-restart');
        reapWorktree(job);
      }
      // If worker is still alive, leave it — cannot safely attribute ownership
    }
  }
}

export function reapStoppedJobs() {
  const now = Date.now();
  const maxAgeMs = reapAgeMs();
  for (const job of getAllStoppedJobs()) {
    if (!job.worker_pid) continue;
    if (!isProcessAlive(job.worker_pid, job.started)) {
      finalizeJob(job.handle, 'failed:server-restart');
      continue;
    }
    const stoppedAt = Date.parse(job.stopped_at ?? '');
    if (!Number.isFinite(stoppedAt) || now - stoppedAt < maxAgeMs) continue;
    killProcessTree(job.worker_pid, 'SIGKILL');
    // Deferred backstop re-kill. Guard with a pid-reuse-safe liveness check: if the
    // original worker already died (pid freed/recycled in the 5s window), skip — else
    // we could SIGKILL an unrelated process tree that inherited the pid.
    setTimeout(() => {
      if (isProcessAlive(job.worker_pid, job.started)) killProcessTree(job.worker_pid, 'SIGKILL');
    }, 5_000).unref?.();
    finalizeJob(job.handle, 'timeout');
    reapWorktree(job);
  }
}

export function sweepChainLocks(): void {
  const ladderDir = join(workersDir(), 'ladder');
  let entries: string[];
  try { entries = readdirSync(ladderDir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith('.chain.lock')) continue;
    const lockFile = join(ladderDir, name);
    try {
      const content = readFileSync(lockFile, 'utf8').trim();
      if (content) {
        const [pidStr, started] = content.split('\n');
        const pid = Number(pidStr);
        if (Number.isFinite(pid) && pid > 0) {
          // Owner pid present — unlink only if owner is dead
          if (!isProcessAlive(pid, started || undefined)) {
            unlinkSync(lockFile);
            try { unlinkSync(lockFile.replace(/\.chain\.lock$/, '.chain.meta')); } catch {}
          }
          continue;
        }
      }
      // Empty or legacy lock (no parseable pid) — fall back to mtime TTL
      const mtime = statSync(lockFile).mtimeMs;
      if (Date.now() - mtime > reapAgeMs()) {
        unlinkSync(lockFile);
        try { unlinkSync(lockFile.replace(/\.chain\.lock$/, '.chain.meta')); } catch {}
      }
    } catch {
      // Swallow per-file errors
    }
  }
}
