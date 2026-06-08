import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';

// Resolved lazily (not a load-time const) so tests can point WORKER_STATE_DIR at a
// throwaway dir per-case; the production default is unchanged. The dir tree is ensured
// once per distinct path, so the hot path stays an env read + Set lookup.
const _ensuredDirs = new Set<string>();
export function workersDir(): string {
  const dir = process.env.WORKER_STATE_DIR ?? `${process.env.HOME}/.claude/workers`;
  if (!_ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'ladder'), { recursive: true });
    _ensuredDirs.add(dir);
  }
  return dir;
}

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

export function resolveHandleDir(handle: string): string | null {
  try {
    const root = workersDir();
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'ladder' && entry.name !== 'tmux') {
        const jobPath = join(root, entry.name, handle, 'job.json');
        try {
          readFileSync(jobPath, 'utf8');
          return join(root, entry.name, handle);
        } catch {}
      }
    }
  } catch {}
  return null;
}

export function handleDir(handle: string, repo?: string) {
  if (repo) return join(workersDir(), projectName(repo), handle);
  const resolved = resolveHandleDir(handle);
  return resolved ?? join(workersDir(), handle);
}
export function lockPath(handle: string, repo?: string) {
  return join(handleDir(handle, repo), '.lock');
}
export function logPath(handle: string, repo?: string) {
  return join(handleDir(handle, repo), 'run.log'); }
export function createLock(handle: string, repo?: string) { try { writeFileSync(lockPath(handle, repo ?? undefined), ''); } catch {} }
export function removeLock(handle: string, repo?: string) { try { unlinkSync(lockPath(handle, repo ?? undefined)); } catch {} }

function jobPathFn(handle: string, repo?: string): string {
  return join(handleDir(handle, repo), 'job.json');
}
export function ladderPath(sid: string)  { return join(workersDir(), 'ladder', `${sid}.jsonl`); }

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
    const root = workersDir();
    return readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'ladder' && d.name !== 'tmux')
      .flatMap(d => {
        try {
          return readdirSync(join(root, d.name), { withFileTypes: true })
            .filter(h => h.isDirectory())
            .map(h => { try { return JSON.parse(readFileSync(join(root, d.name, h.name, 'job.json'), 'utf8')); } catch { return null; } });
        } catch { return []; }
      })
      .filter((j): j is Job => j?.status === 'running');
  } catch { return []; }
}

export function getRunningJobsForRepo(repo: string): Job[] {
  const project = projectName(repo);
  try {
    const root = workersDir();
    return readdirSync(join(root, project), { withFileTypes: true })
      .filter(h => h.isDirectory())
      .map(h => { try { return JSON.parse(readFileSync(join(root, project, h.name, 'job.json'), 'utf8')); } catch { return null; } })
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
