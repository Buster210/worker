#!/usr/bin/env bun
/**
 * External reaper — detached background process that periodically sweeps for
 * orphaned workers. Survives SIGKILL of the parent CC/MCP process so workers
 * don't linger until next startup.
 *
 * Spawned by lifecycle.ts as a detached child. Runs every 30s. Exits cleanly
 * on SIGTERM (sent by parent shutdown).
 */
import { sweepStaleJobs } from './maintenance.ts';
import { envMs } from './env.ts';
import { reaperPidPath } from './state.ts';
import { unlinkSync, writeFileSync } from 'fs';

const SWEEP_INTERVAL_MS = envMs('WORKER_REAPER_MS', 2_000);

function exitCleanly(): void {
  try { unlinkSync(reaperPidPath()); } catch {}
  process.exit(0);
}

try { writeFileSync(reaperPidPath(), `${process.pid}\n`); } catch {}

function loop(): void {
  sweepStaleJobs({ fresh: true });
  setTimeout(loop, SWEEP_INTERVAL_MS).unref?.();
}

process.on('SIGTERM', exitCleanly);
process.on('SIGINT', exitCleanly);

loop();
