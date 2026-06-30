import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
  unlinkSync,
  renameSync,
  existsSync,
  statSync,
} from "fs";
import { join, basename } from "path";
import { localISO } from "./time.ts";
import { FILE_CONFIG } from "./config.ts";
import { isProcessAlive } from "./process.ts";
import { spawnAsync } from "./process.ts";

const _ensuredDirs = new Set<string>();
export function workersDir(): string {
  const dir =
    process.env.WORKER_STATE_DIR ??
    FILE_CONFIG.stateDir ??
    `${process.env.HOME}/.claude/workers`;
  if (!_ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "ladder"), { recursive: true });
    _ensuredDirs.add(dir);
  }
  return dir;
}

export function plansDir(): string {
  return (
    process.env.WORKER_PLANS_DIR ??
    FILE_CONFIG.plansDir ??
    `${process.env.HOME}/.claude/plans`
  );
}

export function plansWorkerDir(): string {
  return join(plansDir(), "worker");
}

export function reaperPidPath(): string {
  return join(workersDir(), ".reaper.pid");
}

export function readSpec(specFile: string): string {
  const trimmed = specFile.trim();
  if (trimmed.length === 0) throw new Error("specFile must not be empty");
  if (trimmed.includes("/") || trimmed.includes("\\"))
    throw new Error("specFile must be a bare filename (no path separators)");
  if (trimmed === "." || trimmed === ".." || trimmed.includes(".."))
    throw new Error("specFile must not contain path traversal");
  if (basename(trimmed) !== trimmed)
    throw new Error("specFile must be a bare filename");
  const resolved = join(plansDir(), trimmed);
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`spec not found: ${resolved}`);
  }
}

export function isBareSpecName(name: string): boolean {
  const t = name.trim();
  return (
    t.length > 0 &&
    !t.includes("/") &&
    !t.includes("\\") &&
    !t.includes("..") &&
    basename(t) === t
  );
}

export function archiveSpec(handle: string): void {
  const job = getJob(handle);
  const spec = job?.spec_file;
  if (!spec || !isBareSpecName(spec)) return;
  try {
    mkdirSync(plansWorkerDir(), { recursive: true });
    renameSync(join(plansDir(), spec), join(plansWorkerDir(), spec));
  } catch {
    /* missing or already moved — idempotent */
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
  rel = rel.replace(/^\/+|\/+$/g, "");
  if (rel === "") return "root";
  return rel.replace(/\//g, "-");
}

export function resolveHandleDir(handle: string): string | null {
  try {
    const root = workersDir();
    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        entry.name !== "ladder" &&
        entry.name !== "tmux"
      ) {
        const dir = join(root, entry.name, handle);
        if (existsSync(join(dir, "job.json"))) return dir;
      }
    }
  } catch {}
  return null;
}

const _handleDirCache = new Map<string, string>();

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
  return join(handleDir(handle, repo), ".lock");
}
export function logPath(handle: string, repo?: string) {
  return join(handleDir(handle, repo), "run.log");
}
export function createLock(handle: string, repo?: string) {
  try {
    writeFileSync(lockPath(handle, repo ?? undefined), "");
  } catch {}
}
export function removeLock(handle: string, repo?: string) {
  try {
    unlinkSync(lockPath(handle, repo ?? undefined));
  } catch {}
}

function jobJsonPath(handle: string, repo?: string): string {
  return join(handleDir(handle, repo), "job.json");
}
function ladderPath(sid: string) {
  return join(workersDir(), "ladder", `${sid}.jsonl`);
}

export function chainLockPath(sid: string) {
  return join(workersDir(), "ladder", `${sid}.chain.lock`);
}
export function chainMetaPath(sid: string) {
  return join(workersDir(), "ladder", `${sid}.chain.meta`);
}

export type ChainMeta = {
  deadlineAt: number;
};

export function createChainLock(
  sid: string,
  ownerPid?: number,
  ownerStarted?: string,
) {
  ensureLadderDir();
  try {
    writeFileSync(
      chainLockPath(sid),
      ownerPid != null ? `${ownerPid}\n${ownerStarted ?? ""}` : "",
    );
  } catch {}
}
export function removeChainLock(sid: string) {
  try {
    unlinkSync(chainLockPath(sid));
  } catch {}
}
export function removeChainMeta(sid: string) {
  try {
    unlinkSync(chainMetaPath(sid));
  } catch {}
}

