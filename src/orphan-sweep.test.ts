import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Point the state store at a throwaway dir BEFORE any state/runner fn runs. state.ts resolves
// WORKER_STATE_DIR lazily (no eager import-time mkdir). No module mocks here on purpose — a
// global mock.module leaks across test files in one `bun test` run and would break runner.test.ts.
// Instead we drive the REAL killProcessTree against real `sleep` processes.
const STATE_DIR = join(tmpdir(), `worphan-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
// Capture the runner's view of THIS server's sid so seedRunning() can tag jobs as "ours" —
// without matching server_sid, the new sid-aware orphan check skips every seeded job.
const THIS_SID = process.env.CLAUDE_CODE_SESSION_ID ?? `test-sid-${process.pid}`;
process.env.CLAUDE_CODE_SESSION_ID = THIS_SID;

import { sweepStaleJobs } from './maintenance.ts';
import { isProcessAlive } from './process.ts';
import { insertJob, getJob, logPath as stateLogPath } from './state.ts';

const REPO = join(tmpdir(), `worphan-repo-${process.pid}`);
const livePids: number[] = [];
let seq = 0;

// Real detached, group-leading process so killProcessTree(-pid) reaches it. Stays alive 300s.
function spawnSleep(): number {
  const proc = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  proc.unref();
  const pid = proc.pid!;
  livePids.push(pid);
  return pid;
}

// PID space well above anything a fresh test box will have allocated → process.kill throws → dead.
function deadPid(): number { return 42_000_000 + seq++; }

function seedRunning(fields: {
  worker_pid: number;
  server_pid?: number;
  server_started?: string;
  resume_token?: string;
  server_sid?: string;
}): string {
  const handle = `orphan-${process.pid}-${seq++}`;
  insertJob({
    handle, backend: 'cmd', sid: 'test', repo: REPO,
    log_path: stateLogPath(handle, REPO),
    worker_pid: fields.worker_pid,
    resume_token: fields.resume_token,
    server_pid: fields.server_pid ?? 0,
    server_started: fields.server_started ?? '',
    server_sid: fields.server_sid ?? THIS_SID,
  });
  return handle;
}

afterEach(() => {
  for (const pid of livePids) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  livePids.length = 0;
});

afterAll(() => {
  try { rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(REPO, { recursive: true, force: true }); } catch {}
});

describe('sweepStaleJobs — orphan branch', () => {
  it('kills + finalizes resumable a job whose server is dead but worker alive', async () => {
    const workerPid = spawnSleep();                 // real, alive
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: deadPid(),                          // owner server is gone
      server_started: new Date().toISOString(),
      resume_token: 'tok-orphan-1',
    });

    sweepStaleJobs();

    const job = getJob(handle)!;
    expect(job).not.toBeNull();
    expect(job.status).toBe('failed');                // resumable terminal
    expect(job.resume_token).toBe('tok-orphan-1');    // token preserved for worker_resume
    await Bun.sleep(100);                             // let the kernel reap the SIGKILL'd group
    expect(isProcessAlive(workerPid)).toBe(false);    // real worker process reaped
  });

  it('leaves a job whose owning server is alive untouched', () => {
    const serverPid = spawnSleep();                   // owner server still running
    const workerPid = spawnSleep();
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: serverPid,
      server_started: new Date().toISOString(),
    });

    sweepStaleJobs();

    expect(getJob(handle)!.status).toBe('running');   // not swept
    expect(isProcessAlive(workerPid)).toBe(true);     // worker still alive
  });

  it('leaves a worker_pid=0 job (claude_tmux / insert window) whose owning server is alive untouched', () => {
    const serverPid = spawnSleep();                   // owner server still running
    const handle = seedRunning({
      worker_pid: 0,                                   // tmux jobs carry 0; also the post-insert window
      server_pid: serverPid,
      server_started: new Date().toISOString(),
    });

    sweepStaleJobs();

    // The live in-process runner owns finalization; the periodic sweep must not finalize it
    // failed:server-restart just because worker_pid is 0.
    expect(getJob(handle)!.status).toBe('running');
  });

  it('leaves a legacy job (server_pid 0) untouched', () => {
    const workerPid = spawnSleep();
    const handle = seedRunning({ worker_pid: workerPid }); // server_pid defaults to 0

    sweepStaleJobs();

    expect(getJob(handle)!.status).toBe('running');   // orphan branch skipped on server_pid 0
    expect(isProcessAlive(workerPid)).toBe(true);
  });

  it('leaves a job owned by a different sid untouched (cross-server isolation)', () => {
    // A14 fix: server_sid is the unique-per-session identity. A recycled pid + coincident start
    // time cannot make another server's job look like ours — different sid → skipped.
    const workerPid = spawnSleep();
    const handle = seedRunning({
      worker_pid: workerPid,
      server_pid: deadPid(),          // owner is "dead" by pid/start
      server_started: new Date().toISOString(),
      server_sid: 'some-other-sid',   // but owner is a DIFFERENT server (different session)
    });

    sweepStaleJobs();

    // The other server's own orphan sweep owns this job; we must not touch it.
    expect(getJob(handle)!.status).toBe('running');
    expect(isProcessAlive(workerPid)).toBe(true);
  });
});
