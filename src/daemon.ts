import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { localISO } from "./time.ts";
import { isProcessAlive } from "./process.ts";
import { getAllRunningJobsFresh, finalizeJob, workersDir } from "./state.ts";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { killProcessTrees } from "./process.ts";

const lockPath = () => join(workersDir(), "server.json");

export interface DaemonLock {
  pid: number;
  port: number;
  started_at: string;
}

function ensureLockDir(): void {
  mkdirSync(workersDir(), { recursive: true });
}

export function acquireLock(pid: number, port: number): boolean {
  ensureLockDir();
  const lock: DaemonLock = { pid, port, started_at: localISO() };
  try {
    const fd = openSync(lockPath(), "wx"); // exclusive create — fails if exists
    writeFileSync(fd, JSON.stringify(lock));
    closeSync(fd);
    return true;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "EEXIST"
    ) {
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
        const fd = openSync(lockPath(), "wx");
        writeFileSync(fd, JSON.stringify(lock));
        closeSync(fd);
        return true;
      } catch (err) {
        console.error(
          "[worker] lock retry failed:",
          err instanceof Error ? err.message : err,
        );
        return false;
      }
    }
    console.error(
      "[worker] acquireLock failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export function readLock(): DaemonLock | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed?.pid === "number" &&
      typeof parsed?.port === "number" &&
      typeof parsed?.started_at === "string"
    ) {
      return {
        pid: parsed.pid,
        port: parsed.port,
        started_at: parsed.started_at,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function removeLock(): void {
  try {
    unlinkSync(lockPath());
  } catch {
  }
}

export async function isDaemonAlive(lock: DaemonLock): Promise<boolean> {
  if (!isProcessAlive(lock.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number; // epoch ms, refreshed on every request — used only for idle GC
}

export class SessionTracker {
  private _map = new Map<string, SessionEntry>();

  register(mcpSid: string, entry: SessionEntry): void {
    this._map.set(mcpSid, entry);
  }

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
    for (const [sid, e] of this._map) {
      if (e.lastSeen < cutoff) {
        this._map.delete(sid);
        void Promise.resolve(e.transport.close()).catch(() => {});
        n++;
      }
    }
    return n;
  }

  remove(mcpSid: string): SessionEntry | undefined {
    const entry = this._map.get(mcpSid);
    this._map.delete(mcpSid);
    return entry;
  }

  get size(): number {
    return this._map.size;
  }

  entries(): IterableIterator<[string, SessionEntry]> {
    return this._map.entries();
  }
  get(mcpSid: string): SessionEntry | undefined {
    return this._map.get(mcpSid);
  }
}

export function killAndFinalizeJobs(
  jobs: ReturnType<typeof getAllRunningJobsFresh>,
  status: string,
): void {
  const pids = jobs.filter((j) => j.worker_pid > 0).map((j) => j.worker_pid);
  if (pids.length > 0) killProcessTrees(pids, "SIGKILL");
  for (const job of jobs) {
    console.error(`[daemon] shutdown: finalizing ${job.handle.slice(0, 8)} → ${status}`);
    finalizeJob(job.handle, status, { resume_token: job.resume_token });
  }
}
function reapAllWorkers(): void {
  const jobs = getAllRunningJobsFresh();
  if (jobs.length === 0) return;
  killAndFinalizeJobs(jobs, "failed:daemon-shutdown");
}

export function hardShutdown(): void {
  reapAllWorkers();
  removeLock();
  removeServerPid();
  process.exit(0);
}

function activeDir(): string {
  return join(process.env.HOME ?? homedir(), ".claude", ".active", "worker");
}

export function writeServerPid(): void {
  const dir = activeDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  try {
    writeFileSync(join(dir, "server.pid"), String(process.pid));
  } catch {}
}

export function removeServerPid(): void {
  try {
    unlinkSync(join(activeDir(), "server.pid"));
  } catch {}
}

const SELF_TERM_EMPTY_THRESHOLD = 2;

let _clientPidCache: Set<string> | null = null;
let _emptyTickCount = 0;
let _everSeenClient = false;

function readClientPids(): Set<string> {
  const dir = activeDir();
  const result = new Set<string>();
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === "server.pid") continue;
      if (/^\d+$/.test(entry)) result.add(entry);
    }
  } catch {
  }
  return result;
}

function selfTerminate(): void {
  console.error("[worker] self-terminating: no live client");
  const jobs = getAllRunningJobsFresh();
  if (jobs.length > 0) killAndFinalizeJobs(jobs, "killed:no-client");
  hardShutdown();
}

export function checkClientLiveness(): void {
  // Safety gate: arm only after observing ≥1 live client at least once.
  if (!_everSeenClient) {
    _clientPidCache = readClientPids();
    if (_clientPidCache.size > 0) {
      _everSeenClient = true;
      // Check immediately — a client might already be dead
    } else {
      return; // never seen a client → never self-terminate
    }
  }

  // Fast path: check cached PIDs with isProcessAlive
  if (_clientPidCache && _clientPidCache.size > 0) {
    let anyAlive = false;
    for (const pidStr of _clientPidCache) {
      if (isProcessAlive(Number(pidStr))) {
        anyAlive = true;
        break;
      }
    }
    if (anyAlive) {
      _emptyTickCount = 0;
      return;
    }
    _clientPidCache = readClientPids();
    if (_clientPidCache.size > 0) {
      _emptyTickCount = 0;
      return;
    }
  }

  _emptyTickCount++;
  if (_emptyTickCount >= SELF_TERM_EMPTY_THRESHOLD) {
    // Fresh re-read before firing (req 3)
    const freshPids = readClientPids();
    for (const pidStr of freshPids) {
      if (isProcessAlive(Number(pidStr))) {
        _clientPidCache = freshPids;
        _emptyTickCount = 0;
        return;
      }
    }
    selfTerminate();
  }
}

export function __checkClientLivenessForTest(): void {
  checkClientLiveness();
}

export function __resetLivenessStateForTest(): void {
  _clientPidCache = null;
  _emptyTickCount = 0;
  _everSeenClient = false;
}
