import { describe, it, expect, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';


const STATE_DIR = join(tmpdir(), `wladder-state-${process.pid}`);
process.env.WORKER_STATE_DIR = STATE_DIR;

import { runLadderChain, type LadderDrivers } from '../src/chain.ts';
import { LADDER, type Backend } from '../src/backends.ts';
import { getLadderHistory } from '../src/state.ts';
import type { RunResult } from '../src/runner.ts';

let sidSeq = 0;
const nextSid = () => `chain-test-${process.pid}-${sidSeq++}`;
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function res(status: string, handle = 'h'): RunResult {
  return { status, exit_code: 0, backend: 'cmd' as Backend, handle, resume_token: handle, repo: '/x', log: '' };
}


function scriptedDrivers(opts: {
  rungs: string[];                 
}): LadderDrivers & { runCalls: Backend[] } {
  const runCalls: Backend[] = [];
  let idx = 0;
  return {
    runCalls,
    runRung: async (backend: Backend) => { runCalls.push(backend); return res(opts.rungs[idx++] ?? 'failed', `run-${backend}`); },
  };
}


describe('runLadderChain (auto-climb controller)', () => {
  it('stops on a first-rung done — no climb, single audit turn', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: [] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('done', 'first')), d, deadline);
    expect(final.status).toBe('done');
    expect(final.handle).toBe('first');
    expect(d.runCalls).toEqual([]);       
    expect(getLadderHistory(sid).length).toBe(1);
  });

  it('climbs to the next backend on a hard failure (no retry on failed)', async () => {
    const sid = nextSid();
    
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[1]]);       
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['failed', 'done']);
  });

  it('on timeout: terminal — no retry, no climb (deadline+grace kill is final)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('timeout', 'rung0')), d, deadline);
    expect(final.status).toBe('timeout');
    expect(d.runCalls).toEqual([]);                
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['timeout']);
  });

  it('on stalled: fresh re-runs the SAME backend once, succeeds → no climb', async () => {
    const sid = nextSid();
    
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[0]]);       
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['stalled', 'done']);
  });

  it('on stalled: re-runs same backend once, then climbs when the retry also stalls', async () => {
    const sid = nextSid();
    
    const d = scriptedDrivers({ rungs: ['stalled', 'done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[0], LADDER[1]]); 
    expect(getLadderHistory(sid).map(h => h.result)).toEqual(['stalled', 'stalled', 'done']);
  });

  it('returns "exhausted" when every backend fails, climbing through the whole ladder once', async () => {
    const sid = nextSid();
    
    const d = scriptedDrivers({ rungs: Array(LADDER.length).fill('failed') });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('exhausted');
    expect(d.runCalls).toEqual(LADDER.slice(1));   
    expect(getLadderHistory(sid).length).toBe(LADDER.length);
  });

  it('exhausting on a last-rung stall reports the retry attempt, not the stale pre-retry result', async () => {
    const sid = nextSid();
    
    
    const rungs = [...Array(LADDER.length - 2).fill('failed'), 'stalled', 'stalled'];
    const d = scriptedDrivers({ rungs });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('exhausted');
    expect(final.handle).toBe(`run-${LADDER[LADDER.length - 1]}`); 
  });

  it('stops without climbing when a rung is killed (operator intent honored)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('killed', 'rung0')), d, deadline);
    expect(final.status).toBe('killed');
    expect(d.runCalls).toEqual([]);                
  });

  it('climbs despite a missing ladder/ dir (ensureLadderDir resilience)', async () => {
    const sid = nextSid();
    const d = scriptedDrivers({ rungs: ['done'] });
    const deadline = Date.now() + 600_000;
    rmSync(join(STATE_DIR, 'ladder'), { recursive: true, force: true });
    const final = await runLadderChain(sid, Promise.resolve(res('failed')), d, deadline);
    expect(final.status).toBe('done');
    expect(d.runCalls).toEqual([LADDER[1]]);
  });

  it('KNOWN GAP: no total wall-clock cap — retries + climbs every rung, each with the FULL per-rung timeout', async () => {
    
    
    const sid = nextSid();
    
    const d = scriptedDrivers({ rungs: ['stalled', ...Array(LADDER.length - 1).fill('failed')] });
    const deadline = Date.now() + 600_000;
    const final = await runLadderChain(sid, Promise.resolve(res('stalled', 'rung0')), d, deadline);
    expect(final.status).toBe('exhausted');
    
    expect(d.runCalls).toEqual([LADDER[0], ...LADDER.slice(1)]);
    
    expect(d.runCalls.length).toBe(LADDER.length);
  });
});
