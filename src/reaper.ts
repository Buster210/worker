#!/usr/bin/env bun
import { sweepStaleJobs } from "./maintenance.ts";
import { getAllRunningJobsFresh, reaperPidPath } from "./state.ts";
import { envMs } from "./env.ts";
import { unlinkSync, writeFileSync } from "fs";

const SWEEP_INTERVAL_MS = envMs("WORKER_REAPER_MS", 10_000);

function exitCleanly(): void {
  try {
    unlinkSync(reaperPidPath());
  } catch {}
  process.exit(0);
}

function loop(): void {
  sweepStaleJobs({ fresh: true }); // reap running workers orphaned by a dead server
  if (getAllRunningJobsFresh().length === 0) exitCleanly();
  setTimeout(loop, SWEEP_INTERVAL_MS);
}

if (import.meta.main) {
  try {
    writeFileSync(reaperPidPath(), `${process.pid}\n`);
  } catch {}
  process.on("SIGTERM", exitCleanly);
  process.on("SIGINT", exitCleanly);
  loop();
}
