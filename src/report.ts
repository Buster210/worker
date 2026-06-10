#!/usr/bin/env bun
// Completion watcher + status-aware report. The agent fires this in the BACKGROUND right after a
// run/ladder call; it polls the lock and, when the job terminates, prints ONE bundle to stdout —
// front-loading the exact diff the agent would otherwise stop and fetch by hand. No MCP server
// needed: it reads the same filesystem state (job.json / ladder audit trail) the tools read.
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
import { getJob, getLadderHistory } from './state.ts';

const POLL_MS = Number(process.env.WORKER_REPORT_POLL_MS ?? 10_000);

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
async function waitForUnlock(lockPath: string): Promise<void> {
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
    const fallback = setInterval(() => {
      if (!existsSync(lockPath)) done();
    }, POLL_MS);
  });
}

if (import.meta.main) {
  const handle = process.argv[2];
  const lockPath = process.argv[3];
  if (!handle || !lockPath) {
    console.error('usage: bun run report.ts <handle> <lock_path>');
    process.exit(1);
  }
  await waitForUnlock(lockPath);
  console.log(renderReport(handle, lockPath));
}
