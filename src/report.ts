#!/usr/bin/env bun
import { existsSync, statSync } from 'fs';
import { basename } from 'path';
import { spawnSync } from 'child_process';
import { getJobFresh, getLadderHistory, lockPath } from './state.ts';
import { nearExpiryMs, graceMs } from './env.ts';
import { FILE_CONFIG } from './config.ts';

function reportPollMs(): number {
  const v = Number(process.env.WORKER_REPORT_POLL_MS);
  if (Number.isFinite(v) && v > 0) return v;
  return FILE_CONFIG.reportPollMs ?? 150;
}

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

export function statusLine(status: string): string {
  return status === 'done' ? 'completed' : status;
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
  const line = statusLine(status);
  if (!wantsDiff(status)) return line;
  const job = getJobFresh(handle);
  if (!job?.repo) return `${line}\n\n(diff unavailable: unknown handle ${handle})`;
  const diffDir = job.worktree_path ?? job.repo;
  const body = diff(diffDir, job.base_sha);
  const warn = status === 'done' && body === '(no tracked changes)'
    ? '\n\nWARNING: completed but worktree has no changes vs base — work may be missing.'
    : '';
  return `${line}\nworktree: ${diffDir}\nbranch: worker/${handle}\n\n${body}${warn}`;
}

function ownerDead(serverPid: number): boolean {
  if (!serverPid) return false;
  try { process.kill(serverPid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export async function waitForUnlock(lockPath: string, serverPid = 0): Promise<void> {
  if (!existsSync(lockPath)) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  const interval = setInterval(() => {
    if (!existsSync(lockPath)) { clearInterval(interval); resolve(); return; }
    if (ownerDead(serverPid)) { clearInterval(interval); resolve(); }
  }, reportPollMs());
  interval.unref?.();
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

if (import.meta.main) {
  const handle = process.argv[2];
  if (!handle) {
    console.error('usage: worker-report <handle>');
    process.exit(1);
  }
  const job = getJobFresh(handle);
  if (!job) {
    console.error(`report: unknown handle ${handle}`);
    process.exit(1);
  }

  // Pre-expiry early return: if the job is still running and we're within
  // NEAR_MS of deadline_at, emit a single dense status bundle instead of blocking.
  const now = Date.now();
  const deadline = job.deadline_at ?? 0;
  const nearMs = nearExpiryMs();
  if (job.status === 'running' && deadline > 0 && deadline - now <= nearMs && deadline - now > -nearMs) {
    const lastMtime = logMtimeMs(job.log_path);
    const secsSinceActivity = lastMtime > 0 ? Math.round((now - lastMtime) / 1000) : -1;
    const working = lastMtime <= 0 || (now - lastMtime) < 5_000;
    const stat = gitDiffStat(job.worktree_path ?? job.repo);
    const statLine = stat ? ` · ${stat.split('\n').pop() ?? ''}` : '';
    const activityPart = secsSinceActivity >= 0 ? `last-activity ${secsSinceActivity}s ago` : 'no activity';
    const graceSec = Math.round(graceMs() / 1000);
    console.log(`NEAR_TIMEOUT ${handle} · ${working ? 'working' : 'stalled'} · ${activityPart}${statLine} · extend: worker_extend(${handle},<secs>) — else hard-killed ${graceSec}s past deadline`);
  } else {
    const lock = job.completion_lock || lockPath(handle, job.repo);
    await waitForUnlock(lock, job.server_pid);
    console.log(renderReport(handle, lock));
  }
}
