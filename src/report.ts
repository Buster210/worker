#!/usr/bin/env bun
import { existsSync, statSync } from 'fs';
import { basename } from 'path';
import { spawnSync } from 'child_process';
import { getJobFresh, getLadderHistory, lockPath } from './state.ts';
import { nearExpiryMs, graceMs } from './env.ts';
import { FILE_CONFIG } from './config.ts';


export function terminalStatus(handle: string, lockPath: string): string {
  if (lockPath.endsWith('.chain.lock')) {
    const sid = basename(lockPath).replace(/\.chain\.lock$/, '');
    const rows = getLadderHistory(sid);
    const last = rows.length ? rows[rows.length - 1].result : 'failed';
    if (last === 'done') return 'done';
    if (last === 'killed') return 'killed';
    if (last === 'timeout') return 'timeout'; // terminal in the chain — surface it, don't collapse to exhausted
    return 'exhausted';
  }
  return getJobFresh(handle)?.status ?? 'failed';
}

export type LadderRun = { turn: number; worker: string; result: string };

export function statusLine(status: string, branch?: string, baseSha?: string, ladderRuns?: LadderRun[]): string {
  if (status === 'done') {
    const ref = branch ?? 'current branch';
    const base = baseSha ? ` (base ${baseSha})` : '';
    return `completed — worker committed changes to branch ${ref}${base}. Review the diff below and merge; nothing else to run.`;
  }
  if (status === 'exhausted' && ladderRuns?.length) {
    const breakdown = ladderRuns.map(r => `  rung ${r.turn}: ${r.worker} → ${r.result}`).join('\n');
    return `LADDER EXHAUSTED — no backend completed the task. Breakdown:\n${breakdown}`;
  }
  return status;
}

export function wantsDiff(status: string): boolean {
  return status !== 'stopped' && status !== 'killed';
}

function gitDiff(repo: string, baseSha?: string): string {
  const args = baseSha ? ['-C', repo, 'diff', baseSha] : ['-C', repo, 'diff'];
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || typeof r.stdout !== 'string') {
    console.error(`report: git diff failed in ${repo || '<empty repo path>'}: ${r.error?.message ?? 'no stdout'}`);
    return '(diff unavailable)';
  }
  return r.stdout.trim() || '(no tracked changes)';
}

export function renderReport(handle: string, lockPath: string, diff: (repo: string, baseSha?: string) => string = gitDiff): string {
  const status = terminalStatus(handle, lockPath);
  let ladderRuns: LadderRun[] | undefined;
  if (status === 'exhausted' && lockPath.endsWith('.chain.lock')) {
    const sid = basename(lockPath).replace(/\.chain\.lock$/, '');
    ladderRuns = getLadderHistory(sid);
  }
  if (!wantsDiff(status)) return statusLine(status);
  const job = getJobFresh(handle);
  const line = statusLine(status, job?.branch, job?.base_sha, ladderRuns);
  if (!job?.repo) return `${line}\n\n(diff unavailable: unknown handle ${handle})`;
  const diffDir = job.worktree_path ?? job.repo;
  const body = diff(diffDir, job.base_sha);
  const warn = status === 'done' && body === '(no tracked changes)'
    ? '\n\nWARNING: completed but worktree has no changes vs base — work may be missing.'
    : '';
  return `${line}\nworktree: ${diffDir}\nbranch: ${job.branch ?? `worker/${handle}`}\n\n${body}${warn}`;
}

