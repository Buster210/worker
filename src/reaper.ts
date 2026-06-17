#!/usr/bin/env bun
/**
 * External reaper — detached background process that periodically sweeps for
 * orphaned workers. Survives SIGKILL of the parent CC/MCP process so workers
 * don't linger until next startup.
 *
 * Spawned by lifecycle.ts as a detached child. Sweeps every WORKER_REAPER_MS
 * (default 2s). Independent: it does not depend on its spawner staying alive.
 * But to avoid becoming an orphan itself, each tick it checks whether ANY
 * worker MCP server (`bun ... src/server.ts`, which only runs under Claude Code)
 * is still alive; when none is, it does a final sweep and exits. A later server
 * startup respawns it via spawnReaper(). Also exits on SIGTERM (parent shutdown).
 */
import { sweepStaleJobs } from './maintenance.ts';
import { envMs } from './env.ts';
import { reaperPidPath } from './state.ts';
import { spawnSync } from 'child_process';
import { unlinkSync, writeFileSync } from 'fs';

const SWEEP_INTERVAL_MS = envMs('WORKER_REAPER_MS', 2_000);
// The server entry's path tail (e.g. "src/server.ts"), derived from this file's sibling.
// Matching the tail — not the absolute path — catches the server whether Claude Code
// launched it absolute (the mcp config form) or relative (dev/manual). Safe direction:
// a false positive only makes the reaper LINGER; only a false negative would self-kill it
// while a server is alive, and the tail match makes that essentially impossible.
const SERVER_PATH = new URL('./server.ts', import.meta.url).pathname;
const _srcIdx = SERVER_PATH.lastIndexOf('/src/');
const SERVER_NEEDLE = _srcIdx >= 0 ? SERVER_PATH.slice(_srcIdx + 1) : SERVER_PATH;

/** Pure: does any `ps` line other than `selfPid` look like a live worker MCP server? */
export function serverAliveInPs(psOutput: string, needle: string, selfPid: number): boolean {
  for (const line of psOutput.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    const pid = Number(sp === -1 ? t : t.slice(0, sp));
    if (pid === selfPid) continue;
    if (t.includes(needle)) return true;
  }
  return false;
}

function anyClaudeCodeAlive(): boolean {
  // Any ps failure -> assume alive (never self-kill on doubt; lingering is the safe failure,
  // orphaning workers is not).
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (out.status !== 0 || !out.stdout) return true;
  return serverAliveInPs(out.stdout, SERVER_NEEDLE, process.pid);
}

function exitCleanly(): void {
  try { unlinkSync(reaperPidPath()); } catch {}
  process.exit(0);
}

function loop(): void {
  sweepStaleJobs({ fresh: true });            // also serves as the final sweep on the exit tick
  if (!anyClaudeCodeAlive()) exitCleanly();   // no worker MCP server left -> don't linger as an orphan
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
