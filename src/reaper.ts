#!/usr/bin/env bun
/**
 * External reaper — detached background process that sweeps for orphaned workers.
 * Survives SIGKILL of the parent CC/MCP server so a crashed server's running workers
 * don't linger until the next startup.
 *
 * Spawned by lifecycle.launch on worker launch (NOT at server start), so an idle server
 * with zero workers runs no reaper. Sweeps every WORKER_REAPER_MS (default 10s). Each tick,
 * after sweeping, it exits once no running jobs remain — there is nothing left to watch and
 * a later worker launch respawns it. Also exits on SIGTERM/SIGINT (parent shutdown).
 */
import { sweepStaleJobs } from './maintenance.ts';
import { getAllRunningJobsFresh, reaperPidPath } from './state.ts';
import { envMs } from './env.ts';
import { unlinkSync, writeFileSync } from 'fs';

const SWEEP_INTERVAL_MS = envMs('WORKER_REAPER_MS', 10_000);

function exitCleanly(): void {
  try { unlinkSync(reaperPidPath()); } catch {}
  process.exit(0);
}

function loop(): void {
  sweepStaleJobs({ fresh: true });            // reap running workers orphaned by a dead server
  // No running jobs left -> nothing to watch. The orphan count reads the same disk state the
  // sweep just loaded (cheap), so check every tick; a worker launch respawns the reaper.
  // Lingering a tick longer is the safe failure mode; exiting while a worker is alive is not —
  // but launch writes the job 'running' to disk before spawning us, so that cannot happen.
  if (getAllRunningJobsFresh().length === 0) exitCleanly();
  // NOT unref'd: a ref'd timer is what keeps this daemon alive between ticks. bun (unlike node)
  // does NOT hold the event loop open for a registered signal listener, so an unref'd timer here
  // would make the reaper run exactly one sweep and exit. exitCleanly/SIGTERM exit via process.exit.
  setTimeout(loop, SWEEP_INTERVAL_MS);
}

if (import.meta.main) {
  try { writeFileSync(reaperPidPath(), `${process.pid}\n`); } catch {}
  process.on('SIGTERM', exitCleanly);
  process.on('SIGINT', exitCleanly);
  loop();
}
