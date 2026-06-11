#!/usr/bin/env bun
// Completion watcher + status-aware report. The agent fires this in the BACKGROUND right after a
// run/ladder call with just the handle; it watches the job's completion lock (event-driven, via
// fs.watch) and, when the job terminates, prints ONE bundle to stdout — front-loading the exact
// diff the agent would otherwise stop and fetch by hand. No MCP server needed: it reads the same
// filesystem state (job.json / ladder audit trail) the tools read.
//
// Output schema (locked):
//   done      -> "completed"        + blank line + full `git diff`
//   failed*   -> "failed[:reason]"  + blank line + full `git diff`
//   timeout   -> "timeout"          + blank line + full `git diff`
//   exhausted -> "exhausted"        + blank line + full `git diff`
//   stopped   -> "stopped"          (single line, no diff — frozen/resumable, work is incomplete)
//   killed    -> "killed"           (single line, no diff — deliberate abort)
import { existsSync, watch } from 'fs';
import { basename, dirname } from 'path';
import { spawnSync } from 'child_process';
import { getJob, getLadderHistory, lockPath } from './state.ts';

// Resolved lazily (not a load-time const) so tests can set a tight interval, matching the lazy-env
// convention in state.ts/runner.ts/logParse.ts. Also guards a bad value: a non-numeric env would
// make Number() NaN and setInterval(fn, NaN) spin at 0ms — fall back to the default instead.
function reportPollMs(): number {
  const v = Number(process.env.WORKER_REPORT_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : 10_000;
}

// Resolve the TRUE terminal status. A ladder's rung-0 job.json is misleading (it shows rung 0's own
// outcome, not the chain's), so for a chain lock we read the ladder audit trail instead: a ladder can
// only terminate done / killed / exhausted — stopped & timeout are absorbed internally (resume→climb),
// so any non-done/non-killed last row means the chain exhausted. A per-handle lock = a single run,
// whose job.json status IS terminal (status is persisted before the lock is removed).
export function terminalStatus(handle: string, lockPath: string): string {
  if (lockPath.endsWith('.chain.lock')) {
    const sid = basename(lockPath).replace(/\.chain\.lock$/, '');
    const rows = getLadderHistory(sid);
    const last = rows.length ? rows[rows.length - 1].result : 'failed';
    if (last === 'done') return 'done';
    if (last === 'killed') return 'killed';
    return 'exhausted';
  }
  return getJob(handle)?.status ?? 'failed';
}

// done collapses to the single word "completed"; every other status is reported verbatim (preserving
// the failed:<reason> family) so its word carries the next action the agent already knows from the status model.
export function statusLine(status: string): string {
  return status === 'done' ? 'completed' : status;
}

// stopped (frozen, resumable — work incomplete) and killed (deliberate abort) get no diff; showing a
// half-done tree would tempt the agent to judge unfinished work as final.
export function wantsDiff(status: string): boolean {
  return status !== 'stopped' && status !== 'killed';
}

function gitDiff(repo: string): string {
  const r = spawnSync('git', ['-C', repo, 'diff'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // spawnSync reports a genuine failure (git missing, bad cwd) via r.error, NOT a throw — surface it
  // to stderr so a real failure is distinguishable from an empty (clean) diff, never silently swallowed.
  if (r.error || typeof r.stdout !== 'string') {
    console.error(`report: git diff failed in ${repo || '<empty repo path>'}: ${r.error?.message ?? 'no stdout'}`);
    return '(diff unavailable)';
  }
  return r.stdout.trim() || '(no tracked changes)';
}

export function renderReport(handle: string, lockPath: string, diff: (repo: string) => string = gitDiff): string {
  const status = terminalStatus(handle, lockPath);
  const line = statusLine(status);
  if (!wantsDiff(status)) return line;
  // Hard-fail on an unknown handle rather than letting an empty repo path diff the watcher's own cwd
  // (`git -C '' diff` silently succeeds against wherever the watcher runs → a plausible but wrong tree).
  const repo = getJob(handle)?.repo;
  if (!repo) return `${line}\n\n(diff unavailable: unknown handle ${handle})`;
  return `${line}\n\n${diff(repo)}`;
}
// Liveness probe with no PID-reuse guard — a heuristic, deliberately lightweight so report.ts (a
// standalone bin) need not import runner.ts (whose module init spawns a login shell). Bails ONLY on
// ESRCH (process definitively gone); EPERM (alive but owned by another uid) reads as alive, so a
// cross-uid server is never mis-flagged dead. Worst case a reused PID reads as alive → keep waiting.
function ownerDead(serverPid: number): boolean {
  if (!serverPid) return false; // legacy/unknown owner → can't attribute, never bail on it
  try { process.kill(serverPid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export async function waitForUnlock(lockPath: string, serverPid = 0): Promise<void> {
  if (!existsSync(lockPath)) return;
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(fallback);
      watcher.close();
      resolve();
    };
    const watcher = watch(dirname(lockPath), () => {
      if (!existsSync(lockPath)) done();
    });
    watcher.on('error', () => { if (!existsSync(lockPath)) done(); });
    const fallback = setInterval(() => {
      // Lock cleared the normal way → done.
      if (!existsSync(lockPath)) { done(); return; }
      // Lock still held but the owning server is gone: a crashed/killed server can never finalize,
      // and a chain lock is never adopted by another server, so this lock would never clear. Bail and
      // let renderReport report the last known terminal state instead of hanging forever.
      if (ownerDead(serverPid)) done();
    }, reportPollMs());
  });
}

if (import.meta.main) {
  const handle = process.argv[2];
  if (!handle) {
    console.error('usage: worker-report <handle>');
    process.exit(1);
  }
  const job = getJob(handle);
  if (!job) {
    console.error(`report: unknown handle ${handle}`);
    process.exit(1);
  }
  // The completion lock is persisted on the job (chain lock for a ladder, per-handle lock for a
  // single run), so the handle alone is enough — no lock_path argument, no $sid-quoting footgun.
  const lock = job.completion_lock || lockPath(handle, job.repo);
  await waitForUnlock(lock, job.server_pid);
  console.log(renderReport(handle, lock));
}
