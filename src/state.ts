import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, unlinkSync, renameSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

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

const _jobs = new Map<string, Job>();
let _jobsBootstrapped = false;

function ensureBootstrapped(): void {
  if (_jobsBootstrapped) return;
  _jobsBootstrapped = true;
  for (const j of scanAllJobs()) _jobs.set(j.handle, j);
}

function projectName(repo: string): string {
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
        const dir = join(root, entry.name, handle);
        if (existsSync(join(dir, 'job.json'))) return dir;
      }
    }
  } catch {}
  return null;
}

const _handleDirCache = new Map<string, string>();

export function handleDir(handle: string, repo?: string): string {
  if (repo) {
    const dir = join(workersDir(), projectName(repo), handle);
    _handleDirCache.set(handle, dir);
    return dir;
  }
  const cached = _handleDirCache.get(handle);
  if (cached) return cached;
  const resolved = resolveHandleDir(handle);
  if (resolved) _handleDirCache.set(handle, resolved);
  return resolved ?? join(workersDir(), handle);
}
export function lockPath(handle: string, repo?: string) {
  return join(handleDir(handle, repo), '.lock');
}
export function logPath(handle: string, repo?: string) {
  return join(handleDir(handle, repo), 'run.log'); }
export function createLock(handle: string, repo?: string) { try { writeFileSync(lockPath(handle, repo ?? undefined), ''); } catch {} }
export function removeLock(handle: string, repo?: string) { try { unlinkSync(lockPath(handle, repo ?? undefined)); } catch {} }

function jobJsonPath(handle: string, repo?: string): string {
  return join(handleDir(handle, repo), 'job.json');
}
function ladderPath(sid: string)  { return join(workersDir(), 'ladder', `${sid}.jsonl`); }

export function chainLockPath(sid: string) { return join(workersDir(), 'ladder', `${sid}.chain.lock`); }
export function createChainLock(sid: string) { try { writeFileSync(chainLockPath(sid), ''); } catch {} }
export function removeChainLock(sid: string) { try { unlinkSync(chainLockPath(sid)); } catch {} }

export type Job = {
  handle: string; backend: string; sid: string;
  worker_pid: number; resume_token: string; repo: string; started: string;
  finished?: string; stopped_at?: string; last_line?: string;
  status: string; model: string; task: string; log_path: string;
  completion_lock: string;
  kill_requested?: boolean;
  server_pid: number;
  server_started: string;
  server_sid: string;
};

export function insertJob(j: {
  handle: string; backend: string; sid: string;
  worker_pid?: number; resume_token?: string; repo: string; model?: string;
  task?: string; log_path: string; completion_lock?: string;
  server_pid?: number; server_started?: string; server_sid?: string;
}) {
  const job: Job = {
    handle: j.handle, backend: j.backend,
    sid: j.sid, worker_pid: j.worker_pid ?? 0,
    resume_token: j.resume_token ?? '', repo: j.repo,
    started: new Date().toISOString(), status: 'running',
    model: j.model ?? '', task: j.task ?? '', log_path: j.log_path,
    completion_lock: j.completion_lock ?? lockPath(j.handle, j.repo),
    server_pid: j.server_pid ?? 0,
    server_started: j.server_started ?? '',
    server_sid: j.server_sid ?? '',
  };
  mkdirSync(handleDir(j.handle, j.repo), { recursive: true });
  _jobs.set(job.handle, job);
  const jobPath = jobJsonPath(j.handle, j.repo);
  const tmpPath = `${jobPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(job));
  renameSync(tmpPath, jobPath);
  createLock(j.handle, j.repo);
}

export function updateJob(handle: string, fields: Partial<Job>) {
  ensureBootstrapped();
  const current = _jobs.get(handle);
  if (!current) return;
  let changed = false;
  for (const k in fields) {
    if ((current as Record<string, unknown>)[k] !== (fields as Record<string, unknown>)[k]) { changed = true; break; }
  }
  if (!changed) return;
  const merged = { ...current, ...fields };
  _jobs.set(handle, merged);
  const path = jobJsonPath(handle);
  try {
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(merged));
    renameSync(tmpPath, path);
  } catch {}
}

export function getJob(handle: string): Job | null {
  ensureBootstrapped();
  const cached = _jobs.get(handle);
  if (cached) return cached;
  try {
    const job = JSON.parse(readFileSync(jobJsonPath(handle), 'utf8')) as Job;
    _jobs.set(handle, job);
    return job;
  } catch {
    return null;
  }
}

export function getJobFresh(handle: string): Job | null {
  try { return JSON.parse(readFileSync(jobJsonPath(handle), 'utf8')) as Job; }
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

function scanAllJobs(): Job[] {
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
      .filter((j): j is Job => j != null);
  } catch { return []; }
}

function collectJobs(predicate: (j: Job) => boolean): Job[] {
  ensureBootstrapped();
  const out: Job[] = [];
  for (const j of _jobs.values()) if (predicate(j)) out.push(j);
  return out;
}

export function getAllRunningJobs(): Job[] { return collectJobs(j => j.status === 'running'); }
export function getAllStoppedJobs(): Job[] { return collectJobs(j => j.status === 'stopped'); }
export function getAllJobs(): Job[] { ensureBootstrapped(); return Array.from(_jobs.values()); }

export function getRunningJobsForRepo(repo: string): Job[] {
  return collectJobs(j => (j.status === 'running' || j.status === 'stopped') && j.repo === repo);
}

function retainMs(): number {
  const v = Number(process.env.WORKER_RETAIN_MS);
  return Number.isFinite(v) && v > 0 ? v : 604_800_000;
}
const TERMINAL_RE = /^(done|failed|timeout|killed)/;

export function pruneOldJobs(now: number = Date.now()): number {
  ensureBootstrapped();
  const cutoff = now - retainMs();
  let pruned = 0;
  for (const job of _jobs.values()) {
    if (!TERMINAL_RE.test(job.status)) continue;
    const finishedAt = Date.parse(job.finished ?? '');
    if (!Number.isFinite(finishedAt) || finishedAt > cutoff) continue;
    try { rmSync(handleDir(job.handle, job.repo), { recursive: true, force: true }); } catch {}
    _jobs.delete(job.handle);
    _handleDirCache.delete(job.handle);
    pruned++;
  }
  if (pruned > 0) console.error(`worker: pruned ${pruned} terminal job(s) past retention`);
  return pruned;
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
