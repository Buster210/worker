import { reapAgeMs } from './env.ts';
import { getAllRunningJobs, getAllStoppedJobs, getJob, finalizeJob } from './state.ts';
import { isProcessAlive, killProcessTree } from './process.ts'
import { resolveStatus } from './status.ts'
import { SERVER_STARTED } from './lifecycle.ts';

function thisServerSid(): string {
  return process.env.CLAUDE_CODE_SESSION_ID ?? '';
}

const SELF_PID = process.pid;
const SELF_STARTED = SERVER_STARTED;

export function sweepStaleJobs() {
  const sid = thisServerSid();
  for (const job of getAllRunningJobs()) {
    if (job.server_sid === '' || job.server_sid !== sid) continue;
    const selfOwner = job.server_pid > 0 && job.server_pid === SELF_PID && job.server_started === SELF_STARTED;
    if (selfOwner) continue;
    if (job.server_pid > 0 && isProcessAlive(job.server_pid, job.server_started)) continue;
    const workerAlive = job.worker_pid > 0 && isProcessAlive(job.worker_pid, job.started);
    if (workerAlive && job.server_pid > 0) {
      killProcessTree(job.worker_pid, 'SIGKILL');
      finalizeJob(job.handle, 'failed', { resume_token: job.resume_token });
    } else if (!workerAlive) {
      const status = resolveStatus(job.backend, 0, job.log_path, false);
      finalizeJob(job.handle, status === 'done' ? status : 'failed:server-restart');
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
    setTimeout(() => killProcessTree(job.worker_pid, 'SIGKILL'), 5_000).unref?.();
    finalizeJob(job.handle, 'timeout');
  }
}
