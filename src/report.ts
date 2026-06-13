#!/usr/bin/env bun
import { existsSync } from 'fs';
import { basename } from 'path';
import { spawnSync } from 'child_process';
import { getJobFresh, getLadderHistory, lockPath } from './state.ts';

function reportPollMs(): number {
  const v = Number(process.env.WORKER_REPORT_POLL_MS);
  return Number.isFinite(v) && v > 0 ? v : 150;
}

export function terminalStatus(handle: string, lockPath: string): string {
  if (lockPath.endsWith('.chain.lock')) {
    const sid = basename(lockPath).replace(/\.chain\.lock$/, '');
    const rows = getLadderHistory(sid);
    const last = rows.length ? rows[rows.length - 1].result : 'failed';
    if (last === 'done') return 'done';
    if (last === 'killed') return 'killed';
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

function gitDiff(repo: string): string {
  const r = spawnSync('git', ['-C', repo, 'diff'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
  const repo = getJobFresh(handle)?.repo;
  if (!repo) return `${line}\n\n(diff unavailable: unknown handle ${handle})`;
  return `${line}\n\n${diff(repo)}`;
}

function ownerDead(serverPid: number): boolean {
  if (!serverPid) return false;
  try { process.kill(serverPid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export async function waitForUnlock(lockPath: string, serverPid = 0): Promise<void> {
  if (!existsSync(lockPath)) return;
  return new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (!existsSync(lockPath)) { clearInterval(interval); resolve(); return; }
      if (ownerDead(serverPid)) { clearInterval(interval); resolve(); }
    }, reportPollMs());
    interval.unref?.();
  });
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
  const lock = job.completion_lock || lockPath(handle, job.repo);
  await waitForUnlock(lock, job.server_pid);
  console.log(renderReport(handle, lock));
}
