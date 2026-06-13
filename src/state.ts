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

// Per-process in-memory read cache for job.json, write-through to disk. Populated from disk
// on cold boot (scanAllJobs) and kept in sync by every write path (insertJob / updateJob /
// finalizeJob). Same-process reads hit the map first, falling back to disk on miss. This
// cache is NOT cross-process coherent — the worker-report bin uses getJobFresh to bypass it.
//
// Memory: bounded by handle count (~500B per Job serialized, ~1KB in V8). For 200 jobs
// that's ~200KB — negligible. For 1000 jobs, ~1MB.
const _jobs = new Map<string, Job>();
let _jobsBootstrapped = false;

/** Populate the in-memory map from disk. Called once on first read after process start. */
function ensureBootstrapped(): void {
  if (_jobsBootstrapped) return;
  _jobsBootstrapped = true;
  for (const j of scanAllJobsFromDisk()) _jobs.set(j.handle, j);
}

/** Bypass the cache for a single read (used by the bootstrap itself). */
function scanAllJobsFromDisk(): Job[] {
  return scanAllJobs();
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

// handle→dir is immutable for a job's lifetime (a job dir never moves), so this needs no
// invalidation. It exists to spare the no-repo callers (getJob/updateJob via jobPathFn) the
// O(projects) readdirSync walk in resolveHandleDir on every lookup. Seeded whenever the repo is
// known (insertJob's calls) and on a successful cold resolve; a fresh process starts empty and
// repopulates via the scan fallback.
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

function jobPathFn(handle: string, repo?: string): string {
  return join(handleDir(handle, repo), 'job.json');
}
function ladderPath(sid: string)  { return join(workersDir(), 'ladder', `${sid}.jsonl`); }

// Chain lock: one stable lock per worker_ladder invocation, held for the WHOLE auto-climb chain
// (created when the ladder starts, removed only when it terminates — done/exhausted/killed/throw).
// Distinct from per-rung handle locks so a rung's finalizeJob never clears the chain-level signal.
export function chainLockPath(sid: string) { return join(workersDir(), 'ladder', `${sid}.chain.lock`); }
export function createChainLock(sid: string) { try { writeFileSync(chainLockPath(sid), ''); } catch {} }
export function removeChainLock(sid: string) { try { unlinkSync(chainLockPath(sid)); } catch {} }

export type Job = {
  handle: string; backend: string; sid: string;
  worker_pid: number; resume_token: string; repo: string; started: string;
  finished?: string; stopped_at?: string; last_line?: string;
  status: string; model: string; task: string; log_path: string;
  // The lock whose removal signals THIS job's completion to report.ts. A single run → its own
  // per-handle lock; a ladder rung-0 → the sid-keyed chain lock (spans the whole climb). Persisted
  // so report.ts derives it from the handle alone — no need to pass lock_path on the command line.
  completion_lock: string;
  kill_requested?: boolean;
  // Owning MCP server identity — used by the orphan sweep to detect when the server that launched
  // this worker has been killed -9. server_pid=0 / server_started='' means legacy (pre-sweep) job
  // and is NEVER swept (safe-fail: existing dead-worker branch still covers these).
  server_pid: number;
  server_started: string;
  // Owning Claude session id (CLAUDE_CODE_SESSION_ID of the parent session). Combined with
  // server_pid/server_started, this closes the PID-reuse window: even if a recycled pid +
  // coincident start-time happen to match an alive server, a different sid means it's a different
  // MCP server (and that server's own orphan sweep owns its own jobs).
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
    // Default to the per-handle lock; worker_ladder overrides with the chain lock for rung 0.
    completion_lock: j.completion_lock ?? lockPath(j.handle, j.repo),
    server_pid: j.server_pid ?? 0,
    server_started: j.server_started ?? '',
    server_sid: j.server_sid ?? '',
  };
  mkdirSync(handleDir(j.handle, j.repo), { recursive: true });
  // Seed the cache BEFORE writing to disk so a concurrent getJob from another tick sees the new job
  // (the event loop is single-threaded, but `mkdirSync` is one tick away from `writeFileSync` — any
  // intervening await in the future would expose the race without this ordering).
  _jobs.set(job.handle, job);
  const jobPath = jobPathFn(j.handle, j.repo);
  const tmpPath = `${jobPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(job, null, 2));
  renameSync(tmpPath, jobPath);
  createLock(j.handle, j.repo);
}

/**
 * Update job fields: merge into the in-memory map, then write-through to job.json.
 * Synchronous — no interleaving possible on the single-threaded JS event loop, so
 * concurrent updateJob calls naturally serialize and each sees the other's prior write.
 */
export function updateJob(handle: string, fields: Partial<Job>) {
  ensureBootstrapped();
  const current = _jobs.get(handle);
  if (!current) return; // unknown handle — nothing to update
  const merged = { ...current, ...fields };
  _jobs.set(handle, merged);
  const path = jobPathFn(handle);
  try {
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
    renameSync(tmpPath, path);
  } catch {}
}

export function getJob(handle: string): Job | null {
  ensureBootstrapped();
  const cached = _jobs.get(handle);
  if (cached) return cached;
  // Cache miss for a handle we never inserted this process — try the disk once (e.g. a
  // resume targeting a job the original server wrote, and another process later reads).
  try {
    const job = JSON.parse(readFileSync(jobPathFn(handle), 'utf8')) as Job;
    _jobs.set(handle, job);
    return job;
  } catch {
    return null;
  }
}
/** Read a job straight from disk, bypassing the in-memory cache. For cross-process
 *  readers (the worker-report bin) that MUST observe writes made by the owning server
 *  process — the cache is per-process and never invalidates, so a cached 'running' would
 *  mask the final terminal status. */
export function getJobFresh(handle: string): Job | null {
  try { return JSON.parse(readFileSync(jobPathFn(handle), 'utf8')) as Job; }
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

// Two-level walk (<root>/<project>/<handle>/job.json) shared by the status-scoped scanners below.
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

export function getAllRunningJobs(): Job[] { ensureBootstrapped(); return Array.from(_jobs.values()).filter(j => j.status === 'running'); }
export function getAllStoppedJobs(): Job[] { ensureBootstrapped(); return Array.from(_jobs.values()).filter(j => j.status === 'stopped'); }
/** All cached jobs regardless of status — used by handleList which filters by status itself. */
export function getAllJobs(): Job[] { ensureBootstrapped(); return Array.from(_jobs.values()); }

export function getRunningJobsForRepo(repo: string): Job[] {
  ensureBootstrapped();
  return Array.from(_jobs.values()).filter(j =>
    (j.status === 'running' || j.status === 'stopped') && j.repo === repo
  );
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
