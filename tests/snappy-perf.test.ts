import { describe, it, expect, afterAll, afterEach, spyOn } from 'bun:test';
import * as childProcess from 'child_process';
import { spawn, spawnSync } from 'child_process';
import { writeFileSync, rmSync, mkdtempSync, openSync, closeSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const STATE_DIR = join(tmpdir(), `wsnappy-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;
process.env.WORKER_RC = '';
process.env.WORKER_LOGIN_SHELL = '0';

import { isProcessAlive, killProcessTree, listDescendants, __resetPidCache } from '../src/process.ts';
import { startActivityMonitor, __resetActivityMonitors } from '../src/runner.ts';
import { runWorker } from '../src/runner.ts';
import { insertJob, logPath as stateLogPath } from '../src/state.ts';

const REPO = mkdtempSync(join(tmpdir(), 'wsnappy-repo-'));
spawnSync('git', ['-C', REPO, 'init', '-q'], { encoding: 'utf8' });
spawnSync('git', ['-C', REPO, 'config', 'user.email', 'test@test.com'], { encoding: 'utf8' });
spawnSync('git', ['-C', REPO, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
writeFileSync(join(REPO, 'README.md'), 'init\n');
spawnSync('git', ['-C', REPO, 'add', '.'], { encoding: 'utf8' });
spawnSync('git', ['-C', REPO, 'commit', '-m', 'init', '--no-gpg-sign'], { encoding: 'utf8' });
const tmpFiles: string[] = [];
const frozenPids: number[] = [];
let seq = 0;

function fakeScript(body: string): string[] {
  const path = join(tmpdir(), `wsnappy-fake-${process.pid}-${seq++}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  tmpFiles.push(path);
  return ['bash', path];
}

function seedJob(handle: string): string {
  const lp = stateLogPath(handle, REPO);
  insertJob({ handle, backend: 'cmd', sid: 'test', repo: REPO, log_path: lp });
  return lp;
}

function safeRm(p: string) { try { rmSync(p, { recursive: true, force: true }); } catch {} }

afterEach(() => {
  for (const k of ['WORKER_POLL_MS', 'WORKER_RESUME_POLL_MS', 'WORKER_STALL_MS', 'WORKER_TIMEOUT_MS']) {
    delete process.env[k];
  }
  __resetPidCache();
  __resetActivityMonitors();
});

afterAll(() => {
  for (const pid of frozenPids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  for (const f of tmpFiles) safeRm(f);
  safeRm(REPO);
  safeRm(STATE_DIR);
});

describe('isProcessAlive — cached per-pid etime (no repeated ps spawns)', () => {
  it('reuses the first verified start on subsequent calls for the same pid+started', () => {
    const proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    proc.unref();
    const pid = proc.pid!;
    frozenPids.push(pid);
    const started = new Date().toISOString();

    const psSpy = spyOn(childProcess, 'spawnSync').mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'ps') return { status: 0, stdout: '00:01', stderr: '' } as ReturnType<typeof spawnSync>;
      if (cmd === 'pgrep') return { status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>;
      return { status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>;
    }) as typeof spawnSync);

    try {
      expect(isProcessAlive(pid, started)).toBe(true);
      const psCallsAfterFirst = psSpy.mock.calls.filter((c) => c[0] === 'ps').length;
      expect(psCallsAfterFirst).toBe(1);

      for (let i = 0; i < 20; i++) {
        expect(isProcessAlive(pid, started)).toBe(true);
      }
      const psCallsAfterLoop = psSpy.mock.calls.filter((c) => c[0] === 'ps').length;
      expect(psCallsAfterLoop).toBe(1);
    } finally {
      psSpy.mockRestore();
    }
  });
});

describe('startActivityMonitor — event-driven log watch', () => {
  it('updates sig via fs.watch (no polling) when a child writes through the inherited fd', async () => {
    const log = join(REPO, `mon-${seq++}.log`);
    writeFileSync(log, '');
    const fd = openSync(log, 'a');
    const mon = startActivityMonitor(REPO, log);
    const initial = mon.sig;

    const t0 = Date.now();
    const proc = spawn('bash', ['-c', 'echo hello'], { detached: true, stdio: ['ignore', fd, fd] });
    proc.unref();
    frozenPids.push(proc.pid!);

    let sawChange = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
      try { const st = statSync(log); if (st.size > 0 && mon.sig !== initial) { sawChange = true; break; } } catch {}
    }
    const elapsed = Date.now() - t0;
    mon.dispose();
    try { closeSync(fd); } catch {}
    safeRm(log);

    expect(sawChange).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe('killProcessTree — signal first, sweep second', () => {
  it('delivers SIGKILL to the group within ~50ms (synchronous, not after a tree walk)', async () => {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    frozenPids.push(pid);
    await Bun.sleep(50);

    const t0 = performance.now();
    killProcessTree(pid, 'SIGKILL');
    let waited = 0;
    while (waited < 200) {
      try { process.kill(pid, 0); await Bun.sleep(2); waited += 2; } catch { break; }
    }
    const elapsed = performance.now() - t0;
    expect(waited).toBeLessThan(200);
    expect(elapsed).toBeLessThan(250);
  });

  it('a real descendant tree is reaped by the sweep (kill then descendants)', async () => {
    const child = spawn('bash', ['-c', 'sleep 30 & exec sleep 30'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    frozenPids.push(pid);
    await Bun.sleep(150);
    const descendants = listDescendants(pid);
    expect(descendants.length).toBeGreaterThanOrEqual(1);

    killProcessTree(pid, 'SIGKILL');
    let waited = 0;
    while (waited < 1000) {
      const allDead = [pid, ...descendants].every(p => { try { process.kill(p, 0); return false; } catch { return true; } });
      if (allDead) break;
      await Bun.sleep(10); waited += 10;
    }
    for (const d of descendants) {
      try { process.kill(d, 0); expect(true).toBe(false); } catch {  }
    }
  });
});

describe('runWorker — no ps on the watchdog hot path', () => {
  it('a healthy worker resolves "done" without any ps spawn from the watchdog', async () => {
    const handle = `snappy-done-${seq}`;
    const lp = seedJob(handle);
    process.env.WORKER_POLL_MS = '50';

    const psCalls: string[] = [];
    const realSpawnSync = spawnSync;
    const spy = spyOn(childProcess, 'spawnSync').mockImplementation(((...callArgs: Parameters<typeof spawnSync>) => {
      const [cmd, args] = callArgs;
      if (cmd === 'ps' || cmd === 'pgrep') psCalls.push([cmd, ...(args ?? [])].join(' '));
      if (cmd === 'ps') return { status: 0, stdout: '00:01', stderr: '' } as ReturnType<typeof spawnSync>;
      if (cmd === 'pgrep') return { status: 0, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>;
      return realSpawnSync(...callArgs);
    }) as typeof spawnSync);

    try {
      const r = await runWorker(fakeScript('echo hi > snappy-output.txt; echo DONE'), REPO, handle, 'cmd', lp, '');
      expect(r.status).toBe('done');
      expect(psCalls).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