export function saveChainMeta(sid: string, meta: ChainMeta): void {
  ensureLadderDir();
  try {
    writeFileSync(chainMetaPath(sid), JSON.stringify(meta));
  } catch {}
}

export function loadChainMeta(sid: string): ChainMeta | null {
  try {
    return JSON.parse(readFileSync(chainMetaPath(sid), "utf8")) as ChainMeta;
  } catch {
    return null;
  }
}

export type Job = {
  handle: string;
  backend: string;
  sid: string;
  worker_pid: number;
  resume_token: string;
  repo: string;
  started: string;
  finished?: string;
  stopped_at?: string;
  status: string;
  model: string;
  task: string;
  log_path: string;
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
  spec_file?: string;
  stash_sha?: string;
  stash_state?: StashState;
};

export type StashState = "stashed" | "restored" | "conflict";

export function stashSummary(job: {
  stash_sha?: string;
  stash_state?: StashState;
} | null | undefined): string | undefined {
  if (!job?.stash_sha) return undefined;
  if (job.stash_state === "restored") return undefined;
  if (job.stash_state === "conflict")
    return `stash ${job.stash_sha} conflict — restore: git stash apply ${job.stash_sha}`;
  return `stash ${job.stash_sha} preserved — restore: git stash apply ${job.stash_sha}`;
}

export function insertJob(j: {
  handle: string;
  backend: string;
  sid: string;
  worker_pid?: number;
  resume_token?: string;
  repo: string;
  model?: string;
  task?: string;
  log_path: string;
  completion_lock?: string;
  server_pid?: number;
  server_started?: string;
  server_sid?: string;
  deadline_at?: number;
  worktree_path?: string;
  base_sha?: string;
  created_at?: number;
  branch?: string;
  spec_file?: string;
  stash_sha?: string;
  stash_state?: StashState;
}) {
  const job: Job = {
    handle: j.handle,
    backend: j.backend,
    sid: j.sid,
    worker_pid: j.worker_pid ?? 0,
    resume_token: j.resume_token ?? "",
    repo: j.repo,
    started: localISO(),
    status: "running",
    model: j.model ?? "",
    task: j.task ?? "",
    log_path: j.log_path,
    completion_lock: j.completion_lock ?? lockPath(j.handle, j.repo),
    server_pid: j.server_pid ?? 0,
    server_started: j.server_started ?? "",
    server_sid: j.server_sid ?? "",
    deadline_at: j.deadline_at,
    worktree_path: j.worktree_path,
    base_sha: j.base_sha,
    created_at: j.created_at ?? Date.now(),
    branch: j.branch,
    spec_file: j.spec_file,
    stash_sha: j.stash_sha,
    stash_state: j.stash_state,
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
    if (
      (current as Record<string, unknown>)[k] !==
      (fields as Record<string, unknown>)[k]
    ) {
      changed = true;
      break;
    }
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
    const job = JSON.parse(readFileSync(jobJsonPath(handle), "utf8")) as Job;
    _jobs.set(handle, job);
    return job;
  } catch {
    return null;
  }
}

export function getJobFresh(handle: string): Job | null {
  try {
    return JSON.parse(readFileSync(jobJsonPath(handle), "utf8")) as Job;
  } catch {
    return null;
  }
}

export function finalizeJob(
  handle: string,
  naturalStatus: string,
  extra?: Partial<Job>,
): string {
  const job = getJob(handle);
  if (!job) return naturalStatus;
  if (job.status !== "running" && job.status !== "stopped") return job.status;
  const final =
    naturalStatus === "done"
      ? "done"
      : job.kill_requested
        ? "killed"
        : naturalStatus;
  updateJob(handle, {
    status: final,
    finished: localISO(),
    // Terminal jobs don't need the full spec text (resume re-reads the spec
    // file; commit messages only ever used the first line). Keeping just the
    // first line stops finished jobs bloating the job cache, job.json, and the
    // scan memo for the whole retention window. worker_list shows this line.
    task: (job.task ?? "").split("\n")[0].slice(0, 200),
    ...extra,
  });
  removeLock(handle);
  return final;
}

