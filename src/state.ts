import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';

export const WORKERS_DIR = `${process.env.HOME}/.claude/workers`;

export function projectName(repo: string): string {
  const homePrefix = `${process.env.HOME}/`;
  let rel = repo;
  if (rel.startsWith(homePrefix)) {
    rel = rel.slice(homePrefix.length);
  }
  rel = rel.replace(/^\/+|\/+$/g, '');
  if (rel === '') return 'root';
  return rel.replace(/\//g, '-');
}
const LADDER_DIR = join(WORKERS_DIR, 'ladder');
mkdirSync(WORKERS_DIR, { recursive: true });
mkdirSync(LADDER_DIR, { recursive: true });

export function resolveHandleDir(handle: string): string | null {
  try {
    const entries = readdirSync(WORKERS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'ladder' && entry.name !== 'tmux') {
        const jobPath = join(WORKERS_DIR, entry.name, handle, 'job.json');
        try {
          readFileSync(jobPath, 'utf8');
          return join(WORKERS_DIR, entry.name, handle);
        } catch {}
      }
    }
  } catch {}
  return null;
}

export function handleDir(handle: string, repo?: string) {
  if (repo) return join(WORKERS_DIR, projectName(repo), handle);
  const resolved = resolveHandleDir(handle);
  return resolved ?? join(WORKERS_DIR, handle);
}
export function lockPath(handle: string, repo?: string) {
  return join(handleDir(handle, repo) ?? join(WORKERS_DIR, handle), '.lock');
}
export function logPath(handle: string, repo?: string) {
  return join(handleDir(handle, repo) ?? join(WORKERS_DIR, handle), 'run.log'); }
export function createLock(handle: string, repo?: string) { try { writeFileSync(lockPath(handle, repo ?? undefined), ''); } catch {} }
export function removeLock(handle: string, repo?: string) { try { unlinkSync(lockPath(handle, repo ?? undefined)); } catch {} }

function jobPathFn(handle: string, repo?: string): string {
  return join(handleDir(handle, repo) ?? join(WORKERS_DIR, handle), 'job.json');
}
export function ladderPath(sid: string)  { return join(LADDER_DIR, `${sid}.jsonl`); }

export type Job = {
  handle: string; backend: string; sid: string;
  worker_pid: number; resume_token: string; repo: string; started: string;
  finished?: string; stopped_at?: string; last_line?: string;
  status: string; model: string; task: string; log_path: string;
  kill_requested?: boolean;
};

export function insertJob(j: {
  handle: string; backend: string; sid: string;
  worker_pid?: number; resume_token?: string; repo: string; model?: string;
  task?: string; log_path: string;
}) {
  const job: Job = {
    handle: j.handle, backend: j.backend,
    sid: j.sid, worker_pid: j.worker_pid ?? 0,
    resume_token: j.resume_token ?? '', repo: j.repo,
    started: new Date().toISOString(), status: 'running',
    model: j.model ?? '', task: j.task ?? '', log_path: j.log_path,
  };
  mkdirSync(handleDir(j.handle, j.repo), { recursive: true });
  const jobPath = jobPathFn(j.handle, j.repo);
  const tmpPath = `${jobPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(job, null, 2));
  renameSync(tmpPath, jobPath);
  createLock(j.handle, j.repo);
}

export function updateJob(handle: string, fields: Partial<Job>) {
  const path = jobPathFn(handle);
  try {
    const job = JSON.parse(readFileSync(path, 'utf8'));
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ ...job, ...fields }, null, 2));
    renameSync(tmpPath, path);
  } catch {}
}

export function getJob(handle: string): Job | null {
  try { return JSON.parse(readFileSync(jobPathFn(handle), 'utf8')); }
  catch { return null; }
}

export function finalizeJob(handle: string, naturalStatus: string, extra?: Partial<Job>): string {
  const job = getJob(handle);
  if (!job) return naturalStatus;
  const final = naturalStatus === 'done' ? 'done' : (job.kill_requested ? 'killed' : naturalStatus);
  updateJob(handle, { status: final, finished: new Date().toISOString(), ...extra });
  removeLock(handle);
  return final;
}

export function getAllRunningJobs(): Job[] {
  try {
    return readdirSync(WORKERS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'ladder' && d.name !== 'tmux')
      .flatMap(d => {
        try {
          return readdirSync(join(WORKERS_DIR, d.name), { withFileTypes: true })
            .filter(h => h.isDirectory())
            .map(h => { try { return JSON.parse(readFileSync(join(WORKERS_DIR, d.name, h.name, 'job.json'), 'utf8')); } catch { return null; } });
        } catch { return []; }
      })
      .filter((j): j is Job => j?.status === 'running');
  } catch { return []; }
}

export function getRunningJobsForRepo(repo: string): Job[] {
  const project = projectName(repo);
  try {
    return readdirSync(join(WORKERS_DIR, project), { withFileTypes: true })
      .filter(h => h.isDirectory())
      .map(h => { try { return JSON.parse(readFileSync(join(WORKERS_DIR, project, h.name, 'job.json'), 'utf8')); } catch { return null; } })
      .filter((j): j is Job => j && (j.status === 'running' || j.status === 'stopped'));
  } catch { return []; }
}

export function appendLadder(sid: string, turn: number, worker: string, result: string) {
  appendFileSync(ladderPath(sid), JSON.stringify({ turn, worker, result, ts: new Date().toISOString() }) + '\n');
}

export function getLadderHistory(sid: string): { turn: number; worker: string; result: string }[] {
  try {
    return readFileSync(ladderPath(sid), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l));
  } catch { return []; }
}
