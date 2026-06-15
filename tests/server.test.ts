import { describe, it, expect, afterAll } from 'bun:test';
import { writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Throwaway state store, set BEFORE importing server/state (resolution is lazy).
const STATE_DIR = join(tmpdir(), `wserver-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
const PLANS_DIR = join(tmpdir(), `wserver-plans-${process.pid}`);
process.env.WORKER_PLANS_DIR = PLANS_DIR;

// server.ts only boots the stdio transport under `import.meta.main`, so importing it
// here registers the tools as a side effect but does NOT connect/hang the test runner.
import { reply, handleStatus, handleKill, handleResume, handleList, handleDoctor } from '../src/server.ts';
import { insertJob, updateJob, finalizeJob, getJob, logPath as stateLogPath } from '../src/state.ts';
import { workerEnv } from '../src/env.ts';

mkdirSync(PLANS_DIR, { recursive: true });
const REPO = '/tmp/wserver-repo';
const handles: string[] = [];
let seq = 0;

function seedJob(status: string, fields: Parameters<typeof updateJob>[1] = {}): string {
  const handle = `srv-${process.pid}-${seq++}`;
  handles.push(handle);
  insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: stateLogPath(handle, REPO) });
  updateJob(handle, { status, ...fields });
  return handle;
}

afterAll(() => {
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(PLANS_DIR, { recursive: true, force: true }); } catch {}
});

describe('handleDoctor', () => {
  it('names a backend that is not operational, hiding the rest', () => {
    expect(handleDoctor({ backend: 'definitely-not-a-real-backend-xyz' }))
      .toBe('Not operational: definitely-not-a-real-backend-xyz');
  });
});

describe('reply envelope', () => {
  it('passes strings through verbatim (human-readable kill/doctor text)', () => {
    expect(reply('killed: x (done)')).toEqual({ content: [{ type: 'text', text: 'killed: x (done)' }] });
  });
  it('JSON-encodes objects', () => {
    expect(reply({ handle: 'h', status: 'running' }))
      .toEqual({ content: [{ type: 'text', text: '{"handle":"h","status":"running"}' }] });
  });
});

describe('handleStatus', () => {
  it('returns only the live signal (status/alive/started), omitting caller-known + internal fields', () => {
    const handle = seedJob('running');
    const s = handleStatus({ handle });
    expect(s.status).toBe('running');
    expect(s.alive).toBe(false); // worker_pid 0 → not alive
    expect('started' in s).toBe(true);
    // caller-known context (handle/repo/task) and internals (backend/worker_pid/resume_token/log_path) are not echoed back
    for (const k of ['handle', 'repo', 'task', 'backend', 'worker_pid', 'resume_token', 'log_path', 'kill_requested', 'sid', 'model']) {
      expect(k in s).toBe(false);
    }
  });
  it('throws when the handle is unknown', () => {
    expect(() => handleStatus({ handle: 'nope' })).toThrow(/No job found/);
  });
});

describe('handleKill', () => {
  it('reports "already <status>" for a terminal job without touching it', () => {
    const handle = seedJob('done');
    expect(handleKill({ handle })).toBe(`already done`);
  });
  it('finalizes a dead-pid running job and applies kill precedence', () => {
    const handle = seedJob('running'); // worker_pid 0 → no live process, no SIGTERM/timer
    writeFileSync(stateLogPath(handle, REPO), 'FAILED\n'); // resolveStatus → failed
    expect(handleKill({ handle })).toBe(`killed: ${handle} (killed)`); // kill_requested beats failed
    expect(getJob(handle)?.status).toBe('killed');
  });
  it('kills claude_tmux job when tmux session does not exist (swallows error)', () => {
    // claude_tmux backend fires tmux kill-session; if the session never existed,
    // tmux returns error but the code catches it silently and proceeds to finalize.
    const handle = seedJob('running', { worker_pid: 0 }); // claude_tmux jobs have worker_pid 0
    updateJob(handle, { backend: 'claude_tmux' }); // override to claude_tmux
    writeFileSync(stateLogPath(handle, REPO), 'FAILED\n');
    // tmux kill-session will fail (no session), but we still get killed status
    expect(handleKill({ handle })).toBe(`killed: ${handle} (killed)`);
    expect(getJob(handle)?.status).toBe('killed');
  });
});

describe('handleResume', () => {
  it('throws when the handle is unknown', () => {
    const specFile = 'ghost-spec.md';
    writeFileSync(join(PLANS_DIR, specFile), 'ghost spec');
    expect(() => handleResume({ handle: 'ghost', specFile, dir: REPO })).toThrow(/No job found/);
  });
});

describe('handleList', () => {
  it('finds nested <project>/<handle> jobs, strips backend, honors the status filter', () => {
    const a = seedJob('done');
    const b = seedJob('running');

    const all = handleList({});
    const found = all.map(j => j.handle);
    expect(found).toContain(a);            // pre-fix one-level read returned [] for every nested job
    expect(found).toContain(b);
    expect(all.every(j => !('backend' in j))).toBe(true);

    const running = handleList({ status: 'running' }).map(j => j.handle);
    expect(running).toContain(b);
    expect(running).not.toContain(a);
  });
  it('returns only {handle,status,repo,task,started} — no internal field leaks', () => {
    const h = seedJob('running', { worker_pid: 42, model: 'opus', task: 'build feat' });
    const rows = handleList({});
    const row = rows.find(r => r.handle === h)!;
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(['handle', 'repo', 'started', 'status', 'task']);
  });

  it('orders by started desc and honors limit', () => {
    // Use 2027 timestamps (future) so they sort above any existing 2026 jobs
    const h1 = seedJob('done');
    updateJob(h1, { started: '2027-01-01T00:00:00.000Z' });
    const h2 = seedJob('running');
    updateJob(h2, { started: '2027-06-01T00:00:00.000Z' });
    const h3 = seedJob('failed');
    updateJob(h3, { started: '2027-03-01T00:00:00.000Z' });

    const all = handleList({ limit: 50 });
    const handles = all.map(j => j.handle);
    // h2 (Jun) > h3 (Mar) > h1 (Jan) by started desc
    expect(handles.indexOf(h2)).toBeLessThan(handles.indexOf(h3));
    expect(handles.indexOf(h3)).toBeLessThan(handles.indexOf(h1));

    const limited = handleList({ limit: 2 });
    expect(limited.length).toBe(2);
    expect(limited[0].handle).toBe(h2);
  });

  it('status filter is exact (partial match does not bleed)', () => {
    const running = seedJob('running');
    const failed = seedJob('failed');
    const failedReason = seedJob('failed:max-turns');

    const result = handleList({ status: 'failed' }).map(j => j.handle);
    expect(result).toContain(failed);
    // 'failed:max-turns' does NOT match status === 'failed'
    expect(result).not.toContain(failedReason);
    expect(result).not.toContain(running);
  });
});

describe('handleDoctor — success path', () => {
  it('reports "All workers operational." when a stub backend is on PATH', () => {
    const stubDir = mkdtempSync(join(tmpdir(), `wserver-stub-${process.pid}-${seq++}`));
    const stubPath = join(stubDir, 'test-be');
    writeFileSync(stubPath, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const savedPath = workerEnv().PATH;
    workerEnv().PATH = `${stubDir}:${savedPath}`;
    try {
      expect(handleDoctor({ backend: 'test-be' })).toBe('All workers operational.');
    } finally {
      workerEnv().PATH = savedPath;
      try { rmSync(stubDir, { recursive: true, force: true }); } catch {}
    }
  });
});