function ownerDead(serverPid: number): boolean {
  if (!serverPid) return false;
  try { process.kill(serverPid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

// True when a still-running job sits inside the [deadline-NEAR, deadline+NEAR] window —
// the band where we stop blocking and surface a NEAR_TIMEOUT bundle so the caller can extend.
export function isNearTimeout(job: { status: string; deadline_at?: number } | null | undefined, now: number): boolean {
  if (!job || job.status !== 'running') return false;
  const deadline = job.deadline_at ?? 0;
  const nearMs = nearExpiryMs();
  return deadline > 0 && deadline - now <= nearMs && deadline - now > -nearMs;
}

// 'unlocked' = lock cleared or owner died (caller renders the terminal report);
// 'near_timeout' = job entered the near-deadline band mid-wait (caller prints the NEAR_TIMEOUT line).
export async function waitForUnlock(lockPath: string, serverPid = 0, handle?: string): Promise<'unlocked' | 'near_timeout'> {
  if (!existsSync(lockPath)) return 'unlocked';
  const { promise, resolve } = Promise.withResolvers<'unlocked' | 'near_timeout'>();

  let settled = false;
  const settle = (result: 'unlocked' | 'near_timeout') => {
    if (settled) return;
    settled = true;
    clearInterval(poller);
    resolve(result);
  };

  // ponytail: poll-only, NO fs.watch. On Bun/macOS, watch() on a lock that lives in a busy
  // dir (the ladder/ chain dir gets sibling .chain.meta + history writes) storms the kqueue
  // callback and pegs a core for the whole wait — the exact bug already removed from monitor.ts.
  // A 5s existsSync poll is ~0 CPU and reactive enough for a completion blocker (workers run minutes).
  const poll = () => {
    if (!existsSync(lockPath)) { settle('unlocked'); return; }
    if (handle && isNearTimeout(getJobFresh(handle), Date.now())) { settle('near_timeout'); return; }
    if (ownerDead(serverPid)) settle('unlocked');
  };
  // ponytail: do NOT unref this timer. It IS the process's keep-alive until unlock, and
  // unref'ing it while a top-level await is pending makes Bun busy-spin the event loop
  // (~80% CPU for the whole wait) instead of sleeping between ticks. Leaving it ref'd lets
  // the loop sleep (~0 CPU); the process still exits cleanly — settle() clears the interval
  // (→ await resolves → main ends) and stdin-close hits process.exit(0).
  const pollMs = Number(process.env.WORKER_REPORT_POLL_MS);
  const poller = setInterval(poll, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 5000);
  poll(); // immediate: lock may already be gone / job already in near band / owner already dead

  return promise;
}

function gitDiffStat(repo: string): string {
  const r = spawnSync('git', ['-C', repo, 'diff', '--stat'], { encoding: 'utf8', timeout: 5000 });
  if (r.error || typeof r.stdout !== 'string') return '';
  return r.stdout.trim();
}

function logMtimeMs(logPath: string): number {
  try { return statSync(logPath).mtimeMs; } catch { return 0; }
}

// One dense line: is the worker still moving, how stale, what it has touched, and how to extend
// before the grace window hard-kills it. Emitted instead of blocking when isNearTimeout() is true.
export function nearTimeoutLine(handle: string, job: { log_path: string; worktree_path?: string; repo: string }): string {
  const now = Date.now();
  const lastMtime = logMtimeMs(job.log_path);
  const secsSinceActivity = lastMtime > 0 ? Math.round((now - lastMtime) / 1000) : -1;
  const working = lastMtime > 0 && (now - lastMtime) < 5_000; // no log activity near the deadline = stalled, not working
  const stat = gitDiffStat(job.worktree_path ?? job.repo);
  const statLine = stat ? ` · ${stat.split('\n').pop() ?? ''}` : '';
  const activityPart = secsSinceActivity >= 0 ? `last-activity ${secsSinceActivity}s ago` : 'no activity';
  const graceSec = Math.round(graceMs() / 1000);
  return `NEAR_TIMEOUT ${handle} · ${working ? 'working' : 'stalled'} · ${activityPart}${statLine} · keep going: worker_extend(${handle},<secs>) · let it end: worker-report ${handle} --wait (blocks to final) — else hard-killed ${graceSec}s past deadline`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const wait = argv.includes('--wait'); // --wait = block straight through to the terminal report, ignoring the near-timeout signal
  const handle = argv.find(a => !a.startsWith('-'));
  if (!handle) {
    console.error('usage: worker-report <handle> [--wait]');
    process.exit(1);
  }
  const job = getJobFresh(handle);
  if (!job) {
    console.error(`report: unknown handle ${handle}`);
    process.exit(1);
  }

  // Pre-expiry early return: if the job is already inside the near-deadline band, emit a single
  // dense status bundle instead of blocking. Otherwise block on the completion lock, but keep
  // watching the deadline — a job that crosses into the band mid-wait breaks out with NEAR_TIMEOUT
  // so the caller can extend before the grace window hard-kills it.
  if (!wait && isNearTimeout(job, Date.now())) {
    console.log(nearTimeoutLine(handle, job));
  } else {
    const lock = job.completion_lock || lockPath(handle, job.repo);
    const why = await waitForUnlock(lock, job.server_pid, wait ? undefined : handle);
    if (why === 'near_timeout') {
      console.log(nearTimeoutLine(handle, getJobFresh(handle) ?? job));
    } else {
      console.log(renderReport(handle, lock));
    }
  }
}