export async function restoreJobStash(
  handle: string,
): Promise<"restored" | "conflict" | "skipped"> {
  const job = getJob(handle);
  if (!job?.stash_sha || job.stash_state !== "stashed") return "skipped";
  const repo = job.worktree_path ?? job.repo;
  const sha = job.stash_sha;
  const apply = await spawnAsync(
    "git",
    ["-C", repo, "stash", "apply", sha],
    { timeoutMs: 30_000 },
  );
  if (apply.error || apply.status !== 0) {
    console.error(
      `[stash] apply failed for ${handle}: ${apply.error?.message ?? apply.stderr?.trim() ?? `exit ${apply.status}`}`,
    );
    await spawnAsync("git", ["-C", repo, "reset", "--hard", "HEAD"], {
      timeoutMs: 30_000,
    });
    await spawnAsync("git", ["-C", repo, "clean", "-fd"], {
      timeoutMs: 30_000,
    });
    updateJob(handle, { stash_state: "conflict" });
    return "conflict";
  }

  // Drop ONLY our entry by reflog index — deleting refs/stash wholesale
  // (update-ref -d) erases the reflog that holds the user's other stashes.
  // Verify the sha at the index right before dropping: a concurrent stash
  // push/drop shifts indices, and a blind drop would then remove someone
  // else's entry. Mismatch/failure → one retry with a fresh list.
  for (let attempt = 0; attempt < 2; attempt++) {
    const list = await spawnAsync(
      "git",
      ["-C", repo, "stash", "list", "--format=%H"],
      { timeoutMs: 30_000 },
    );
    const idx = (list.stdout ?? "").trim().split("\n").indexOf(sha);
    if (idx < 0) {
      console.error(
        `[stash] entry ${sha} not in stash list for ${handle}; skipping drop`,
      );
      break;
    }
    const at = await spawnAsync(
      "git",
      ["-C", repo, "rev-parse", "-q", "--verify", `stash@{${idx}}`],
      { timeoutMs: 30_000 },
    );
    if (at.status !== 0 || (at.stdout ?? "").trim() !== sha) {
      if (attempt === 0) continue;
      console.error(
        `[stash] index ${idx} no longer holds ${sha} for ${handle}; skipping drop`,
      );
      break;
    }
    const drop = await spawnAsync(
      "git",
      ["-C", repo, "stash", "drop", `stash@{${idx}}`],
      { timeoutMs: 30_000 },
    );
    if (drop.error || drop.status !== 0) {
      if (attempt === 0) continue;
      console.error(
        `[stash] drop failed for ${handle}: ${drop.error?.message ?? drop.stderr?.trim() ?? `exit ${drop.status}`}`,
      );
    }
    break;
  }
  updateJob(handle, { stash_state: "restored" });
  return "restored";
}

// Stat-keyed memo for job.json reads. The periodic sweeps (reaper every 10s,
// daemon every 60s) re-scan every handle dir; re-parsing files whose stat is
// unchanged is pure waste. Writes go through tmp+rename (new ino/mtime), so an
// unchanged (ino, mtime, size) key means unchanged content — this stays as
// fresh as a direct read.
type JobFileEntry = { key: string; job: Job | null };
const _jobFileCache = new Map<string, JobFileEntry>();

export function readJobFileCached(path: string): Job | null {
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    _jobFileCache.delete(path);
    return null;
  }
  const hit = _jobFileCache.get(path);
  if (hit && hit.key === key) return hit.job;
  let job: Job | null = null;
  try {
    job = JSON.parse(readFileSync(path, "utf8")) as Job;
  } catch {}
  _jobFileCache.set(path, { key, job });
  return job;
}

/** Drop memo entries for job.json paths a full scan no longer sees (deleted dirs). */
export function pruneJobFileCache(visited: Set<string>): void {
  for (const path of _jobFileCache.keys()) {
    if (!visited.has(path)) _jobFileCache.delete(path);
  }
}

