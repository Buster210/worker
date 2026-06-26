import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const STATE_DIR = join(tmpdir(), `sterm-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

const TEST_HOME = join(tmpdir(), `sterm-home-${process.pid}`);
process.env.HOME = TEST_HOME;
const ACTIVE_DIR = join(TEST_HOME, '.claude', '.active', 'worker');

import {
  __resetLivenessStateForTest, writeServerPid, removeServerPid,
  __checkClientLivenessForTest,
} from '../src/daemon.ts';
import { isProcessAlive, __resetPidCache } from '../src/process.ts';
import { insertJob, getJob, workersDir, __resetStateForTest } from '../src/state.ts';
import { sweepStaleWorkerDirs } from '../src/maintenance.ts';

const REPO = join(tmpdir(), `sterm-repo-${process.pid}`);
const livePids: number[] = [];
let seq = 0;

function spawnSleep(): number {
  const proc = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  proc.unref();
  livePids.push(proc.pid!);
  return proc.pid!;
}

function deadPid(): number { return 42_000_000 + seq++; }

function seedRunning(fields: {
  worker_pid: number; status?: string; server_pid?: number; backend?: string; finished?: string;
}): string {
  const handle = `sterm-${process.pid}-${seq++}`;
  const dir = join(workersDir(), 'test-repo', handle);
  mkdirSync(dir, { recursive: true });
  const job = {
    handle, backend: fields.backend ?? 'cmd', sid: 'test', repo: REPO,
    log_path: join(dir, 'run.log'), worker_pid: fields.worker_pid,
    server_pid: fields.server_pid ?? 0,
    server_started: fields.server_pid ? new Date().toISOString() : '',
    server_sid: 'test-sid', status: fields.status ?? 'running',
    started: new Date().toISOString(),
    finished: fields.finished,
    resume_token: '', model: '', task: '',
    completion_lock: join(dir, '.lock'),
  };
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  insertJob({
    handle, backend: job.backend, sid: job.sid, repo: job.repo,
    log_path: job.log_path, worker_pid: job.worker_pid,
    server_pid: job.server_pid, server_started: job.server_started,
    server_sid: job.server_sid,
  });
  return handle;
}

function ensureActiveDir(): void { mkdirSync(ACTIVE_DIR, { recursive: true }); }
function writeClientPid(pid: number): void { ensureActiveDir(); writeFileSync(join(ACTIVE_DIR, String(pid)), ''); }
function removeClientPid(pid: number): void { try { rmSync(join(ACTIVE_DIR, String(pid))); } catch {} }
function cleanupActiveDir(): void { try { rmSync(ACTIVE_DIR, { recursive: true, force: true }); } catch {} }

beforeEach(() => {
  ensureActiveDir();
  __resetLivenessStateForTest();
  __resetStateForTest();
  __resetPidCache();
});

afterEach(() => {
  __resetLivenessStateForTest();
  for (const pid of livePids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  livePids.length = 0;
  cleanupActiveDir();
});

// ── server.pid management ──────────────────────────────────────────

describe('server.pid management', () => {
  it('writeServerPid creates the file with our PID', () => {
    writeServerPid();
    const pidPath = join(ACTIVE_DIR, 'server.pid');
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, 'utf8')).toBe(String(process.pid));
  });

  it('removeServerPid deletes the file', () => {
    writeServerPid();
    removeServerPid();
    expect(existsSync(join(ACTIVE_DIR, 'server.pid'))).toBe(false);
  });

  it('removeServerPid is idempotent when file absent', () => {
    removeServerPid();
    removeServerPid();
    expect(existsSync(join(ACTIVE_DIR, 'server.pid'))).toBe(false);
  });
});

// ── safety gate: never-saw-a-client ────────────────────────────────

describe('never-saw-a-client safety gate', () => {
  it('does not self-terminate when .active/worker/ has only server.pid', () => {
    cleanupActiveDir();
    ensureActiveDir();
    writeServerPid();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    __checkClientLivenessForTest();
    __checkClientLivenessForTest();
    __checkClientLivenessForTest();

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('does not self-terminate when .active/worker/ is completely empty', () => {
    cleanupActiveDir();
    ensureActiveDir();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    __checkClientLivenessForTest();
    __checkClientLivenessForTest();

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// ── live client prevents shutdown ──────────────────────────────────

describe('live client prevents shutdown', () => {
  it('resets empty tick counter when client PID is alive', () => {
    const clientPid = spawnSleep();
    writeClientPid(clientPid);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    __checkClientLivenessForTest();
    for (let i = 0; i < 5; i++) __checkClientLivenessForTest();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(isProcessAlive(clientPid)).toBe(true);
    exitSpy.mockRestore();
  });
});

// ── two-tick self-termination (the critical path) ─────────────────

describe('self-termination after two consecutive empty ticks', () => {
  it('finalizes workers as killed:no-client and invokes hardShutdown', () => {
    // Arm the daemon: write a PID file (dead but present) so _everSeenClient flips to true.
    // The daemon arms on file presence alone — it doesn't check liveness during arming.
    const armPid = deadPid();
    writeClientPid(armPid);
    __checkClientLivenessForTest(); // tick 1: arms, then sees PID dead, re-read finds it → counter reset

    // Now remove the file so the daemon sees an empty directory
    removeClientPid(armPid);

    // Create a running worker with a dead PID
    const workerPid = deadPid();
    const handle = seedRunning({ worker_pid: workerPid });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    // Tick 2: cached armPid dead → re-read empty → _emptyTickCount = 1
    __checkClientLivenessForTest();
    expect(exitSpy).not.toHaveBeenCalled();

    // Tick 3: _emptyTickCount = 2 >= threshold → fresh re-read → still empty → fire
    __checkClientLivenessForTest();

    expect(exitSpy).toHaveBeenCalledWith(0);

    // Verify worker was finalized as killed:no-client
    const job = getJob(handle);
    expect(job).not.toBeNull();
    expect(job!.status).toBe('killed:no-client');

    exitSpy.mockRestore();
  });

  it('resets counter when a new client appears between ticks', () => {
    // Arm with a dead PID file
    const armPid = deadPid();
    writeClientPid(armPid);
    __checkClientLivenessForTest();

    // Remove the file to simulate client gone
    removeClientPid(armPid);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    // Tick 2: counter = 1
    __checkClientLivenessForTest();
    expect(exitSpy).not.toHaveBeenCalled();

    // New client arrives (live process)
    const newClientPid = spawnSleep();
    writeClientPid(newClientPid);

    // Tick 3: fresh re-read finds newClientPid alive → resets
    __checkClientLivenessForTest();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('does not fire when fresh re-read finds a live client at trigger moment', () => {
    const armPid = deadPid();
    writeClientPid(armPid);
    __checkClientLivenessForTest();

    removeClientPid(armPid);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    // Tick 2: counter = 1
    __checkClientLivenessForTest();

    // Late client appears before tick 3
    const latePid = spawnSleep();
    writeClientPid(latePid);

    // Tick 3: fresh re-read finds latePid alive → no fire
    __checkClientLivenessForTest();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});

// ── sweepStaleWorkerDirs ──────────────────────────────────────────

describe('sweepStaleWorkerDirs', () => {
  it('cleans terminal job dirs but preserves killed:no-client dirs', () => {
    const doneHandle = seedRunning({ worker_pid: deadPid(), status: 'done', finished: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    const killedHandle = seedRunning({ worker_pid: deadPid(), status: 'killed:no-client', finished: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    const runningHandle = seedRunning({ worker_pid: spawnSleep(), status: 'running' });

    sweepStaleWorkerDirs();

    expect(existsSync(join(workersDir(), 'test-repo', doneHandle))).toBe(false);
    expect(existsSync(join(workersDir(), 'test-repo', killedHandle))).toBe(true);
    expect(existsSync(join(workersDir(), 'test-repo', runningHandle))).toBe(true);
  });

  it('skips dirs owned by another live server', () => {
    const otherServerPid = spawnSleep();
    const handle = seedRunning({
      worker_pid: deadPid(), status: 'done',
      server_pid: otherServerPid,
      finished: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });

    sweepStaleWorkerDirs();

    expect(existsSync(join(workersDir(), 'test-repo', handle))).toBe(true);
  });

  it('cleans dirs whose owning server is dead', () => {
    const handle = seedRunning({
      worker_pid: deadPid(), status: 'done',
      server_pid: deadPid(),
      finished: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });

    sweepStaleWorkerDirs();

    expect(existsSync(join(workersDir(), 'test-repo', handle))).toBe(false);
  });
});
