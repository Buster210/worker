/**
 * Singleton HTTP daemon for the worker MCP server.
 *
 * Lockfile: ~/.claude/workers/server.json
 * { pid, port, started_at }
 *
 * One daemon serves all Claude Code / OMP sessions via HTTP.
 * Sessions connect via StreamableHTTPServerTransport.
 * On last-session disconnect → hard kill all workers → exit.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { isProcessAlive } from './process.ts';
import { getAllRunningJobsFresh, finalizeJob, type Job } from './state.ts';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { killProcessTree, killProcessTrees } from './process.ts';

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
      } catch {
        return false;
      }
    }
    // Unexpected error — try atomic write fallback
    writeFileSync(tmpPath, JSON.stringify(lock));
    try {
      renameSync(tmpPath, lockPath());
      return true;
    } catch {
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
  claudeSid: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export class SessionTracker {
  private _map = new Map<string, SessionEntry>();

  /** Register a new MCP session with transport + server refs. claudeSid filled later by tool handler. */
  register(mcpSid: string, entry: Omit<SessionEntry, 'claudeSid'>): void {
    this._map.set(mcpSid, { ...entry, claudeSid: '' });
  }

  /** Set the Claude session ID for an already-registered MCP session. */
  setClaudeSid(mcpSid: string, claudeSid: string): void {
    const e = this._map.get(mcpSid);
    if (e) e.claudeSid = claudeSid;
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

// --- Per-session cleanup ---

/**
 * Kill all workers belonging to a specific Claude session.
 * Called when a session disconnects (clean or detected-dead).
 */
export function killSessionWorkers(claudeSid: string): void {
  const jobs = getAllRunningJobsFresh().filter(j => j.sid === claudeSid && j.status === 'running');
  for (const job of jobs) {
    if (job.worker_pid > 0) {
      killProcessTree(job.worker_pid, 'SIGKILL');
    }
    finalizeJob(job.handle, 'failed:session-killed', { resume_token: job.resume_token });
  }
}

// --- Hard shutdown (last session out) ---

/**
 * Kill ALL remaining workers, remove lockfile, exit.
 * Called when the last session disconnects.
 */
export function hardShutdown(): void {
  const jobs = getAllRunningJobsFresh();
  if (jobs.length > 0) {
    const pids = jobs.filter(j => j.worker_pid > 0).map(j => j.worker_pid);
    if (pids.length > 0) {
      killProcessTrees(pids, 'SIGKILL');
    }
    for (const job of jobs) {
      finalizeJob(job.handle, 'failed:daemon-shutdown', { resume_token: job.resume_token });
    }
  }
  removeLock();
  process.exit(0);
}

// --- Keepalive ---

/**
 * Start a keepalive loop that pings all sessions every 15s.
 * If a ping fails, the transport is dead → force close → triggers onclose → cleanup.
 */
export function startKeepalive(tracker: SessionTracker): NodeJS.Timeout {
  const timer = setInterval(async () => {
    for (const [mcpSid, session] of tracker.entries()) {
      try {
        await session.server.sendLoggingMessage({ level: 'debug', data: 'keepalive' });
      } catch {
        // Send failed → transport dead → force close triggers onclose
        try { await session.transport.close(); } catch { /* ignore */ }
      }
    }
  }, 15_000);
  timer.unref();
  return timer;
}
