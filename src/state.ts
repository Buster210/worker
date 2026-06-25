import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, unlinkSync, renameSync, rmSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { removeWorktree } from './worktree.ts';
import { FILE_CONFIG } from './config.ts';
import { isProcessAlive } from './process.ts';

const _ensuredDirs = new Set<string>();
export function workersDir(): string {
  const dir = process.env.WORKER_STATE_DIR ?? FILE_CONFIG.stateDir ?? `${process.env.HOME}/.claude/workers`;
  if (!_ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'ladder'), { recursive: true });
    _ensuredDirs.add(dir);
  }
  return dir;
}

export function plansDir(): string {
  return process.env.WORKER_PLANS_DIR ?? FILE_CONFIG.plansDir ?? `${process.env.HOME}/.claude/plans`;
}

export function reaperPidPath(): string {
  return join(workersDir(), '.reaper.pid');
}

export function readSpec(specFile: string): string {
  const trimmed = specFile.trim();
  if (trimmed.length === 0) throw new Error('specFile must not be empty');
  if (trimmed.includes('/') || trimmed.includes('\\')) throw new Error('specFile must be a bare filename (no path separators)');
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) throw new Error('specFile must not contain path traversal');
  if (basename(trimmed) !== trimmed) throw new Error('specFile must be a bare filename');
  const resolved = join(plansDir(), trimmed);
  try {
    return readFileSync(resolved, 'utf8');
  } catch {
    throw new Error(`spec not found: ${resolved}`);
  }
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

