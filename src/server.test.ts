import { describe, it, expect, afterAll } from 'bun:test';
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Throwaway state store, set BEFORE importing server/state (resolution is lazy).
const STATE_DIR = join(tmpdir(), `wserver-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

// server.ts only boots the stdio transport under `import.meta.main`, so importing it
// here registers the tools as a side effect but does NOT connect/hang the test runner.
import { reply, handleStatus, handleKill, handleWait, handleResume, handleList } from './server.ts';
import { insertJob, updateJob, finalizeJob, getJob, logPath as stateLogPath } from './state.ts';

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
  it('returns job fields + alive, with the backend key stripped', () => {
    const handle = seedJob('running');
    const s = handleStatus({ handle });
    expect(s.handle).toBe(handle);
    expect(s.status).toBe('running');
    expect(s.alive).toBe(false); // worker_pid 0 → not alive
    expect('backend' in s).toBe(false);
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
});

describe('handleWait', () => {
  it('resolves a terminal job to its result with the backend key stripped', async () => {
    const handle = seedJob('running');
    finalizeJob(handle, 'done');
    const r = await handleWait({ handle });
    expect(r.status).toBe('done');
    expect(r.handle).toBe(handle);
    expect('backend' in r).toBe(false);
  });
});

describe('handleResume', () => {
  it('throws when the handle is unknown', () => {
    expect(() => handleResume({ handle: 'ghost', prompt: 'x', dir: REPO })).toThrow(/No job found/);
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
});