function scanAllJobs(): Job[] {
  try {
    const root = workersDir();
    const visited = new Set<string>();
    const jobs = readdirSync(root, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && d.name !== "ladder" && d.name !== "tmux",
      )
      .flatMap((d) => {
        try {
          return readdirSync(join(root, d.name), { withFileTypes: true })
            .filter((h) => h.isDirectory())
            .map((h) => {
              const path = join(root, d.name, h.name, "job.json");
              visited.add(path);
              return readJobFileCached(path);
            });
        } catch {
          return [];
        }
      })
      .filter((j): j is Job => j != null);
    pruneJobFileCache(visited);
    return jobs;
  } catch {
    return [];
  }
}

function collectJobs(predicate: (j: Job) => boolean): Job[] {
  ensureBootstrapped();
  const out: Job[] = [];
  for (const j of _jobs.values()) if (predicate(j)) out.push(j);
  return out;
}

export function getAllRunningJobs(): Job[] {
  return collectJobs((j) => j.status === "running");
}
export function getAllRunningJobsFresh(): Job[] {
  return scanAllJobs().filter((j) => j.status === "running");
}
export function getAllStoppedJobs(): Job[] {
  return collectJobs((j) => j.status === "stopped");
}
export function getAllJobs(): Job[] {
  ensureBootstrapped();
  return Array.from(_jobs.values());
}
export function isInPlaceOwner(handle: string, repo: string): boolean {
  const mine = getJob(handle);
  if (!mine || mine.status !== "running" || mine.repo !== repo) return false;
  // scanAllJobs (disk-fresh), NOT collectJobs (in-process _jobs cache) — a peer MCP
  // server's job written after our bootstrap is invisible to the cache, which would
  // let two processes each claim the project dir. Cross-process election MUST hit disk.
  const others = scanAllJobs().filter(
    (j) =>
      j.status === "running" &&
      j.repo === repo &&
      j.handle !== handle &&
      isProcessAlive(j.server_pid, j.server_started),
  );
  const mineAt = mine.created_at ?? 0;
  return others.every((o) => {
    const oAt = o.created_at ?? 0;
    return mineAt < oAt || (mineAt === oAt && handle < o.handle);
  });
}

export function retainMs(): number {
  const v = Number(process.env.WORKER_RETAIN_MS);
  if (Number.isFinite(v) && v > 0) return v;
  // Config value is in hours; convert to ms. 0 = use default (24h).
  const hours = FILE_CONFIG.retainMs;
  return hours && hours > 0 ? hours * 3_600_000 : 86_400_000;
}

export function ownsWorktree(job: {
  handle: string;
  repo: string;
  worktree_path?: string;
}): boolean {
  return (
    !!job.worktree_path &&
    job.worktree_path === join(handleDir(job.handle, job.repo), "tree")
  );
}
export function removeJobFromCache(handle: string): void {
  _jobs.delete(handle);
  _handleDirCache.delete(handle);
}

export function __resetStateForTest(): void {
  _jobs.clear();
  _jobsBootstrapped = false;
  _handleDirCache.clear();
  _ensuredDirs.clear();
  _jobFileCache.clear();
}

export function appendLadder(
  sid: string,
  turn: number,
  worker: string,
  result: string,
) {
  ensureLadderDir();
  try {
    appendFileSync(
      ladderPath(sid),
      JSON.stringify({ turn, worker, result, ts: localISO() }) +
        "\n",
    );
  } catch (err) {
    console.error(
      `appendLadder: write failed (sid=${sid} turn=${turn} worker=${worker}): ${err}`,
    );
  }
}

function ensureLadderDir(): void {
  try {
    mkdirSync(join(workersDir(), "ladder"), { recursive: true });
  } catch (err) {
    console.error(
      "[worker] failed to create ladder dir:",
      err instanceof Error ? err.message : err,
    );
  }
}

export function getLadderHistory(
  sid: string,
): { turn: number; worker: string; result: string }[] {
  try {
    return readFileSync(ladderPath(sid), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Delete `run.log` for a `done` handle. Returns `'pruned'` or `'kept:…'` if no-op/failed. */
export function pruneTranscript(
  handle: string,
): "pruned" | "kept:not-done" | "kept:no-job" | "kept:error" {
  const job = getJob(handle);
  if (!job) return "kept:no-job";
  if (job.status !== "done") return "kept:not-done";
  try {
    unlinkSync(logPath(handle, job.repo));
    return "pruned";
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return "pruned";
    return "kept:error";
  }
}