// Pure path derivation, NO cache write. Use this where a caller needs a handle-scoped path from an
// arbitrary base (e.g. omp's --session-dir is derived from the worktree path) WITHOUT redirecting the
// handle's job record + lock — `handleDir` caches, so calling it with a non-repo base poisons every
// later no-repo lookup (updateJob/finalizeJob/removeLock).
export function handleDirUncached(handle: string, repo: string): string {
  return join(workersDir(), projectName(repo), handle);
}
function handleDir(handle: string, repo?: string): string {
  if (repo) {
    const dir = handleDirUncached(handle, repo);
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
export function chainMetaPath(sid: string) { return join(workersDir(), 'ladder', `${sid}.chain.meta`); }

export type ChainMeta = {
  deadlineAt: number;
};

export function createChainLock(sid: string, ownerPid?: number, ownerStarted?: string) {
  ensureLadderDir();
  try { writeFileSync(chainLockPath(sid), ownerPid != null ? `${ownerPid}\n${ownerStarted ?? ''}` : ''); } catch {}
}
export function removeChainLock(sid: string) { try { unlinkSync(chainLockPath(sid)); } catch {} }
export function removeChainMeta(sid: string) { try { unlinkSync(chainMetaPath(sid)); } catch {} }

export function saveChainMeta(sid: string, meta: ChainMeta): void {
  ensureLadderDir();
  try { writeFileSync(chainMetaPath(sid), JSON.stringify(meta)); } catch {}
}

export function loadChainMeta(sid: string): ChainMeta | null {
  try { return JSON.parse(readFileSync(chainMetaPath(sid), 'utf8')) as ChainMeta; } catch { return null; }
}

export type Job = {
  handle: string; backend: string; sid: string;
  worker_pid: number; resume_token: string; repo: string; started: string;
  finished?: string; stopped_at?: string;
  status: string; model: string; task: string; log_path: string;
  completion_lock: string;
  kill_requested?: boolean;
  server_pid: number;
  server_started: string;
  server_sid: string;
  deadline_at?: number;
  worktree_path?: string;
  base_sha?: string;
  created_at?: number;
  branch?: string;
};

export function insertJob(j: {
  handle: string; backend: string; sid: string;
  worker_pid?: number; resume_token?: string; repo: string; model?: string;
  task?: string; log_path: string; completion_lock?: string;
  server_pid?: number; server_started?: string; server_sid?: string; deadline_at?: number;
  worktree_path?: string; base_sha?: string; created_at?: number; branch?: string;
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
    deadline_at: j.deadline_at,
    worktree_path: j.worktree_path,
    base_sha: j.base_sha,
    created_at: j.created_at ?? Date.now(),
    branch: j.branch,
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
  // Idempotent: once a job is terminal (anything but running/stopped), the first
  // finalize wins. A later call must not downgrade done->failed or bump `finished`.
  if (job.status !== 'running' && job.status !== 'stopped') return job.status;
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
export function getAllRunningJobsFresh(): Job[] { return scanAllJobs().filter(j => j.status === 'running'); }
export function getAllStoppedJobs(): Job[] { return collectJobs(j => j.status === 'stopped'); }
export function getAllJobs(): Job[] { ensureBootstrapped(); return Array.from(_jobs.values()); }
/** True iff this handle is the earliest-created ALIVE running job for the repo. */
export function isInPlaceOwner(handle: string, repo: string): boolean {
  const mine = getJob(handle);
  if (!mine || mine.status !== 'running' || mine.repo !== repo) return false;
  // scanAllJobs (disk-fresh), NOT collectJobs (in-process _jobs cache) — a peer MCP
  // server's job written after our bootstrap is invisible to the cache, which would
  // let two processes each claim the project dir. Cross-process election MUST hit disk.
  const others = scanAllJobs().filter(j =>
    j.status === 'running' && j.repo === repo && j.handle !== handle &&
    isProcessAlive(j.server_pid, j.server_started)
  );
  const mineAt = mine.created_at ?? 0;
  return others.every(o => {
    const oAt = o.created_at ?? 0;
    return mineAt < oAt || (mineAt === oAt && handle < o.handle);
  });
}

function retainMs(): number {
  const v = Number(process.env.WORKER_RETAIN_MS);
  if (Number.isFinite(v) && v > 0) return v;
  return FILE_CONFIG.retainMs ?? 604_800_000;
}
const TERMINAL_RE = /^(done|failed|timeout|killed|stalled)/;

// A worktree is owned by the handle that CREATED it — its path is that handle's own tree dir. Ladder
// reuse points retry/climb handles at the FIRST handle's worktree, so they share the path but must
// never remove it (that would delete a sibling's tree + branch out from under it). Prune/reap remove
// a worktree only through its owner; non-owner handles just drop their own (empty) handle dir + row.
export function ownsWorktree(job: { handle: string; repo: string; worktree_path?: string }): boolean {
  return !!job.worktree_path && job.worktree_path === join(handleDir(job.handle, job.repo), 'tree');
}

export function pruneOldJobs(now: number = Date.now()): number {
  ensureBootstrapped();
  const cutoff = now - retainMs();
  let pruned = 0;
  for (const job of _jobs.values()) {
    if (!TERMINAL_RE.test(job.status)) continue;
    const finishedAt = Date.parse(job.finished ?? '');
    if (!Number.isFinite(finishedAt) || finishedAt > cutoff) continue;
    if (ownsWorktree(job)) { try { removeWorktree(job.repo, job.worktree_path!); } catch {} }
    try { rmSync(handleDir(job.handle, job.repo), { recursive: true, force: true }); } catch {}
    _jobs.delete(job.handle);
    _handleDirCache.delete(job.handle);
    pruned++;
  }
  if (pruned > 0) console.error(`worker: pruned ${pruned} terminal job(s) past retention`);
  return pruned;
}

/** Test-only: reset module-level singletons so state is hermetic across test files. */
export function __resetStateForTest(): void {
  _jobs.clear();
  _jobsBootstrapped = false;
  _handleDirCache.clear();
  _ensuredDirs.clear();
}

export function appendLadder(sid: string, turn: number, worker: string, result: string) {
  ensureLadderDir();
  try {
    appendFileSync(ladderPath(sid), JSON.stringify({ turn, worker, result, ts: new Date().toISOString() }) + '\n');
  } catch (err) {
    console.error(`appendLadder: write failed (sid=${sid} turn=${turn} worker=${worker}): ${err}`);
  }
}

function ensureLadderDir(): void {
  try { mkdirSync(join(workersDir(), 'ladder'), { recursive: true }); } catch (err) {
    console.error('[worker] failed to create ladder dir:', err instanceof Error ? err.message : err);
  }
}

export function getLadderHistory(sid: string): { turn: number; worker: string; result: string }[] {
  try {
    return readFileSync(ladderPath(sid), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map(l => JSON.parse(l));
  } catch { return []; }
}

/** Delete `run.log` for a `done` handle. Returns `'pruned'` or `'kept:…'` if no-op/failed. */
export function pruneTranscript(handle: string): 'pruned' | 'kept:not-done' | 'kept:no-job' | 'kept:error' {
  const job = getJob(handle);
  if (!job) return 'kept:no-job';
  if (job.status !== 'done') return 'kept:not-done';
  try {
    unlinkSync(logPath(handle, job.repo));
    return 'pruned';
  } catch (e) {
    // already gone = success (idempotent re-cleanup); any other error = honest failure
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return 'pruned';
    return 'kept:error';
  }
}
