/**
 * Singleton HTTP daemon for the worker MCP server.
 *
 * Lockfile: ~/.claude/workers/server.json
 * { pid, port, started_at }
 *
 * One daemon serves all Claude Code / OMP instances via HTTP.
 * Sessions connect via StreamableHTTPServerTransport.
 *
 * Lifecycle: The daemon runs indefinitely until explicitly shut down by the
 * session-end hook (which runs only when the last Claude Code instance ends).
 * Workers are reaped on shutdown. Orphaned workers (crashed but not cleaned up)
 * are reaped after 60s grace period.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync, renameSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { isProcessAlive } from './process.ts';
import { getAllRunningJobsFresh, finalizeJob, type Job } from './state.ts';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { killProcessTrees } from './process.ts';

// --- Lockfile ---

const lockDir = () => process.env.WORKER_STATE_DIR || join(homedir(), '.claude', 'workers');
const lockPath = () => join(lockDir(), 'server.json');

export interface DaemonLock {
  pid: number;
  port: number;
  started_at: string;
}

function ensureLockDir(): void {
  mkdirSync(lockDir(), { recursive: true });
}

/** Atomic create — returns true if we won the race, false if lockfile already exists. */
export function acquireLock(pid: number, port: number): boolean {
  ensureLockDir();
  const lock: DaemonLock = { pid, port, started_at: new Date().toISOString() };
  const tmpPath = `${lockPath()}.${pid}.tmp`;
  try {
    const fd = openSync(lockPath(), 'wx'); // exclusive create — fails if exists
    writeFileSync(fd, JSON.stringify(lock));
    closeSync(fd);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
      // This is only called after we successfully bound the port, so a live
      // lock-holder is impossible — it would still own the port. A lock whose
      // pid is dead is stale (SIGKILL'd daemon never ran removeLock) → reclaim
      // and retry once. A live foreign pid (PID reuse) we leave alone.
      const existing = readLock();
      if (existing && isProcessAlive(existing.pid) && existing.pid !== pid) {
        return false;
      }
      removeLock();
      try {
        const fd = openSync(lockPath(), 'wx');
        writeFileSync(fd, JSON.stringify(lock));
        closeSync(fd);
        return true;
      } catch (err) {
        console.error('[worker] lock retry failed:', err instanceof Error ? err.message : err);
        return false;
      }
    }
    // Unexpected error — try atomic write fallback
    writeFileSync(tmpPath, JSON.stringify(lock));
    try {
      renameSync(tmpPath, lockPath());
      return true;
    } catch (err) {
      console.error('[worker] lock atomic fallback failed:', err instanceof Error ? err.message : err);
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      return false;
    }
  }
}

export function readLock(): DaemonLock | null {
  try {
    const raw = readFileSync(lockPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object' &&
      'pid' in parsed && typeof (parsed as { pid: unknown }).pid === 'number' &&
      'port' in parsed && typeof (parsed as { port: unknown }).port === 'number'
    ) {
      return parsed as DaemonLock;
    }
    return null;
  } catch {
    return null;
  }
}

export function removeLock(): void {
  try { unlinkSync(lockPath()); } catch { /* ignore */ }
}

/** Check if daemon is alive: PID alive + health endpoint responds. */
export async function isDaemonAlive(lock: DaemonLock): Promise<boolean> {
  if (!isProcessAlive(lock.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Session tracking ---

export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number; // epoch ms, refreshed on every request — used only for idle GC
}

export class SessionTracker {
  private _map = new Map<string, SessionEntry>();

  /** Register a new MCP session with transport + server refs. */
  register(mcpSid: string, entry: SessionEntry): void {
    this._map.set(mcpSid, entry);
  }

  /** Mark a session as just-used (cheap idle-GC bookkeeping, no I/O). */
  touch(mcpSid: string): void {
    const e = this._map.get(mcpSid);
    if (e) e.lastSeen = Date.now();
  }

  /**
   * Drop sessions untouched for longer than maxIdleMs and close their dead
   * transports. Pure memory hygiene — a re-appearing client just re-initializes
   * (the handler 404s an unknown session id). Never kills workers.
   * ponytail: idle ceiling, not liveness; a truly-active client touches lastSeen
   * on every tool call so it never trips this.
   */
  reapIdle(maxIdleMs: number): number {
    const cutoff = Date.now() - maxIdleMs;
    let n = 0;
    for (const [sid, e] of [...this._map]) {
      if (e.lastSeen < cutoff) {
        this._map.delete(sid);
        void Promise.resolve(e.transport.close()).catch(() => {});
        n++;
      }
    }
    return n;
  }

  /** Remove and return the full session entry, or undefined if unknown. */
  remove(mcpSid: string): SessionEntry | undefined {
    const entry = this._map.get(mcpSid);
    this._map.delete(mcpSid);
    return entry;
  }

  get size(): number { return this._map.size; }

  entries(): IterableIterator<[string, SessionEntry]> { return this._map.entries(); }
  get(mcpSid: string): SessionEntry | undefined { return this._map.get(mcpSid); }
}

// --- Shutdown (on signal) ---

/** Kill every running worker. Only when no client remains (last instance out). */
function reapAllWorkers(): void {
  const jobs = getAllRunningJobsFresh();
  if (jobs.length === 0) return;
  const pids = jobs.filter(j => j.worker_pid > 0).map(j => j.worker_pid);
  if (pids.length > 0) killProcessTrees(pids, 'SIGKILL');
  for (const job of jobs) {
    finalizeJob(job.handle, 'failed:daemon-shutdown', { resume_token: job.resume_token });
  }
}

/** Reap workers that crashed >60s ago (grace period for reconnection). */
export function reapCrashedWorkers(): void {
  const jobs = getAllRunningJobsFresh();
  const now = Date.now();
  const GRACE_MS = 60_000;

  for (const job of jobs) {
    if (job.status !== 'running' || job.worker_pid <= 0) continue;
    if (isProcessAlive(job.worker_pid)) continue;

    const elapsed = now - new Date(job.started).getTime();
    if (elapsed > GRACE_MS) {
      try { killProcessTrees([job.worker_pid], 'SIGKILL'); } catch {}
      finalizeJob(job.handle, 'failed:orphaned', { resume_token: job.resume_token });
      console.error(`[worker] reaped orphaned worker after ${Math.round(elapsed / 1000)}s: ${job.handle}`);
    }
  }
}

/**
 * Exit the daemon (SIGTERM/SIGINT). Reaps all workers and exits.
 * Called only by session-end hook when the last Claude Code instance ends.
 */
export function hardShutdown(): void {
  reapAllWorkers();
  removeLock();
  process.exit(0);
}
